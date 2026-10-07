// The shared test suite, run on one fork: the source repo's test files and every fork's added test
// files, each run on its own with node --test. No cloudflare:workers import; exec is injected.
import { asTester, BASE_AUTHOR, packageJsonAt, parseTestSummary, testScriptOf, type CrossTest } from "./judge";

/** One test file run is cut off after this. */
export const CROSS_TEST_TIMEOUT_S = 30;
/**
 * All of a fork's cross tests must end within this, well inside the fork step's timeout. Past it the
 * fork stops and reports the files it ran; the shared suite counts only files every fork ran.
 */
export const CROSS_TEST_BUDGET_MS = 4 * 60 * 1_000;
/** Test files run per fork, at most: the base files first, then the added files in turns by author, in the same order on every fork. */
export const CROSS_TEST_MAX_FILES = 40;

/** What running the suite needs: a command runner in the fork's clone. */
export interface CrossDeps {
  exec(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now?: () => number;
  deadline?: number; // ms since the epoch: no file starts if it could run past this (the fork step's end)
}

/** Another fork to take added test files from. */
export interface CrossSource {
  agent: string;
  remote: string;
  branch: string;
}

/** A test file node --test can run on its own: *.test.(ts|js|mjs|cjs|mts|cts). */
export function isNodeTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]s$/.test(path);
}

/** True when the repo's `npm test` is node's runner, so its test files can be run one by one. */
export function usesNodeTest(packageJson: string): boolean {
  return /^node\s+--test\b/.test(testScriptOf(packageJson)?.trim() ?? "");
}

/** Where another fork's added test file goes: next to the original, named for its author, so it never replaces a file. */
export function crossPath(file: string, agent: string): string {
  return file.replace(/\.test\.([cm]?[jt]s)$/, `.from-${agent}.test.$1`);
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

async function out(deps: CrossDeps, argv: string[]): Promise<string> {
  const result = await deps.exec(argv);
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (exit ${result.exitCode})`);
  return result.stdout;
}

/** Runs one test file; no summary (it would not load, or hung) counts as 0 of 0. */
async function runFile(deps: CrossDeps, path: string): Promise<{ passed: number; total: number }> {
  const result = await deps.exec(asTester(["node", "--test", path], CROSS_TEST_TIMEOUT_S));
  return parseTestSummary(`${result.stdout}\n${result.stderr}`) ?? { passed: 0, total: 0 };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The added files in one order on every fork, so the file cap and the time budget cut the same
 * files everywhere: one file per author per turn, authors and files sorted. A robot that adds many
 * slow files gets one turn at a time, so the others' files still run.
 */
export function takeTurns<T extends { author: string; file: string }>(files: T[]): T[] {
  const by = new Map<string, T[]>();
  for (const f of files.toSorted((a, b) => byText(a.file, b.file))) by.set(f.author, [...(by.get(f.author) ?? []), f]);
  const queues = [...by.keys()].toSorted(byText).map((author) => by.get(author) ?? []);
  const order: T[] = [];
  for (let turn = 0; queues.some((q) => q.length > turn); turn++) {
    for (const q of queues) {
      const file = q[turn];
      if (file !== undefined) order.push(file);
    }
  }
  return order;
}

/**
 * Runs the shared suite on the fork checked out in the clone, after its own tests ran: the base
 * commit's test files as the source repo has them, every fork's added test files (its own as it has
 * them, the others' copied in under crossPath). Base files run from the base commit, so a fork that
 * edits or extends the repo's tests is still judged on the same suite as the others. Stops at the
 * budget or the deadline with the files run so far. Each file runs as the tester (asTester), so it
 * cannot change the clone or the tools the next file uses. undefined when the repo does not use node --test.
 */
export async function runCrossTests(deps: CrossDeps, agent: string, base: string, others: CrossSource[]): Promise<CrossTest[] | undefined> {
  const now = deps.now ?? Date.now;
  const deadline = Math.min(now() + CROSS_TEST_BUDGET_MS, deps.deadline ?? Infinity);
  // The base commit's package.json: a robot that changes its test script cannot turn the suite off.
  if (!usesNodeTest(await out(deps, packageJsonAt(base)).catch(() => ""))) return undefined;
  // argv only: file names are agent-written.
  const copy = async (rev: string, file: string, path: string): Promise<boolean> =>
    (await deps.exec(["/bin/sh", "-c", 'mkdir -p "$(dirname "$2")" && git show "$1" > "$2"', "copy", `${rev}:${file}`, path])).exitCode === 0;
  const runs: { author: string; file: string; path: string }[] = [];
  for (const file of lines(await out(deps, ["git", "ls-tree", "-r", "--name-only", base])).filter(isNodeTestFile).toSorted()) {
    const path = crossPath(file, BASE_AUTHOR);
    if (await copy(base, file, path)) runs.push({ author: BASE_AUTHOR, file, path });
  }
  const added = (ref: string): Promise<string[]> =>
    out(deps, ["git", "diff", "--no-renames", "--name-only", "--diff-filter=A", base, ref]).then((t) => lines(t).filter(isNodeTestFile));
  const extra: typeof runs = [];
  for (const file of await added("HEAD")) extra.push({ author: agent, file, path: file });
  for (const other of others) {
    // A fork that cannot be fetched adds no files; the others still run.
    const fetched = await deps.exec(["git", "fetch", "--quiet", "--", other.remote, other.branch]);
    if (fetched.exitCode !== 0) continue;
    const theirs = (await out(deps, ["git", "rev-parse", "FETCH_HEAD"])).trim();
    for (const file of await added(theirs)) {
      const path = crossPath(file, other.agent);
      if (await copy(theirs, file, path)) extra.push({ author: other.agent, file, path });
    }
  }
  const results: CrossTest[] = [];
  for (const run of [...runs, ...takeTurns(extra)].slice(0, CROSS_TEST_MAX_FILES)) {
    if (now() + CROSS_TEST_TIMEOUT_S * 1_000 > deadline) break;
    results.push({ author: run.author, file: run.file, ...(await runFile(deps, run.path)) });
  }
  return results;
}
