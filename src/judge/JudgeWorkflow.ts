// Thin Workflow around judge.ts and ship.ts: one step per fork, decide, ship, then save the verdict.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { revokeWriteTokens } from "../artifacts/repo";
import { retry } from "../retry";
import type { VerdictScore } from "../room/task";
import { CommandError, REPO_DIR } from "../sandbox/ThunderdomeSandbox";
import type { OutboundProps } from "../sandbox/outbound";
import { gitRepoPath } from "../sandbox/policy";
import { shipTask, type ShipDeps, type ShipFork, type ShipInput, type ShipRepo, type ShipResult } from "../ship/ship";
import { clipDiff } from "./diffs";
import {
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
import { decidedBy } from "./why";

const FORK_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: `${FORK_STEP_TIMEOUT_S} seconds`,
} as const;
const SHIP_STEP = {
  retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
  timeout: "10 minutes",
} as const;
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
  async run(event: WorkflowEvent<JudgeInput>, step: WorkflowStep): Promise<JudgeOutput> {
    const input = event.payload;
    const forks: JudgedFork[] = [];
    for (const fork of input.forks) {
      // JSON text: the scorer's raw legend is typed unknown, which step.do's Serializable type rejects.
      const judged = await step.do(`fork ${fork.agent}`, FORK_STEP, async () =>
        JSON.stringify(await judgeInSandbox(this.env, input, fork)),
      );
      forks.push(JSON.parse(judged) as JudgedFork);
    }
    const result = decide(input, forks);
    // JSON text, like the fork steps: ShipResult has optional keys.
    const shipped = await step.do("ship", SHIP_STEP, async () => JSON.stringify(await shipInSandbox(this.env, input, result)));
    const ship = JSON.parse(shipped) as ShipResult;
    await step.do("save verdict", async () => {
      const decided = decidedBy(result.scores);
      const saved = await this.env.TASK_ROOM.getByName(input.taskId).saveVerdict({
        winner: result.winner,
        why: result.why,
        judgedAt: new Date().toISOString(),
        ship,
        scores: verdictScores(result.scores.ranked),
        ...(decided === undefined ? {} : { decidedBy: decided }),
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
    parts: { tests: parts.tests, taskFit: parts.taskFit, clarity: parts.clarity, claim: parts.claim },
  }));
}

async function commitHashes(artifacts: Artifacts, name: string): Promise<string[]> {
  using repo = await artifacts.get(name);
  return (await repo.log({ limit: LOG_LIMIT })).map((c) => c.hash);
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
  const deps = (git: ShipDeps["git"]): ShipDeps => ({ git, revokeWriteTokens: (name) => revokeWriteTokens(env.ARTIFACTS, name) });
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
  try {
    return await shipTask(deps(git.run), ship);
  } finally {
    await git.close();
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
function shipGit(env: Env, source: ArtifactsRepo, ship: ShipInput): { run: ShipDeps["git"]; close(): Promise<void> } {
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
function shipProps(sourceRemote: string, writeToken: string, winner: ShipFork, readToken: string): OutboundProps {
  return {
    gitHost: new URL(sourceRemote).hostname,
    gitToken: readToken,
    repoTokens: { [repoPath(sourceRemote)]: writeToken, [repoPath(winner.remote)]: readToken },
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

async function must(sandbox: Sandbox, argv: string[]): Promise<string> {
  const result = await sandbox.exec(argv);
  if (result.exitCode !== 0) throw new CommandError(argv, result);
  return result.stdout;
}
