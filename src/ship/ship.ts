// Ships a task: merges the judge's winner into the source repo, then locks every fork.
// Pure: git and token revocation are injected, so this runs in plain Node tests.

export interface ShipRepo { name: string; remote: string; defaultBranch: string }
export interface ShipFork extends ShipRepo { agent: string }
export interface ShipInput {
  taskId: string;
  prompt: string;
  source: ShipRepo;
  forks: ShipFork[]; // every fork of the task, winner included
  winner: string | null; // agent name from the judge
  why: string;
}
export interface GitResult { exitCode: number; stdout: string; stderr: string }
export interface ShipDeps {
  // Runs `git ...args` in a clone of the source repo (origin = source remote, default branch checked out).
  // args do NOT include the leading "git". May throw (e.g. the clone failed).
  git(args: string[]): Promise<GitResult>;
  // Revokes every active write token of a repo by name; returns how many were revoked.
  revokeWriteTokens(repo: string): Promise<number>;
}
export type ShipStatus = "merged" | "conflict" | "no-winner" | "error";
export interface ForkLock { agent: string; fork: string; revoked?: number; error?: string } // exactly one of revoked/error
export interface ShipResult {
  status: ShipStatus;
  winner: string | null;
  commit?: string; // merge commit hash, only when status is "merged"
  output?: string; // git stdout+stderr (last 4_000 chars) for "conflict" and failed git commands
  error?: string; // why status is "error"
  locks: ForkLock[]; // one per input fork, same order
}
export const SHIP_OUTPUT_LIMIT = 4_000;

type MergeOutcome = Omit<ShipResult, "winner" | "locks">;

// Title line, blank line, then the why unchanged.
export function mergeMessage(taskId: string, prompt: string, winner: string, why: string): string {
  void prompt; // the prompt is deliberately left out of the message
  return `Thunderdome: ship ${winner}'s fork for task ${taskId}\n\n${why}`;
}

// Merges the winner (when there is one), then locks every fork. Never throws.
export async function shipTask(deps: ShipDeps, input: ShipInput): Promise<ShipResult> {
  const outcome = await merge(deps, input);
  const locks = await lockForks(deps, input.forks);
  return { ...outcome, winner: input.winner, locks };
}

async function merge(deps: ShipDeps, input: ShipInput): Promise<MergeOutcome> {
  if (input.winner === null) return { status: "no-winner" };
  const fork = input.forks.find((f) => f.agent === input.winner);
  if (!fork) return { status: "error", error: `winner ${input.winner} has no fork` };
  try {
    return await mergeFork(deps, input, fork);
  } catch (err) {
    if (err instanceof GitFailure) return { status: "error", error: err.message, output: err.output };
    return { status: "error", error: errorText(err) };
  }
}

async function mergeFork(deps: ShipDeps, input: ShipInput, fork: ShipFork): Promise<MergeOutcome> {
  const branch = input.source.defaultBranch;
  await runOk(deps, ["checkout", branch]);
  await runOk(deps, ["fetch", fork.remote, fork.defaultBranch]);
  const message = mergeMessage(input.taskId, input.prompt, fork.agent, input.why);
  const merged = await deps.git(["merge", "--no-ff", "--cleanup=verbatim", "-m", message, "FETCH_HEAD"]);
  if (merged.exitCode !== 0) {
    await abortMerge(deps);
    const output = gitOutput(merged);
    // Exit 1 (or CONFLICT lines) is a content conflict; anything else (e.g. 128) is a git failure.
    if (isConflict(merged, output)) return { status: "conflict", output };
    throw new GitFailure(`git merge exited with ${merged.exitCode}`, output);
  }
  const head = await runOk(deps, ["rev-parse", "HEAD"]);
  await runOk(deps, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  return { status: "merged", commit: head.stdout.trim() };
}

function isConflict(result: GitResult, output: string): boolean {
  return result.exitCode === 1 || /^CONFLICT\b/m.test(output);
}

// Best effort: the merge failure is what gets reported, not a failed abort.
async function abortMerge(deps: ShipDeps): Promise<void> {
  try {
    await deps.git(["merge", "--abort"]);
  } catch {
    // ignored
  }
}

class GitFailure extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
  }
}

async function runOk(deps: ShipDeps, args: string[]): Promise<GitResult> {
  const result = await deps.git(args);
  if (result.exitCode !== 0) {
    throw new GitFailure(`git ${args[0] ?? ""} exited with ${result.exitCode}`, gitOutput(result));
  }
  return result;
}

function gitOutput(result: GitResult): string {
  const text = [result.stdout, result.stderr].filter((s) => s !== "").join("\n");
  return text.slice(-SHIP_OUTPUT_LIMIT);
}

// Every fork, the winner's too, becomes read-only; one failure does not stop the others.
async function lockForks(deps: ShipDeps, forks: ShipFork[]): Promise<ForkLock[]> {
  // The async wrapper turns a synchronous throw into a rejection, so allSettled still sees it.
  const settled = await Promise.allSettled(forks.map(async (f) => deps.revokeWriteTokens(f.name)));
  return forks.map((f, i) => {
    const s = settled[i];
    const lock: ForkLock = { agent: f.agent, fork: f.name };
    if (s?.status === "fulfilled") lock.revoked = s.value;
    else lock.error = s ? reasonText(s.reason) : "not settled";
    return lock;
  });
}

function reasonText(reason: unknown): string {
  try {
    return String(reason);
  } catch {
    return "unknown error";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : reasonText(err);
}
