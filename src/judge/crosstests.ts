// The shared test suite, run on one fork: the source repo's test files and every fork's added test
// files, each run on its own with node --test. No cloudflare:workers import; exec is injected.
import { BASE_AUTHOR, parseTestSummary, type CrossTest } from "./judge";

/** One test file run is cut off after this. */
export const CROSS_TEST_TIMEOUT_S = 30;
/**
 * All of a fork's cross tests must end within this, well inside the fork step's timeout. Past it the
 * fork reports none, which turns the shared suite off for every fork: partial results would not compare.
 */
export const CROSS_TEST_BUDGET_MS = 4 * 60 * 1_000;
/** Test files run per fork, at most: the base files first, then the added files by author, in the same order on every fork. */
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
  try {
    const pkg: unknown = JSON.parse(packageJson);
    const test = typeof pkg === "object" && pkg !== null ? (pkg as { scripts?: { test?: unknown } }).scripts?.test : undefined;
    return typeof test === "string" && /^node\s+--test\b/.test(test.trim());
  } catch {
    return false;
  }
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
  const result = await deps.exec(["timeout", "--kill-after=5", String(CROSS_TEST_TIMEOUT_S), "node", "--test", path]);
  return parseTestSummary(`${result.stdout}\n${result.stderr}`) ?? { passed: 0, total: 0 };
}

/**
 * Runs the shared suite on the fork checked out in the clone, after its own tests ran: the base
 * commit's test files as the source repo has them, every fork's added test files (its own as it has
 * them, the others' copied in under crossPath). Base files run from the base commit, so a fork that
 * edits or extends the repo's tests is still judged on the same suite as the others. undefined when
 * the repo does not use node --test, or when the files do not fit in the time left.
 */
export async function runCrossTests(deps: CrossDeps, agent: string, base: string, others: CrossSource[]): Promise<CrossTest[] | undefined> {
  const now = deps.now ?? Date.now;
  const deadline = Math.min(now() + CROSS_TEST_BUDGET_MS, deps.deadline ?? Infinity);
  if (!usesNodeTest(await out(deps, ["cat", "package.json"]).catch(() => ""))) return undefined;
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
  // One order on every fork, so the file cap drops the same files everywhere.
  const ordered = extra.toSorted((a, b) => (a.author === b.author ? (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) : a.author < b.author ? -1 : 1));
  const results: CrossTest[] = [];
  for (const run of [...runs, ...ordered].slice(0, CROSS_TEST_MAX_FILES)) {
    if (now() + CROSS_TEST_TIMEOUT_S * 1_000 > deadline) return undefined;
    results.push({ author: run.author, file: run.file, ...(await runFile(deps, run.path)) });
  }
  return results;
}
