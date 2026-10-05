// Pure judge orchestration: tests, diff and scorer are injected. No cloudflare:workers import.
import { retry } from "../retry";
import type { ForkLook, LookResult } from "./look";
import { fixFingerprint, scoreForks, type ForkInput, type ScoreResult } from "./score";
import type { Scorer, ScorerResult } from "./scorer";
import { buildWhy } from "./why";

export const TEST_ATTEMPTS = 3; // 1 run + 2 retries
export const TEST_RETRY_DELAY_MS = 5_000;
// One test run is cut off after this. Every attempt plus the retry delays must fit in one Workflow step.
export const TEST_TIMEOUT_S = 240;
export const FORK_STEP_TIMEOUT_S = 15 * 60;

// `npm test` under a hard timeout: a hanging suite fails one attempt (no summary) instead of the whole step.
export function testCommand(timeoutS = TEST_TIMEOUT_S): string[] {
  return ["timeout", "--kill-after=10", String(timeoutS), "npm", "test"];
}

// The commit a fork started from: the newest commit in its history that the source repo also has.
// Diffing against the source's current head is wrong once the source moves on after the fork.
export function forkPoint(forkLog: string[], sourceLog: string[]): string | undefined {
  const source = new Set(sourceLog);
  return forkLog.find((hash) => source.has(hash));
}

export interface JudgeFork {
  agent: string;
  fork: string;
  remote: string;
  defaultBranch: string;
  filesClaimed: string[];
  filesShared?: string[]; // claimed files that were ever held only as shared
  endedAt?: string; // when the agent ended (ISO); breaks a tie on points and diff size
}

export interface JudgeInput {
  taskId: string;
  repo: string; // source repo name
  task: string; // the task prompt
  forks: JudgeFork[];
}

export interface TestRun {
  passed: number;
  total: number;
}

export interface ForkDiff {
  diff: string;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
}

export interface JudgeDeps {
  runTests(fork: JudgeFork): Promise<TestRun>;
  getDiff(fork: JudgeFork): Promise<ForkDiff>;
  scorer: Scorer;
  sleep?: (ms: number) => Promise<void>;
}

export interface JudgedFork {
  agent: string;
  fork: string;
  tests: TestRun & { error?: string }; // error set when all attempts failed (then 0/0)
  diff: { filesChanged: string[]; linesAdded: number; linesRemoved: number }; // no diff text
  scorer?: ScorerResult; // undefined when the fork changed no files (taskFit = clarity = 0)
  look?: ForkLook; // only when the race is judged on look
  input: ForkInput;
}

export interface JudgeResult {
  taskId: string;
  forks: JudgedFork[];
  scores: ScoreResult;
  winner: string | null;
  why: string;
  look?: LookResult; // whether the race was judged on look, and each fork's look
}

export function judgeInstanceId(taskId: string): string {
  return `${taskId}-judge`;
}

// Last "<marker> <name> <n>" line in node --test output, TAP (#) or spec (ℹ).
function summaryCount(output: string, name: string): number | undefined {
  const pattern = new RegExp(`^\\s*(?:#|ℹ)\\s*${name}\\s+(\\d+)\\s*$`, "gm");
  const matches = [...output.matchAll(pattern)];
  const last = matches[matches.length - 1];
  return last?.[1] === undefined ? undefined : Number(last[1]);
}

// Parses node --test summary lines (TAP "# tests 7" / "# pass 5" or spec "ℹ tests 7" / "ℹ pass 5").
export function parseTestSummary(output: string): TestRun | undefined {
  const total = summaryCount(output, "tests");
  const passed = summaryCount(output, "pass");
  if (total === undefined || passed === undefined) return undefined;
  return { passed, total };
}

// Parses `git diff --numstat` lines. Binary files ("-") count as 0 lines.
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

// Runs the fork's tests up to TEST_ATTEMPTS times; a run that never succeeds counts as 0/0.
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

// Tests, diff and scorer for one fork. getDiff and scorer errors propagate.
export async function judgeFork(deps: JudgeDeps, input: JudgeInput, fork: JudgeFork): Promise<JudgedFork> {
  const tests = await testFork(deps, fork);
  const { diff, filesChanged, linesAdded, linesRemoved } = await deps.getDiff(fork);
  const scorer =
    filesChanged.length === 0
      ? undefined
      : await deps.scorer.score({ task: input.task, diff, filesChanged, linesAdded, linesRemoved });
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
  return judged;
}

// Gives every fork its look when the race is judged on look; a fork missing from the result gets 0.
export function applyLook(forks: JudgedFork[], look: LookResult): JudgedFork[] {
  if (!look.judged) return forks;
  return forks.map((fork) => {
    const found = look.forks.find((l) => l.agent === fork.agent) ?? { agent: fork.agent, look: 0, error: "not judged" };
    const input: ForkInput = { ...fork.input, look: found.look, ...(found.error === undefined ? {} : { lookError: found.error }) };
    return { ...fork, look: found, input };
  });
}

// Pure: scores, winner and why from the judged forks.
export function decide(input: JudgeInput, forks: JudgedFork[]): JudgeResult {
  const scores = scoreForks(forks.map((f) => f.input));
  return { taskId: input.taskId, forks, scores, winner: scores.winner, why: buildWhy(scores) };
}

// Judges every fork in order, then decides.
export async function judgeTask(deps: JudgeDeps, input: JudgeInput): Promise<JudgeResult> {
  const forks: JudgedFork[] = [];
  for (const fork of input.forks) forks.push(await judgeFork(deps, input, fork));
  return decide(input, forks);
}
