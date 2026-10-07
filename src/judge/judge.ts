// Pure judge orchestration: tests, diff and scorer are injected. No cloudflare:workers import.
import { retry } from "../retry";
import type { ForkLook, LookResult } from "./look";
import { fixFingerprint, scoreForks, type ForkInput, type ScoreResult } from "./score";
import { authorName, type Scorer, type ScorerResult } from "./scorer";
import { SPLIT_YES } from "./testscope";
import { buildWhy } from "./why";

/** Test runs per fork: one run plus two retries, for a flaky container start. */
export const TEST_ATTEMPTS = 3;
/** Wait between test attempts. */
export const TEST_RETRY_DELAY_MS = 5_000;
/** One test run is cut off after this. Every attempt plus the retry delays must fit in one Workflow step. */
export const TEST_TIMEOUT_S = 240;
/**
 * Timeout of one fork's Workflow step: clone, tests with retries, diff, scoring and the shared
 * suite. Cross tests also stop at CROSS_TEST_STEP_MARGIN_S before it (judgeInSandbox).
 */
export const FORK_STEP_TIMEOUT_S = 20 * 60;
/** Time left in the fork step after the last cross test may start: its own timeout plus the step's return. */
export const CROSS_TEST_STEP_MARGIN_S = 60;

/** `npm test` under a hard timeout: a hanging suite fails one attempt (no summary) instead of the whole step. */
export function testCommand(timeoutS = TEST_TIMEOUT_S): string[] {
  return ["timeout", "--kill-after=10", String(timeoutS), "npm", "test"];
}

/**
 * The commit a fork started from: the newest commit in its history that the source repo also has.
 * Diffing against the source's current head is wrong once the source moves on after the fork.
 */
export function forkPoint(forkLog: string[], sourceLog: string[]): string | undefined {
  const source = new Set(sourceLog);
  return forkLog.find((hash) => source.has(hash));
}

/** One agent's fork as the judge sees it: where it lives and what the agent claimed. */
export interface JudgeFork {
  agent: string;
  fork: string;
  remote: string;
  defaultBranch: string;
  filesClaimed: string[];
  filesShared?: string[]; // claimed files that were ever held only as shared
  endedAt?: string; // when the agent ended (ISO); breaks a tie on points and diff size
}

/** The judge Workflow's payload: the task, its source repo and every fork. */
export interface JudgeInput {
  taskId: string;
  repo: string; // source repo name
  task: string; // the task prompt
  forks: JudgeFork[];
}

/** Passing and total tests from one `npm test` run. */
export interface TestRun {
  passed: number;
  total: number;
}

/** A fork's change since its fork point: the unified diff and its size. */
export interface ForkDiff {
  diff: string;
  context?: string; // the same diff with each changed function in full, for Clef (git diff --function-context)
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
}

/**
 * What judging needs from the outside: test and diff runners and the Clef scorer. Injected so the
 * judge runs in plain Node tests.
 */
export interface JudgeDeps {
  runTests(fork: JudgeFork): Promise<TestRun>;
  getDiff(fork: JudgeFork): Promise<ForkDiff>;
  /** Every fork's test files run one by one on this fork (see CrossTest); undefined when the repo's tests cannot be run per file. */
  crossTests?(fork: JudgeFork): Promise<CrossTest[] | undefined>;
  scorer: Scorer;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One test file run on its own on a fork. `author` is "base" for a file the source repo already
 * had, or the agent whose fork added it. Every fork runs every fork's added test files, so the
 * tests part compares forks on one suite instead of each on its own tests.
 */
export interface CrossTest {
  author: string;
  file: string;
  passed: number;
  total: number;
}

/** The author of a test file the source repo already had. */
export const BASE_AUTHOR = "base";

/** Diff characters per fork kept for the side-by-side comparison of near-tied forks. */
export const CONTEXT_CHARS = 20_000;

/**
 * Everything the judge learned about one fork. Holds no diff text, so it fits in a Workflow step
 * output; `context` (a clipped diff) is taken off before the verdict is saved.
 */
export interface JudgedFork {
  agent: string;
  fork: string;
  tests: TestRun & { error?: string }; // error set when all attempts failed (then 0/0)
  crossTests?: CrossTest[]; // every fork's test files run on this fork; missing when they could not be run
  context?: string; // the diff Clef scored, clipped to CONTEXT_CHARS, for the side-by-side comparison
  diff: { filesChanged: string[]; linesAdded: number; linesRemoved: number }; // no diff text
  scorer?: ScorerResult; // undefined when the fork changed no files (taskFit = clarity = 0)
  look?: ForkLook; // only when the race is judged on look
  input: ForkInput;
}

/**
 * The judge's verdict: every fork judged, the scores, the winner (null when no fork is eligible)
 * and the plain-text why.
 */
export interface JudgeResult {
  taskId: string;
  forks: JudgedFork[];
  scores: ScoreResult;
  winner: string | null;
  why: string;
  look?: LookResult; // whether the race was judged on look, and each fork's look
  split?: number; // Clef's yes that the task gives robots different parts, when the shared suite was asked
}

/** The judge Workflow instance id for a task. One judge per task, so a second start finds the first. */
export function judgeInstanceId(taskId: string): string {
  return `${taskId}-judge`;
}

/** Last "<marker> <name> <n>" line in node --test output, TAP (#) or spec (ℹ). */
function summaryCount(output: string, name: string): number | undefined {
  const pattern = new RegExp(`^\\s*(?:#|ℹ)\\s*${name}\\s+(\\d+)\\s*$`, "gm");
  const matches = [...output.matchAll(pattern)];
  const last = matches[matches.length - 1];
  return last?.[1] === undefined ? undefined : Number(last[1]);
}

/** Parses node --test summary lines (TAP "# tests 7" / "# pass 5" or spec "ℹ tests 7" / "ℹ pass 5"). */
export function parseTestSummary(output: string): TestRun | undefined {
  const total = summaryCount(output, "tests");
  const passed = summaryCount(output, "pass");
  if (total === undefined || passed === undefined) return undefined;
  return { passed, total };
}

/** Parses `git diff --numstat` lines. Binary files ("-") count as 0 lines. */
export function parseNumstat(numstat: string): Omit<ForkDiff, "diff"> {
  const result = { filesChanged: [] as string[], linesAdded: 0, linesRemoved: 0 };
  for (const line of numstat.split("\n")) {
    const [added, removed, ...path] = line.split("\t");
    if (added === undefined || removed === undefined || path.length === 0) continue;
    result.filesChanged.push(path.join("\t"));
    result.linesAdded += Number(added) || 0;
    result.linesRemoved += Number(removed) || 0;
  }
  return result;
}

/** Runs the fork's tests up to TEST_ATTEMPTS times; a run that never succeeds counts as 0/0. */
async function testFork(deps: JudgeDeps, fork: JudgeFork): Promise<JudgedFork["tests"]> {
  try {
    const run = await retry(
      () => deps.runTests(fork),
      { attempts: TEST_ATTEMPTS, delayMs: TEST_RETRY_DELAY_MS, shouldRetry: () => true },
      deps.sleep,
    );
    return { passed: run.passed, total: run.total };
  } catch (cause) {
    return { passed: 0, total: 0, error: String(cause) };
  }
}

/** Tests, diff and scorer for one fork. getDiff and scorer errors propagate. */
export async function judgeFork(deps: JudgeDeps, input: JudgeInput, fork: JudgeFork): Promise<JudgedFork> {
  const tests = await testFork(deps, fork);
  const { diff, context, filesChanged, linesAdded, linesRemoved } = await deps.getDiff(fork);
  const scored = context ?? diff;
  const scorer =
    filesChanged.length === 0
      ? undefined
      : await deps.scorer.score({ task: input.task, author: authorName(fork.agent), diff: scored, filesChanged, linesAdded, linesRemoved });
  const cross = filesChanged.length === 0 || deps.crossTests === undefined ? undefined : await deps.crossTests(fork).catch(() => undefined);
  const judged: JudgedFork = {
    agent: fork.agent,
    fork: fork.fork,
    tests,
    diff: { filesChanged: [...filesChanged], linesAdded, linesRemoved },
    input: {
      agent: fork.agent,
      testsPassed: tests.passed,
      testsTotal: tests.total,
      taskFit: scorer?.taskFit ?? 0,
      clarity: scorer?.clarity ?? 0,
      linesChanged: linesAdded + linesRemoved,
      filesChanged: [...filesChanged],
      filesClaimed: [...fork.filesClaimed],
      filesShared: [...(fork.filesShared ?? [])],
      ...(fork.endedAt === undefined ? {} : { endedAt: fork.endedAt }),
      ...(filesChanged.length === 0 ? {} : { fix: fixFingerprint(diff) }),
    },
  };
  if (scorer) judged.scorer = scorer;
  if (cross !== undefined) judged.crossTests = cross;
  if (filesChanged.length > 0) judged.context = scored.length <= CONTEXT_CHARS ? scored : `${scored.slice(0, CONTEXT_CHARS)}\n[diff clipped at ${CONTEXT_CHARS} chars]`;
  return judged;
}

const key = (t: CrossTest): string => `${t.author}\0${t.file}`;
const passedAll = (t: CrossTest): boolean => t.total > 0 && t.passed === t.total;

/**
 * Each fork's result on the shared suite: the source repo's test files, plus each added test file
 * that passes in full on at least two forks. A file that passes only on its author's fork is left
 * out for everyone: it may test that fork's own helpers, or expect behavior the task never asked
 * for. A file's size is the most tests any fork ran from it, so a file that fails to load counts
 * as 0 passed. When the task gives robots different parts (`split`, Clef's yes), only the repo's
 * files count: each robot's added files check its own part. undefined unless every fork that
 * changed files has cross tests.
 */
export function sharedSuite(forks: JudgedFork[], split = 0): Map<string, TestRun> | undefined {
  const runs = forks.filter((f) => f.input.filesChanged.length > 0);
  if (runs.length === 0 || runs.some((f) => f.crossTests === undefined)) return undefined;
  const size = new Map<string, number>();
  const passes = new Map<string, number>();
  const base = new Set<string>();
  for (const fork of runs) {
    for (const t of fork.crossTests ?? []) {
      size.set(key(t), Math.max(size.get(key(t)) ?? 0, t.total));
      if (passedAll(t)) passes.set(key(t), (passes.get(key(t)) ?? 0) + 1);
      if (t.author === BASE_AUTHOR) base.add(key(t));
    }
  }
  const counted = [...size.keys()].filter((k) => (size.get(k) ?? 0) > 0 && (base.has(k) || (split < SPLIT_YES && (passes.get(k) ?? 0) >= 2)));
  if (counted.length === 0) return undefined;
  const suite = new Map<string, TestRun>();
  for (const fork of runs) {
    const mine = new Map((fork.crossTests ?? []).map((t) => [key(t), t]));
    let passed = 0;
    let total = 0;
    for (const k of counted) {
      const n = size.get(k) ?? 0;
      total += n;
      passed += Math.min(n, mine.get(k)?.passed ?? 0);
    }
    suite.set(fork.agent, { passed, total });
  }
  return suite;
}

/** Gives every fork its look when the race is judged on look; a fork missing from the result gets 0. */
export function applyLook(forks: JudgedFork[], look: LookResult): JudgedFork[] {
  if (!look.judged) return forks;
  return forks.map((fork) => {
    const found = look.forks.find((l) => l.agent === fork.agent) ?? { agent: fork.agent, look: 0, error: "not judged" };
    const input: ForkInput = { ...fork.input, look: found.look, ...(found.error === undefined ? {} : { lookError: found.error }) };
    return { ...fork, look: found, input };
  });
}

/**
 * Pure: scores, winner and why from the judged forks. The tests part uses the shared suite when
 * every fork has one, the repo's tests only when `split` says the task splits the work. `prefer` holds the
 * side-by-side comparison's probability per agent, used only to break a tie within the judge's noise.
 */
export function decide(input: JudgeInput, forks: JudgedFork[], prefer?: Record<string, number>, split?: number): JudgeResult {
  const suite = sharedSuite(forks, split);
  const judged = forks.map(({ context: _context, ...fork }) => {
    const shared = suite?.get(fork.agent);
    return shared === undefined ? fork : { ...fork, input: { ...fork.input, shared } };
  });
  const scores = scoreForks(
    judged.map((f) => f.input),
    prefer,
  );
  const used = suite !== undefined && split !== undefined ? { split } : {};
  return { taskId: input.taskId, forks: judged, scores, winner: scores.winner, why: buildWhy(scores), ...used };
}

/** Judges every fork in order, then decides. */
export async function judgeTask(deps: JudgeDeps, input: JudgeInput): Promise<JudgeResult> {
  const forks: JudgedFork[] = [];
  for (const fork of input.forks) forks.push(await judgeFork(deps, input, fork));
  return decide(input, forks);
}
