// Ships a task: merges the judge's winner into the source repo, then locks every fork.
// Pure: git and token revocation are injected, so this runs in plain Node tests.
import { gitIdentity } from "../agents/runner";
import type { AgentName } from "../agents/prompt";
import { RESOLVE_REF_PREFIX, type ConflictRequest, type RaceOutcome, type ResolveAttempt, type ResolverName } from "./resolve";

/** A repo to ship into or from: its name, git remote and default branch. */
export interface ShipRepo { name: string; remote: string; defaultBranch: string }
/** An agent's fork. */
export interface ShipFork extends ShipRepo {
  agent: string;
  commit?: string; // the commit to merge (the judged head, or the fusion on top of it); else the fork's branch head
}
/** What shipping needs: the source repo, every fork, the winner and the why for the merge commit. */
export interface ShipInput {
  taskId: string;
  prompt: string;
  source: ShipRepo;
  forks: ShipFork[]; // every fork of the task, winner included
  winner: string | null; // agent name from the judge
  why: string;
  coAuthors?: string[]; // agents whose files the fusion round added; each gets a Co-authored-by trailer
}
/** The exit code and output of one git command. */
export interface GitResult { exitCode: number; stdout: string; stderr: string }
/**
 * What shipping needs from the outside: git in a source clone, token revocation, and optionally the
 * conflict race.
 */
export interface ShipDeps {
  /**
   * Runs `git ...args` in a clone of the source repo (origin = source remote, default branch checked out).
   * args do NOT include the leading "git". May throw (e.g. the clone failed).
   */
  git(args: string[]): Promise<GitResult>;
  /** Revokes every active write token of a repo by name; returns how many were revoked. */
  revokeWriteTokens(repo: string): Promise<number>;
  /** When given, a merge conflict starts the conflict race (src/ship/resolve.ts) instead of stopping the ship. */
  resolver?: ShipResolver;
}
/** Runs the conflict race and brings its bundle into the source clone. */
export interface ShipResolver {
  race(req: ConflictRequest): Promise<RaceOutcome>;
  /** Puts the race's bundle where git in the source clone can fetch it; returns its path. */
  importBundle(bundle: string): Promise<string>;
}
/** The conflict race behind a ship: which files conflicted, every attempt, and the one that shipped. */
export interface ShipResolve {
  files: string[];
  attempts: ResolveAttempt[];
  chosen?: ResolverName;
  kept?: string[]; // branches on the source repo that keep the other committed attempts
  error?: string; // why the race itself failed
}
/** How shipping ended: merged, stopped on a conflict, nothing to ship, or failed. */
export type ShipStatus = "merged" | "conflict" | "no-winner" | "error";
/**
 * A fork after shipping: how many write tokens were revoked, or why revoking failed (exactly one of
 * the two).
 */
export interface ForkLock { agent: string; fork: string; revoked?: number; error?: string }
/** What shipping did: the merge, the conflict race when there was one, and every fork's lock. */
export interface ShipResult {
  status: ShipStatus;
  winner: string | null;
  commit?: string; // merge commit hash, only when status is "merged"
  output?: string; // git stdout+stderr (last 4_000 chars) for "conflict" and failed git commands
  error?: string; // why status is "error"
  resolve?: ShipResolve; // set when the winner conflicted with the source and a resolver was given
  locks: ForkLock[]; // one per input fork, same order
  blame?: ShipBlame; // who wrote the shipped change's lines; only on merges since blame was added
}
/** Lines of the shipped change by author: an agent name, "thunderdome" (merge fixes) or "other". */
export type ShipBlame = Record<string, number>;
/** Changed files blamed after a merge; more are left out of the count. */
export const BLAME_MAX_FILES = 40;
/** Characters of git output a ship result keeps. */
export const SHIP_OUTPUT_LIMIT = 4_000;

type MergeOutcome = Omit<ShipResult, "winner" | "locks">;

/** The git trailer that credits an agent, with the identity its own commits use. */
export function coAuthorTrailer(agent: string): string {
  const id = gitIdentity(agent as AgentName);
  return `Co-authored-by: ${id.GIT_AUTHOR_NAME ?? ""} <${id.GIT_AUTHOR_EMAIL ?? ""}>`;
}

/**
 * Title line, blank line, then the why unchanged. With co-authors (the fusion round's), a blank
 * line and one Co-authored-by trailer each follow.
 */
export function mergeMessage(taskId: string, prompt: string, winner: string, why: string, coAuthors: readonly string[] = []): string {
  void prompt; // the prompt is deliberately left out of the message
  const message = `Thunderdome: ship ${winner}'s fork for task ${taskId}\n\n${why}`;
  const credited = [...new Set(coAuthors)].filter((agent) => agent !== winner);
  if (credited.length === 0) return message;
  // Trailers must be the last paragraph, so trailing blank lines of the why go.
  return `${message.trimEnd()}\n\n${credited.map(coAuthorTrailer).join("\n")}`;
}

/** Merges the winner (when there is one), then locks every fork. Never throws. */
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

/** What to merge from the winner's fork: its pinned commit, else the head just fetched. */
function theirsOf(fork: ShipFork): string {
  return fork.commit ?? "FETCH_HEAD";
}

async function mergeFork(deps: ShipDeps, input: ShipInput, fork: ShipFork): Promise<MergeOutcome> {
  const branch = input.source.defaultBranch;
  await runOk(deps, ["checkout", branch]);
  await runOk(deps, ["fetch", fork.remote, fork.defaultBranch]);
  const message = mergeMessage(input.taskId, input.prompt, fork.agent, input.why, input.coAuthors);
  // The commit that was judged, not whatever the branch holds by now: a push after judging never ships.
  const merged = await deps.git(["merge", "--no-ff", "--cleanup=verbatim", "-m", message, theirsOf(fork)]);
  if (merged.exitCode !== 0) {
    const output = gitOutput(merged);
    // Exit 1 (or CONFLICT lines) is a content conflict; anything else (e.g. 128) is a git failure.
    if (!isConflict(merged, output)) {
      await abortMerge(deps);
      throw new GitFailure(`git merge exited with ${merged.exitCode}`, output);
    }
    const files = await unmergedFiles(deps);
    await abortMerge(deps);
    if (deps.resolver === undefined) return { status: "conflict", output };
    return resolveConflict(deps, deps.resolver, input, fork, { files, output, message });
  }
  const head = await runOk(deps, ["rev-parse", "HEAD"]);
  await runOk(deps, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  return { status: "merged", commit: head.stdout.trim() };
}

interface Conflict { files: string[]; output: string; message: string }

/** Races resolvers on the conflict and ships the chosen resolution. With none, the ship stays "conflict". */
async function resolveConflict(deps: ShipDeps, resolver: ShipResolver, input: ShipInput, fork: ShipFork, conflict: Conflict): Promise<MergeOutcome> {
  const { files, output, message } = conflict;
  const base = (await runOk(deps, ["rev-parse", "HEAD"])).stdout.trim();
  const theirs = (await runOk(deps, ["rev-parse", theirsOf(fork)])).stdout.trim();
  let race: RaceOutcome;
  try {
    race = await resolver.race({
      taskId: input.taskId,
      prompt: input.prompt,
      winner: fork.agent,
      winnerRemote: fork.remote,
      winnerBranch: fork.defaultBranch,
      base,
      theirs,
      message,
      files,
    });
  } catch (err) {
    return { status: "conflict", output, resolve: { files, attempts: [], error: errorText(err) } };
  }
  const resolve: ShipResolve = { files, attempts: race.attempts };
  if (race.chosen === undefined || race.bundle === undefined) return { status: "conflict", output, resolve };
  const chosen = race.attempts.find((a) => a.agent === race.chosen);
  if (chosen?.commit === undefined) return { status: "conflict", output, resolve };
  try {
    const bundle = await resolver.importBundle(race.bundle);
    await runOk(deps, ["fetch", bundle, `+${RESOLVE_REF_PREFIX}*:${RESOLVE_REF_PREFIX}*`]);
    // The bundle came from another sandbox: ship only a merge of exactly this source head and the winner.
    const parents = (await runOk(deps, ["rev-parse", `${chosen.commit}^1`, `${chosen.commit}^2`])).stdout.trim().split("\n");
    if (parents[0] !== base || parents[1] !== theirs) {
      return { status: "conflict", output, resolve: { ...resolve, error: `${chosen.agent}'s commit is not a merge of ${base} and ${theirs}` } };
    }
    // Rejected when the source moved again during the conflict race.
    await runOk(deps, ["push", "origin", `${chosen.commit}:refs/heads/${input.source.defaultBranch}`]);
  } catch (err) {
    // Keep the race's attempts with the error, so their cost and outcome are not lost.
    if (err instanceof GitFailure) return { status: "error", error: err.message, output: err.output, resolve };
    return { status: "error", error: errorText(err), resolve };
  }
  resolve.chosen = chosen.agent;
  const kept = await keepAttempts(deps, input.taskId, race.attempts, chosen.agent);
  if (kept.length > 0) resolve.kept = kept;
  return { status: "merged", commit: chosen.commit, resolve };
}

/** Best effort: the other committed attempts stay on the source as branches, like the losing forks. */
async function keepAttempts(deps: ShipDeps, taskId: string, attempts: ResolveAttempt[], chosen: ResolverName): Promise<string[]> {
  const others = attempts.filter((a) => a.agent !== chosen && a.commit !== undefined);
  if (others.length === 0) return [];
  const branches = others.map((a) => `thunderdome/${taskId}/resolve-${a.agent}`);
  const refspecs = others.map((a, i) => `${RESOLVE_REF_PREFIX}${a.agent}:refs/heads/${branches[i] ?? ""}`);
  try {
    const pushed = await deps.git(["push", "origin", ...refspecs]);
    return pushed.exitCode === 0 ? branches : [];
  } catch {
    return [];
  }
}

/** The conflicted paths while the merge is still in progress. */
async function unmergedFiles(deps: ShipDeps): Promise<string[]> {
  try {
    const result = await deps.git(["diff", "--name-only", "--diff-filter=U"]);
    return result.exitCode === 0 ? result.stdout.split("\n").filter((f) => f !== "") : [];
  } catch {
    return [];
  }
}

function isConflict(result: GitResult, output: string): boolean {
  return result.exitCode === 1 || /^CONFLICT\b/m.test(output);
}

/** Best effort: the merge failure is what gets reported, not a failed abort. */
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

/** Every fork, the winner's too, becomes read-only; one failure does not stop the others. */
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

/**
 * Counts `git blame --line-porcelain` lines by author, skipping lines from outside the blamed range
 * ("boundary") and blank lines. An agent is known by its gitIdentity email, Thunderdome by its own;
 * anyone else is "other".
 */
export function parseBlame(porcelain: string, into: ShipBlame = {}): ShipBlame {
  let mail = "";
  let boundary = false;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("\t")) {
      if (!boundary && line.trim() !== "") {
        const who = /^<([a-z0-9-]+)@thunderdome\.local>$/.exec(mail)?.[1] ?? "other";
        into[who] = (into[who] ?? 0) + 1;
      }
      [mail, boundary] = ["", false];
    } else if (line.startsWith("author-mail ")) mail = line.slice("author-mail ".length).trim();
    else if (line === "boundary") boundary = true;
  }
  return into;
}

/**
 * Who wrote the shipped change: `git blame -w` over the merge's first parent..merge, on each file
 * the merge added or changed. Runs only git (the ship sandbox). Best effort: undefined on any failure.
 */
export async function shipBlame(git: ShipDeps["git"], commit: string): Promise<ShipBlame | undefined> {
  try {
    const parent = `${commit}^1`;
    const names = await git(["diff", "--name-only", "--no-renames", "--diff-filter=AM", parent, commit]);
    if (names.exitCode !== 0) return undefined;
    const files = names.stdout.split("\n").filter((f) => f !== "").slice(0, BLAME_MAX_FILES);
    const blame: ShipBlame = {};
    for (const file of files) {
      const out = await git(["blame", "-w", "--line-porcelain", `${parent}..${commit}`, "--", file]);
      if (out.exitCode !== 0) return undefined;
      parseBlame(out.stdout, blame);
    }
    return blame;
  } catch {
    return undefined;
  }
}
