// Thin Workflow around judge.ts and ship.ts: one step per fork and a look step, all at once, then decide, ship, then save the verdict.
import { launch, type Browser } from "@cloudflare/puppeteer";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { revokeWriteTokens } from "../artifacts/repo";
import { retry } from "../retry";
import type { VerdictScore } from "../room/task";
import { CommandError, REPO_DIR } from "../sandbox/ThunderdomeSandbox";
import type { OutboundProps } from "../sandbox/outbound";
import { gitRepoPath } from "../sandbox/policy";
import { BUNDLE_PATH, raceConflict, type ConflictRequest, type RaceOutcome } from "../ship/resolve";
import { shipTask, type ShipDeps, type ShipFork, type ShipInput, type ShipRepo, type ShipResolver, type ShipResult } from "../ship/ship";
import { clipDiff } from "./diffs";
import { FUSE_BUNDLE_MAX, FUSE_BUNDLE_PATH, FUSE_REF, fusionBundle, fusionCandidates, fusionProblem, fusionWhy, runFusion, type FusionResult } from "./fusion";
import { judgeLook, readyPreviews, VISUAL_THRESHOLD, visualTask, type LookResult, type Viewport } from "./look";
import {
  applyLook,
  decide,
  FORK_STEP_TIMEOUT_S,
  forkPoint,
  judgeFork,
  parseNumstat,
  parseTestSummary,
  type JudgeDeps,
  type JudgedFork,
  type JudgeFork,
  type JudgeInput,
  type JudgeResult,
  testCommand,
} from "./judge";
import type { ForkScore } from "./score";
import { clefScorer } from "./scorer";
import { decidedBy, headline, lesson } from "./why";

const FORK_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: `${FORK_STEP_TIMEOUT_S} seconds`,
} as const;
// Long enough for a conflict race: clones, resolvers (RESOLVE_TIME_S), their tests, then the push.
const SHIP_STEP = {
  retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
  timeout: "20 minutes",
} as const;
// Tests and one Clef question per losing fork with new files. No retries: see the fuse step.
const FUSE_STEP = {
  retries: { limit: 0, delay: "10 seconds", backoff: "constant" },
  timeout: "10 minutes",
} as const;
// No new candidate starts after this; with one test run (FUSE_TEST_TIMEOUT_S) and the push after
// it, the round ends well inside FUSE_STEP's timeout.
const FUSE_BUDGET_MS = 5 * 60 * 1_000;
// A push may not start later than this after the budget.
const FUSE_PUSH_MS = 2 * 60 * 1_000;
// Screenshots and Clef questions for every fork, after waiting for the final previews.
const LOOK_STEP = {
  retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
  timeout: "10 minutes",
} as const;
// A fork's final preview builds after its last push; the judge waits this long for it.
const PREVIEW_WAIT_MS = 3 * 60 * 1_000;
// The whole look, preview wait included, must end well inside LOOK_STEP's timeout.
const LOOK_BUDGET_MS = 8 * 60 * 1_000;
const PREVIEW_POLL_MS = 5_000;
const PAGE_TIMEOUT_MS = 30_000;
// Base64 written per exec call, under the kernel's limit for one argument.
const BUNDLE_CHUNK = 64 * 1_024;
const TOKEN_TTL_S = 3_600;
const LOG_LIMIT = 200; // commits read from each repo to find a fork's starting point
// The merge commit names Thunderdome, not an agent.
const SHIP_IDENTITY = {
  GIT_AUTHOR_NAME: "Thunderdome",
  GIT_AUTHOR_EMAIL: "thunderdome@thunderdome.local",
  GIT_COMMITTER_NAME: "Thunderdome",
  GIT_COMMITTER_EMAIL: "thunderdome@thunderdome.local",
};

type Sandbox = ReturnType<Env["SANDBOX"]["getByName"]>;

export type JudgeOutput = JudgeResult & { ship: ShipResult };

export class JudgeWorkflow extends WorkflowEntrypoint<Env, JudgeInput> {
  override async run(event: WorkflowEvent<JudgeInput>, step: WorkflowStep): Promise<JudgeOutput> {
    const input = event.payload;
    // Every fork is judged in its own sandbox, and the look needs only the previews, so all of
    // these steps run at once: the judge takes as long as its slowest step, not their sum.
    // JSON text: the scorer's raw legend is typed unknown, which step.do's Serializable type rejects.
    const judging = input.forks.map((fork) =>
      step.do(`fork ${fork.agent}`, FORK_STEP, async () => JSON.stringify(await judgeInSandbox(this.env, input, fork))),
    );
    // JSON text: LookResult has optional keys. A failed look never stops the judge: lookAtPreviews
    // does not throw, and a step that still fails (a timeout) is judged without look.
    const looking = step.do("look", LOOK_STEP, async () => JSON.stringify(await lookAtPreviews(this.env, input))).catch((cause: unknown) => {
      const failed: LookResult = { visual: 0, judged: false, forks: [], error: `the look step failed: ${String(cause).slice(0, 300)}` };
      return JSON.stringify(failed);
    });
    const [looked, ...judged] = await Promise.all([looking, ...judging]);
    const forks = judged.map((text) => JSON.parse(text) as JudgedFork);
    const look = JSON.parse(looked) as LookResult;
    const decided = { ...decide(input, applyLook(forks, look)), look };
    // The fusion round tries the losers' other files on top of the winner and pushes what it keeps
    // to the winner's fork, so the ship merges it. Not retried: a retry after the push would find
    // nothing new. A failed round is only noted; the winner ships as judged.
    let fusedText: string;
    try {
      fusedText = await step.do("fuse", FUSE_STEP, async () => JSON.stringify(await fuseInSandbox(this.env, input, decided)));
    } catch (cause) {
      fusedText = JSON.stringify({ tried: [], error: `the fusion step failed: ${String(cause).slice(0, 300)}` } satisfies FusionResult);
    }
    const fusion = JSON.parse(fusedText) as FusionResult;
    const result = { ...decided, why: `${decided.why}${fusionWhy(fusion)}`, fusion };
    // JSON text, like the fork steps: ShipResult has optional keys.
    const shipped = await step.do("ship", SHIP_STEP, async () => JSON.stringify(await shipInSandbox(this.env, input, result)));
    const ship = JSON.parse(shipped) as ShipResult;
    await step.do("save verdict", async () => {
      const by = decidedBy(result.scores);
      const line = headline(result.scores);
      const point = lesson(result.scores);
      const saved = await this.env.TASK_ROOM.getByName(input.taskId).saveVerdict({
        winner: result.winner,
        why: result.why,
        judgedAt: new Date().toISOString(),
        ship,
        scores: verdictScores(result.scores.ranked),
        ...(by === undefined ? {} : { decidedBy: by }),
        ...(line === undefined ? {} : { headline: line }),
        ...(point === undefined ? {} : { lesson: point }),
        ...(fusion.tried.length === 0 && fusion.error === undefined ? {} : { fusion }),
      });
      // 409: a retried step already saved it.
      if (!saved.ok && saved.status !== 409) throw new Error(`Saving the verdict failed (${saved.status}): ${saved.error}`);
      return saved.ok;
    });
    return { ...result, ship };
  }
}

// The verdict's scores: one per fork, in ranked order.
function verdictScores(ranked: ForkScore[]): VerdictScore[] {
  return ranked.map(({ agent, total, eligible, parts }) => ({
    agent,
    total,
    eligible,
    parts: {
      tests: parts.tests,
      taskFit: parts.taskFit,
      clarity: parts.clarity,
      ...(parts.look === undefined ? {} : { look: parts.look }),
      claim: parts.claim,
    },
  }));
}

async function commitHashes(artifacts: Artifacts, name: string): Promise<string[]> {
  using repo = await artifacts.get(name);
  return (await repo.log({ limit: LOG_LIMIT })).map((c) => c.hash);
}

// Waits for each fork's final preview, then judges the look. Never throws: a failure means the
// race is judged without look, and the error is kept in the result.
async function lookAtPreviews(env: Env, input: JudgeInput): Promise<LookResult> {
  // A promise, so forks shot at once share one browser.
  let browser: Promise<Browser> | undefined;
  try {
    const budget = Date.now() + LOOK_BUDGET_MS;
    // The browser starts on the first screenshot, so a race that is not visual never opens one.
    const shoot = async (url: string, viewport: Viewport): Promise<string> => {
      browser ??= launch(env.BROWSER);
      return screenshot(await browser, url, viewport);
    };
    const deps = { ai: env.AI, shoot, now: () => Date.now(), deadline: budget };
    // Asked first: it needs only the task, so a race that is not visual never waits for previews.
    const visual = await visualTask(deps, input.task);
    if (visual < VISUAL_THRESHOLD) return { visual, judged: false, forks: [] };
    const room = env.TASK_ROOM.getByName(input.taskId);
    const waitUntil = Date.now() + PREVIEW_WAIT_MS;
    let task = await room.state();
    while (task !== null && readyPreviews(task).waiting.length > 0 && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS));
      task = await room.state();
    }
    if (task === null) throw new Error(`Task ${input.taskId} not found`);
    const { before, forks } = readyPreviews(task);
    return await judgeLook(deps, { task: input.task, ...(before === undefined ? {} : { before }), forks, visual });
  } catch (cause) {
    return { visual: 0, judged: false, forks: [], error: String(cause).slice(0, 300) };
  } finally {
    await browser?.then((b) => b.close()).catch((cause: unknown) => console.error({ event: "look.close_failed", error: String(cause) }));
  }
}

// A JPEG of the whole page, base64. A page that does not answer 2xx is an error, not a screenshot.
async function screenshot(browser: Browser, url: string, viewport: Viewport): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.setViewport(viewport);
    const response = await page.goto(url, { waitUntil: "networkidle0", timeout: PAGE_TIMEOUT_MS });
    if (response === null || !response.ok()) throw new Error(`${url} answered ${response?.status() ?? "nothing"}`);
    const shot = await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, encoding: "base64" });
    return typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
  } finally {
    await page.close();
  }
}

// The commit the fork started from, so its diff holds only the agent's changes.
async function forkBase(artifacts: Artifacts, source: string, fork: string): Promise<string> {
  const [forkLog, sourceLog] = await Promise.all([commitHashes(artifacts, fork), commitHashes(artifacts, source)]);
  const base = forkPoint(forkLog, sourceLog);
  if (base === undefined) throw new Error(`${fork} shares none of the last ${LOG_LIMIT} commits of ${source}`);
  return base;
}

// A short-lived read token for the fork.
async function readToken(artifacts: Artifacts, name: string): Promise<string> {
  using repo = await artifacts.get(name);
  return (await repo.createToken("read", TOKEN_TTL_S)).plaintext;
}

// Clones the fork into its own judge sandbox, judges it, and stops the sandbox.
async function judgeInSandbox(env: Env, input: JudgeInput, fork: JudgeFork): Promise<JudgedFork> {
  const base = await forkBase(env.ARTIFACTS, input.repo, fork.fork);
  const sandbox = env.SANDBOX.getByName(`judge-${fork.fork}`);
  try {
    const props: OutboundProps = { gitHost: new URL(fork.remote).hostname, gitToken: await readToken(env.ARTIFACTS, fork.fork) };
    // A fresh fork can refuse a clone for a short time.
    await retry(() => sandbox.clone(props, fork.remote), { attempts: 10, delayMs: 2_000, shouldRetry: () => true });
    return await judgeFork(sandboxDeps(env, sandbox, base, input.taskId), input, fork);
  } finally {
    await sandbox.stop();
  }
}

// Merges the winner into the source repo and locks every fork. shipTask never throws, so a
// failed source lookup or clone becomes status "error" and the forks are still locked.
async function shipInSandbox(env: Env, input: JudgeInput, result: JudgeResult): Promise<ShipResult> {
  const deps = (git: ShipDeps["git"], resolver?: ShipResolver): ShipDeps => ({
    git,
    revokeWriteTokens: (name) => revokeWriteTokens(env.ARTIFACTS, name),
    ...(resolver === undefined ? {} : { resolver }),
  });
  let found: { repo: ArtifactsRepo; info: ShipRepo };
  try {
    found = await sourceRepo(env.ARTIFACTS, input.repo);
  } catch (cause) {
    const error = new Error(`Looking up source repo ${input.repo} failed: ${String(cause)}`);
    return shipTask(deps(() => Promise.reject(error)), shipInput(input, result, { name: input.repo, remote: "", defaultBranch: "" }));
  }
  using source = found.repo;
  const ship = shipInput(input, result, found.info);
  const git = shipGit(env, source, ship);
  const resolver: ShipResolver = { race: (req) => raceInSandbox(env, source, ship, req), importBundle: (bundle) => git.importBundle(bundle) };
  try {
    return await shipTask(deps(git.run, resolver), ship);
  } finally {
    await git.close();
  }
}

// The fusion round in two sandboxes, like the conflict race. The fuse sandbox runs the losers'
// agent-written tests, so it holds read tokens only; the kept commits leave it as a bundle. A
// second sandbox holds the winner fork's write token, runs only git, checks the bundle
// (fusionProblem) and pushes it. Time-boxed so nothing is pushed after the step gives up.
async function fuseInSandbox(env: Env, input: JudgeInput, result: JudgeResult): Promise<FusionResult> {
  const winner = input.forks.find((f) => f.agent === result.winner);
  const judged = result.forks.find((f) => f.agent === result.winner);
  if (winner === undefined || judged === undefined) return { tried: [] };
  const remotes = Object.fromEntries(input.forks.map((f) => [f.agent, { remote: f.remote, branch: f.defaultBranch }]));
  const candidates = fusionCandidates(result.scores.ranked, result.forks, winner.agent, remotes);
  if (candidates.length === 0) return { tried: [] };
  const deadline = Date.now() + FUSE_BUDGET_MS;
  const winnerRead = await readToken(env.ARTIFACTS, winner.fork);
  const repoTokens: Record<string, string> = { [repoPath(winner.remote)]: winnerRead };
  for (const c of candidates) {
    const loser = input.forks.find((f) => f.agent === c.agent);
    if (loser !== undefined) repoTokens[repoPath(loser.remote)] = await readToken(env.ARTIFACTS, loser.fork);
  }
  const box = env.SANDBOX.getByName(`fuse-${input.taskId}`);
  let fused: FusionResult;
  let bundle: string | undefined;
  try {
    const props: OutboundProps = { gitHost: new URL(winner.remote).hostname, gitToken: winnerRead, repoTokens };
    await retry(() => box.clone(props, winner.remote), { attempts: 10, delayMs: 2_000, shouldRetry: () => true });
    const deps = { exec: (argv: string[], cwd: string, e?: Record<string, string>) => box.exec(argv, cwd, e), ai: env.AI, now: () => Date.now(), deadline };
    fused = await runFusion(deps, { task: input.task, winner: winner.agent, testsPassed: judged.tests.passed, candidates });
    if (fused.commit !== undefined && fused.base !== undefined) bundle = await fusionBundle(deps, fused.base, fused.commit);
  } finally {
    await box.stop().catch((cause: unknown) => console.error({ event: "fuse.stop_failed", error: String(cause) }));
  }
  if (bundle === undefined) return fused;
  const problem = bundle.length > FUSE_BUNDLE_MAX ? "the fusion bundle is too big to push" : Date.now() > deadline + FUSE_PUSH_MS ? "the fusion round ran out of time" : await pushFusion(env, winner, winnerRead, fused, bundle);
  if (problem === undefined) return fused;
  // Nothing reached the fork, so nothing was added after all.
  const { commit: _commit, ...rest } = fused;
  return { ...rest, tried: fused.tried.map((t) => (t.status === "added" ? { ...t, status: "failed" as const, note: problem } : t)), error: problem };
}

// Pushes a checked fusion bundle to the winner's fork. Runs no agent code. Returns why it did not push.
async function pushFusion(env: Env, winner: JudgeFork, winnerRead: string, fused: FusionResult, bundle: string): Promise<string | undefined> {
  using fork = await env.ARTIFACTS.get(winner.fork);
  const write = await fork.createToken("write", TOKEN_TTL_S);
  const box = env.SANDBOX.getByName(`fuse-push-${winner.fork}`);
  try {
    // The write token goes only to the winner's fork; anything else on the host gets the read token.
    const props: OutboundProps = { gitHost: new URL(winner.remote).hostname, gitToken: winnerRead, repoTokens: { [repoPath(winner.remote)]: write.plaintext } };
    await retry(() => box.clone(props, winner.remote), { attempts: 10, delayMs: 2_000, shouldRetry: () => true });
    await writeBundle(box, bundle, FUSE_BUNDLE_PATH);
    const fetched = await box.exec(["git", "fetch", "--quiet", FUSE_BUNDLE_PATH, `+${FUSE_REF}:${FUSE_REF}`]);
    if (fetched.exitCode !== 0) return `the fusion bundle did not load: ${fetched.stderr.slice(-200)}`;
    const deps = { exec: (argv: string[], cwd: string, e?: Record<string, string>) => box.exec(argv, cwd, e) };
    const problem = await fusionProblem(deps, fused);
    if (problem !== undefined) return problem;
    const pushed = await box.exec(["git", "push", "--quiet", "origin", `${FUSE_REF}:refs/heads/${winner.defaultBranch}`]);
    return pushed.exitCode === 0 ? undefined : `pushing the fusion failed: ${pushed.stderr.slice(-300)}`;
  } finally {
    await box.stop().catch((cause: unknown) => console.error({ event: "fuse.push_stop_failed", error: String(cause) }));
    await fork.revokeToken(write.id).catch((cause: unknown) => console.error({ event: "fuse.revoke_failed", error: String(cause) }));
  }
}

// Writes a base64 bundle into a sandbox in chunks (one exec argument has a size limit), then decodes it.
async function writeBundle(box: Sandbox, bundle: string, path: string): Promise<void> {
  const b64 = `${path}.b64`;
  await mustIn(box, ["rm", "-f", b64, path]);
  for (let i = 0; i < bundle.length; i += BUNDLE_CHUNK) {
    await mustIn(box, ["/bin/sh", "-c", 'printf %s "$1" >> "$2"', "chunk", bundle.slice(i, i + BUNDLE_CHUNK), b64]);
  }
  await mustIn(box, ["/bin/sh", "-c", 'base64 -d "$1" > "$2"', "decode", b64, path]);
}

// The conflict race runs in its own sandbox with read tokens and the model API. The source write
// token stays in the ship sandbox, so no resolver can push; the result comes back as a bundle.
async function raceInSandbox(env: Env, source: ArtifactsRepo, ship: ShipInput, req: ConflictRequest): Promise<RaceOutcome> {
  const winner = ship.forks.find((f) => f.agent === req.winner);
  if (winner === undefined) throw new Error(`No fork for winner ${req.winner}`);
  const sourceRead = (await source.createToken("read", TOKEN_TTL_S)).plaintext;
  const winnerRead = await readToken(env.ARTIFACTS, winner.name);
  const props: OutboundProps = {
    gitHost: new URL(ship.source.remote).hostname,
    gitToken: sourceRead,
    repoTokens: { [repoPath(ship.source.remote)]: sourceRead, [repoPath(winner.remote)]: winnerRead },
    modelApi: true,
  };
  const box = env.SANDBOX.getByName(`resolve-${ship.taskId}`);
  try {
    await retry(() => box.clone(props, ship.source.remote), { attempts: 10, delayMs: 2_000, shouldRetry: () => true });
    const deps = { exec: (argv: string[], cwd: string, e?: Record<string, string>) => box.exec(argv, cwd, e), now: () => Date.now(), model: env.AGENT_MODEL ?? "" };
    return await raceConflict(deps, req);
  } finally {
    await box.stop().catch((cause: unknown) => console.error({ event: "resolve.stop_failed", error: String(cause) }));
  }
}

// The source repo handle and where it lives. The handle is disposed when info fails.
async function sourceRepo(artifacts: Artifacts, name: string): Promise<{ repo: ArtifactsRepo; info: ShipRepo }> {
  const repo = await artifacts.get(name);
  try {
    const info = await repo.info();
    return { repo, info: { name, remote: info.remote, defaultBranch: info.defaultBranch } };
  } catch (cause) {
    repo[Symbol.dispose]();
    throw cause;
  }
}

function shipInput(input: JudgeInput, result: JudgeResult, source: ShipRepo): ShipInput {
  return {
    taskId: input.taskId,
    prompt: input.task,
    source,
    forks: input.forks.map((f) => ({ agent: f.agent, name: f.fork, remote: f.remote, defaultBranch: f.defaultBranch })),
    winner: result.winner,
    why: result.why,
  };
}

// Git in a clone of the source, made on the first call. With no winner nothing is made.
function shipGit(
  env: Env,
  source: ArtifactsRepo,
  ship: ShipInput,
): { run: ShipDeps["git"]; importBundle(bundle: string): Promise<string>; close(): Promise<void> } {
  let sandbox: Sandbox | undefined;
  let writeTokenId: string | undefined;
  let opened: Promise<Sandbox> | undefined;

  async function open(): Promise<Sandbox> {
    const winner = ship.forks.find((f) => f.agent === ship.winner);
    if (winner === undefined) throw new Error(`No fork for winner ${ship.winner ?? "(none)"}`);
    const write = await source.createToken("write", TOKEN_TTL_S);
    writeTokenId = write.id;
    const read = await readToken(env.ARTIFACTS, winner.name);
    const props = shipProps(ship.source.remote, write.plaintext, winner, read);
    const box = env.SANDBOX.getByName(`ship-${ship.taskId}`);
    sandbox = box;
    // A source repo can refuse a clone for a short time.
    await retry(() => box.clone(props, ship.source.remote), { attempts: 10, delayMs: 2_000, shouldRetry: () => true });
    return box;
  }

  return {
    async run(args) {
      opened ??= open();
      const box = await opened;
      return box.exec(["git", ...args], REPO_DIR, SHIP_IDENTITY);
    },
    // Writes the base64 bundle in chunks, then decodes it next to the clone.
    async importBundle(bundle) {
      opened ??= open();
      const box = await opened;
      await writeBundle(box, bundle, BUNDLE_PATH);
      return BUNDLE_PATH;
    },
    // Best effort: a failed stop or revoke must not lose the ship result.
    async close() {
      if (sandbox !== undefined) {
        await sandbox.stop().catch((cause: unknown) => console.error({ event: "ship.stop_failed", error: String(cause) }));
      }
      if (writeTokenId !== undefined) {
        await source.revokeToken(writeTokenId).catch((cause: unknown) => console.error({ event: "ship.revoke_failed", error: String(cause) }));
      }
    },
  };
}

// The write token goes only to the source repo, the read token to the winner fork; the read token is the fallback.
function shipProps(sourceRemote: string, writeToken: string, winner: ShipFork, winnerRead: string): OutboundProps {
  return {
    gitHost: new URL(sourceRemote).hostname,
    gitToken: winnerRead,
    repoTokens: { [repoPath(sourceRemote)]: writeToken, [repoPath(winner.remote)]: winnerRead },
  };
}

function repoPath(remote: string): string {
  const path = gitRepoPath(new URL(remote));
  if (path === undefined) throw new Error(`Not a git repo URL: ${remote}`);
  return path;
}

function sandboxDeps(env: Env, sandbox: Sandbox, base: string, taskId: string): JudgeDeps {
  return {
    // A failing suite still prints a summary; no summary means the run itself broke.
    async runTests() {
      const result = await sandbox.exec(testCommand());
      const summary = parseTestSummary(`${result.stdout}\n${result.stderr}`);
      if (summary === undefined) throw new Error(`npm test printed no test summary (exit ${result.exitCode})`);
      return summary;
    },
    // Saves the clipped diff for the diff route, then returns the whole diff as before.
    async getDiff(fork) {
      const numstat = await must(sandbox, ["git", "diff", "--no-renames", "--numstat", base, "HEAD"]);
      const diff = await must(sandbox, ["git", "diff", "--no-renames", base, "HEAD"]);
      await saveForkDiff(env, taskId, fork.agent, diff);
      return { diff, ...parseNumstat(numstat) };
    },
    scorer: clefScorer(env.AI),
  };
}

// Best effort: a failed save is only logged, so the judge goes on. Never throws.
async function saveForkDiff(env: Env, taskId: string, agent: string, diff: string): Promise<void> {
  try {
    await env.TASK_ROOM.getByName(taskId).saveDiff(agent, clipDiff(diff));
  } catch (cause) {
    console.error({ event: "judge.diff_save_failed", taskId, agent, error: String(cause) });
  }
}

async function mustIn(sandbox: Sandbox, argv: string[]): Promise<void> {
  const result = await sandbox.exec(argv, "/workspace");
  if (result.exitCode !== 0) throw new CommandError(argv, result);
}

async function must(sandbox: Sandbox, argv: string[]): Promise<string> {
  const result = await sandbox.exec(argv);
  if (result.exitCode !== 0) throw new CommandError(argv, result);
  return result.stdout;
}
