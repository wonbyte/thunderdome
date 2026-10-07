// The conflict race: when the winner's fork no longer merges into a newer source, resolvers race
// to fix the merge, each in its own git worktree of one clone. The first resolution whose tests
// all pass ships. Pure: commands run through injected deps, so this runs in plain Node tests.
import { clip, parseEvent, resultOf, type RunResult } from "../agents/events";
import { PLACEHOLDER_API_KEY } from "../agents/runner";
import { packageJsonAt, parseNumstat, parseTestSummary, testCommand, testScriptOf, type TestRun } from "../judge/judge";

/** The robots that race to resolve a merge conflict. */
export const RESOLVERS = ["ponder", "zippy", "testy"] as const;
/** The id of a conflict resolver. */
export type ResolverName = (typeof RESOLVERS)[number];
/** How long each resolver may run. */
export const RESOLVE_TIME_S = 5 * 60;
/** One resolver's test run is cut off after this many seconds. */
export const RESOLVE_TEST_TIMEOUT_S = 180;
/** The source clone the resolvers branch from (ThunderdomeSandbox REPO_DIR). */
export const RESOLVE_REPO_DIR = "/workspace/repo";
/** Each resolver's git worktree lives under this directory. */
export const RESOLVE_DIR = "/workspace/resolve";
/** Where the resolve sandbox writes the bundle of committed attempts. */
export const BUNDLE_PATH = "/workspace/resolve.bundle";
/** Each resolver's Claude Code output goes to a log outside its worktree, so it never gets committed. */
export const RESOLVE_LOG_DIR = "/workspace/resolve-logs";
const LOG_TAIL_LINES = 20;
/** Each attempt that made a merge commit keeps it under this ref, so one bundle carries them all. */
export const RESOLVE_REF_PREFIX = "refs/resolve/";

/** The exit code and output of one command in a sandbox. */
export interface CommandResult { exitCode: number; stdout: string; stderr: string }

/**
 * A merge that conflicted: the race's task, the winner's fork and head, the source head, and the
 * files in conflict.
 */
export interface ConflictRequest {
  taskId: string;
  prompt: string; // the race's task
  winner: string; // the agent whose fork is merged
  winnerRemote: string;
  winnerBranch: string;
  base: string; // the source head the merge goes onto
  theirs: string; // the winner fork's head
  message: string; // the merge commit message (title, blank line, why)
  files: string[]; // the files that conflicted
}

/** What the conflict race needs from the outside. Injected so it runs in plain Node tests. */
export interface RaceDeps {
  /** Runs argv in the resolve sandbox. cwd is absolute. May throw. */
  exec(argv: string[], cwd: string, env?: Record<string, string>): Promise<CommandResult>;
  now(): number;
  model?: string; // empty or missing: Claude Code's default
}

/**
 * "green": committed and every test passed. "red": committed, tests fail. "unresolved": conflict
 * markers or a broken merge were left. "failed": the attempt itself broke.
 */
export type AttemptStatus = "green" | "red" | "unresolved" | "failed";

/** One resolver's attempt: how it ended, when, and its commit and tests. */
export interface ResolveAttempt {
  agent: ResolverName;
  status: AttemptStatus;
  seconds: number; // from the race start to the attempt's end
  commit?: string; // the merge commit, when one was made
  tests?: TestRun;
  lines?: number; // lines changed from the source head, for the tie-break
  costUsd?: number;
  note?: string; // why it is not green, short
}

/** The whole conflict race: every attempt, the one chosen, and a bundle of every committed attempt. */
export interface RaceOutcome {
  attempts: ResolveAttempt[]; // RESOLVERS order
  chosen?: ResolverName;
  bundle?: string; // base64 git bundle with RESOLVE_REF_PREFIX<agent> for every committed attempt
}

const SHIP_ENV = {
  GIT_AUTHOR_NAME: "Thunderdome",
  GIT_AUTHOR_EMAIL: "thunderdome@thunderdome.local",
  GIT_COMMITTER_NAME: "Thunderdome",
  GIT_COMMITTER_EMAIL: "thunderdome@thunderdome.local",
};

const RESOLVER_STYLES: Record<ResolverName, string> = {
  ponder: "You are Ponder, the careful resolver. Read both sides of every conflict and the tests before you edit.",
  zippy: "You are Zippy, the fast resolver. Go straight to the most likely resolution, then run the tests once.",
  testy: "You are Testy, the test-first resolver. Run the tests early, then resolve until they all pass.",
};

/** The system prompt add-on for one resolver: its style and the rules of the race. */
export function resolverPrompt(name: ResolverName, minutes: number): string {
  return [
    RESOLVER_STYLES[name],
    "You race other resolvers on the same merge conflict, each in its own git worktree. The first resolution " +
      "whose tests all pass is shipped.",
    `You have ${minutes} minutes. Work only in the current directory. The sandbox has no internet access, so do not install packages.`,
    "The directory is in the middle of `git merge`. Do not commit, push, abort the merge, or change branches; " +
      "Thunderdome commits your resolution when you finish.",
  ].join("\n\n");
}

/** The task a resolver gets: what the race was for, and which files conflict. */
export function resolverTask(req: ConflictRequest): string {
  return [
    `A race picked ${req.winner}'s change for this task:`,
    req.prompt,
    `The source branch changed while the race ran, so merging ${req.winner}'s change now conflicts in: ${req.files.join(", ")}.`,
    "Resolve every conflict so both the newer source and the winning change are kept. Remove every conflict " +
      "marker, `git add` each resolved file, then run `npm test` and fix whatever the merge broke.",
  ].join("\n\n");
}

/** The Claude Code command line and environment for one resolver. */
export function resolverCommand(name: ResolverName, req: ConflictRequest, model = ""): { argv: string[]; env: Record<string, string> } {
  const models = model === "" ? [] : ["--model", model];
  return {
    argv: [
      "timeout",
      "--kill-after=10",
      String(RESOLVE_TIME_S),
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      ...models,
      "--append-system-prompt",
      resolverPrompt(name, Math.round(RESOLVE_TIME_S / 60)),
      "--",
      resolverTask(req),
    ],
    env: {
      ...SHIP_ENV,
      ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      IS_SANDBOX: "1",
    },
  };
}

/** The resolution commit: the merge message, then a line on how the conflict was resolved. */
export function resolvedMessage(message: string, name: ResolverName, seconds: number, files: string[], tests: TestRun): string {
  const body = message.endsWith("\n") ? message : `${message}\n`;
  const where = files.length === 0 ? "" : ` in ${files.join(", ")}`;
  return `${body}\nThe source changed during the race, so the merge conflicted${where}. ${name} resolved it in ${seconds} s; tests ${tests.passed}/${tests.total}.\n`;
}

/** Green attempts in finish order; a tie goes to the smaller change, then to RESOLVERS order. */
export function pickResolution(attempts: ResolveAttempt[]): ResolverName | undefined {
  const green = attempts.filter((a) => a.status === "green");
  green.sort((a, b) => a.seconds - b.seconds || (a.lines ?? 0) - (b.lines ?? 0) || RESOLVERS.indexOf(a.agent) - RESOLVERS.indexOf(b.agent));
  return green[0]?.agent;
}

/**
 * Sets up one worktree per resolver, runs them all at once, and bundles every committed attempt.
 * Throws only when the shared setup fails; one broken attempt does not stop the others.
 */
export async function raceConflict(deps: RaceDeps, req: ConflictRequest): Promise<RaceOutcome> {
  const repo = RESOLVE_REPO_DIR;
  // A retried step can find the worktrees of an earlier try.
  await must(deps, ["rm", "-rf", RESOLVE_DIR, RESOLVE_LOG_DIR], "/workspace");
  await must(deps, ["mkdir", "-p", RESOLVE_LOG_DIR], "/workspace");
  await must(deps, ["git", "worktree", "prune"], repo);
  // Resolvers commit at the same time into one object store; an automatic gc must not run under them.
  await must(deps, ["git", "config", "gc.auto", "0"], repo);
  await must(deps, ["git", "fetch", "--", req.winnerRemote, req.winnerBranch], repo);
  await must(deps, ["git", "cat-file", "-e", `${req.base}^{commit}`], repo);
  await must(deps, ["git", "cat-file", "-e", `${req.theirs}^{commit}`], repo);
  // Worktrees are added one at a time, so their git setup never races on the shared repo's locks.
  const ready: (Error | undefined)[] = [];
  for (const name of RESOLVERS) ready.push(await prepare(deps, req, name));
  const start = deps.now();
  const attempts = await Promise.all(RESOLVERS.map((name, i) => attempt(deps, req, name, start, ready[i])));
  const chosen = pickResolution(attempts);
  if (chosen === undefined) return { attempts };
  const refs = attempts.filter((a) => a.commit !== undefined).map((a) => `${RESOLVE_REF_PREFIX}${a.agent}`);
  await must(deps, ["git", "bundle", "create", BUNDLE_PATH, ...refs, `^${req.base}`, `^${req.theirs}`], repo);
  const bundle = (await must(deps, ["base64", "-w0", BUNDLE_PATH], repo)).stdout.trim();
  return { attempts, chosen, bundle };
}

/** A worktree at the source head with the winner's merge in progress, or the error that stopped it. */
async function prepare(deps: RaceDeps, req: ConflictRequest, name: ResolverName): Promise<Error | undefined> {
  const dir = `${RESOLVE_DIR}/${name}`;
  try {
    await must(deps, ["git", "worktree", "add", "--detach", dir, req.base], RESOLVE_REPO_DIR);
    // Exit 1 is the expected conflict; anything else means the merge could not start.
    const merge = await deps.exec(["git", "merge", "--no-ff", "--no-commit", req.theirs], dir, SHIP_ENV);
    if (merge.exitCode > 1) throw new Error(`git merge exited with ${merge.exitCode}: ${merge.stderr.slice(-300)}`);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function attempt(deps: RaceDeps, req: ConflictRequest, name: ResolverName, start: number, setup?: Error): Promise<ResolveAttempt> {
  const dir = `${RESOLVE_DIR}/${name}`;
  const seconds = () => Math.round((deps.now() - start) / 1_000);
  const result: ResolveAttempt = { agent: name, status: "failed", seconds: 0 };
  try {
    if (setup !== undefined) throw setup;
    const { argv, env } = resolverCommand(name, req, deps.model);
    const log = `${RESOLVE_LOG_DIR}/${name}.jsonl`;
    // The output can be megabytes; only the last lines, where the result event is, come back.
    await deps.exec(["/bin/sh", "-c", 'log="$1"; shift; "$@" > "$log" 2>&1', "resolve", log, ...argv], dir, env);
    const run = runResultOf((await deps.exec(["tail", "-n", String(LOG_TAIL_LINES), log], dir)).stdout);
    if (run?.costUsd !== undefined) result.costUsd = run.costUsd;
    const problem = await leftover(deps, dir, req);
    if (problem !== undefined) return finish(result, "unresolved", seconds(), problem);
    // Tests run on the staged resolution; whatever they write is left out of the commit.
    // The source head's test script runs, not one the resolver or the winner rewrote.
    const pkg = await deps.exec(packageJsonAt(req.base), dir);
    const script = pkg.exitCode === 0 ? testScriptOf(pkg.stdout) : undefined;
    const tests = script === undefined ? undefined : parseTestSummary(outputOf(await deps.exec(testCommand(script, RESOLVE_TEST_TIMEOUT_S), dir)));
    const took = seconds();
    result.tests = tests ?? { passed: 0, total: 0 };
    const message = resolvedMessage(req.message, name, took, req.files, result.tests);
    await must(deps, ["git", "commit", "--no-verify", "--cleanup=verbatim", "-m", message], dir, SHIP_ENV);
    const commit = (await must(deps, ["git", "rev-parse", "HEAD"], dir)).stdout.trim();
    const parents = (await must(deps, ["git", "rev-parse", "HEAD^1", "HEAD^2"], dir)).stdout.trim().split("\n");
    if (parents[0] !== req.base || parents[1] !== req.theirs) return finish(result, "unresolved", took, "the commit is not a merge of the source and the winner");
    await must(deps, ["git", "update-ref", `${RESOLVE_REF_PREFIX}${name}`, commit], dir);
    result.commit = commit;
    result.lines = linesChanged((await must(deps, ["git", "diff", "--numstat", req.base, commit], dir)).stdout);
    const green = tests !== undefined && tests.total > 0 && tests.passed === tests.total;
    const why = script === undefined ? "the source has no test script" : tests === undefined ? "the tests printed no summary" : "not every test passed";
    return finish(result, green ? "green" : "red", took, green ? undefined : why);
  } catch (err) {
    return finish(result, "failed", seconds(), err instanceof Error ? err.message : String(err));
  }
}

/** What the resolver left undone, or undefined when the merge is ready to commit. */
async function leftover(deps: RaceDeps, dir: string, req: ConflictRequest): Promise<string | undefined> {
  const head = await deps.exec(["git", "rev-parse", "HEAD"], dir);
  if (head.stdout.trim() !== req.base) return "HEAD moved: the resolver committed or switched branches";
  const merging = await deps.exec(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], dir);
  if (merging.stdout.trim() !== req.theirs) return "the merge was aborted";
  // Staging marks every conflicted file resolved, so the markers are what show an unfinished file.
  await must(deps, ["git", "add", "--all"], dir);
  // git grep exits 0 when it finds a line, 1 when it finds none, and more when it fails.
  const markers = await deps.exec(["git", "grep", "--cached", "-l", "-E", "^(<<<<<<<|>>>>>>>)( |$)", "--", ...req.files], dir);
  if (markers.exitCode === 0) return `conflict markers left in: ${markers.stdout.trim().split("\n").join(", ")}`;
  if (markers.exitCode > 1) return `checking for conflict markers failed: ${markers.stderr.trim()}`;
  return undefined;
}

function finish(result: ResolveAttempt, status: AttemptStatus, seconds: number, note?: string): ResolveAttempt {
  result.status = status;
  result.seconds = seconds;
  if (note !== undefined) result.note = clip(note, 300);
  return result;
}

function runResultOf(stdout: string): RunResult | undefined {
  let found: RunResult | undefined;
  for (const line of stdout.split("\n")) found = resultOf(parseEvent(line)) ?? found;
  return found;
}

function linesChanged(numstat: string): number {
  const { linesAdded, linesRemoved } = parseNumstat(numstat);
  return linesAdded + linesRemoved;
}

function outputOf(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function must(deps: RaceDeps, argv: string[], cwd: string, env?: Record<string, string>): Promise<CommandResult> {
  const result = await deps.exec(argv, cwd, env);
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} exited with ${result.exitCode}: ${result.stderr.slice(-300)}`);
  return result;
}
