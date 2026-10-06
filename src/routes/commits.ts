// GET /tasks/:id/commits/:sha: a commit the verdict names, read from Artifacts, so the race page
// can show that the fusion and the merge are real git. Never answers for any other hash.
import { isArtifactsError } from "../artifacts/repo";
import type { Task } from "../room/task";
import type { ShipResult } from "../ship/ship";

/** Characters of one file the route returns; the rest is cut off. */
export const COMMIT_FILE_MAX = 64_000;
/** Files one commit view carries at most. */
export const COMMIT_FILES_MAX = 10;

/** Which commit of the verdict: the fusion commit on the winner's fork, or the merge on main. */
export type CommitKind = "fusion" | "merge";

/** How a commit changed a file, against its first parent. */
export type FileChange = "added" | "modified" | "deleted";

/** One file the commit changed, as the route returns it. */
export interface CommitFile {
  path: string;
  change: FileChange;
  content?: string; // the file at the commit (before it, for a deleted file); absent when binary
  before?: string; // the file at the parent, for a modified file
  clipped?: boolean; // content or before was cut at COMMIT_FILE_MAX
  binary?: boolean;
}

/** What GET /tasks/:id/commits/:sha returns. */
export interface CommitView {
  kind: CommitKind;
  repo: string;
  hash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number;
  committedAt: number;
  files: CommitFile[];
}

/** A full, lowercase 40-character commit hash. */
export function isCommitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

/**
 * Where a hash the verdict names lives, and which files it may have changed (every kept try's;
 * the route keeps those that differ from the parent); undefined for any other hash.
 */
export function commitTarget(task: Task, sha: string): { kind: CommitKind; repo: string; files: string[] } | undefined {
  const verdict = task.verdict;
  if (verdict === undefined || !isCommitSha(sha)) return undefined;
  const fusion = verdict.fusion;
  if (fusion?.commit === sha && verdict.winner !== null) {
    const fork = task.agents.find((a) => a.name === verdict.winner)?.fork;
    if (fork === undefined) return undefined;
    const files = [...new Set(fusion.tried.filter((t) => t.status === "added").flatMap((t) => t.files))];
    return { kind: "fusion", repo: fork, files: files.slice(0, COMMIT_FILES_MAX) };
  }
  // Older or partly saved verdicts may lack ship.
  const ship = verdict.ship as ShipResult | undefined;
  if (ship?.commit === sha) return { kind: "merge", repo: task.repo, files: [] };
  return undefined;
}

/** A file at one commit: found or not, binary or not, and its text cut at COMMIT_FILE_MAX. */
export interface FileText { text?: string; clipped: boolean; binary: boolean; found: boolean }

async function readText(repo: ArtifactsRepo, ref: string, path: string): Promise<FileText> {
  // A failed read throws (503); only null means the file is not there.
  const blob = await repo.readFile({ ref, path });
  if (blob === null) return { clipped: false, binary: false, found: false };
  // Up to 4 bytes per character, so this slice always holds COMMIT_FILE_MAX characters when there are that many.
  const text = await blob.slice(0, COMMIT_FILE_MAX * 4 + 4).text();
  if (text.includes("\u0000")) return { clipped: false, binary: true, found: true };
  const clipped = blob.size > COMMIT_FILE_MAX * 4 + 4 || text.length > COMMIT_FILE_MAX;
  return { text: text.slice(0, COMMIT_FILE_MAX), clipped, binary: false, found: true };
}

/** The file as the commit changed it, or undefined when the commit left it as its parent had it. */
export function fileView(path: string, before: FileText, after: FileText): CommitFile | undefined {
  if (!after.found && !before.found) return undefined;
  const clipped = before.clipped || after.clipped;
  const extra = clipped ? { clipped } : {};
  if (!before.found) return after.binary ? { path, change: "added", binary: true } : { path, change: "added", ...(after.text === undefined ? {} : { content: after.text }), ...extra };
  if (!after.found) return before.binary ? { path, change: "deleted", binary: true } : { path, change: "deleted", ...(before.text === undefined ? {} : { content: before.text }), ...extra };
  if (before.binary || after.binary) return before.binary && after.binary ? undefined : { path, change: "modified", binary: true };
  if (before.text === after.text && !clipped) return undefined;
  return { path, change: "modified", content: after.text ?? "", before: before.text ?? "", ...extra };
}

/**
 * Reads the commit and the files it changed against its first parent. Commits never change, so a
 * found one is cached for good. A repo or commit Artifacts does not have is 404; an Artifacts
 * failure is 503, not cached.
 */
export async function commitResponse(artifacts: Artifacts, task: Task, sha: string): Promise<Response> {
  const target = commitTarget(task, sha);
  if (target === undefined) return notFound();
  try {
    using repo = await artifacts.get(target.repo);
    const commit = await repo.readCommit(sha);
    if (commit === null) return notFound();
    const parent = commit.parents[0];
    const files = await Promise.all(
      target.files.map(async (path) => {
        const [before, after] = await Promise.all([
          parent === undefined ? Promise.resolve<FileText>({ clipped: false, binary: false, found: false }) : readText(repo, parent, path),
          readText(repo, sha, path),
        ]);
        return fileView(path, before, after);
      }),
    );
    const view: CommitView = {
      kind: target.kind,
      repo: target.repo,
      hash: commit.hash,
      message: commit.message,
      author: commit.author,
      committer: commit.committer,
      parents: commit.parents,
      authoredAt: commit.authoredAt,
      committedAt: commit.committedAt,
      files: files.filter((f) => f !== undefined),
    };
    return Response.json(view, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
  } catch (cause) {
    if (isArtifactsError(cause, "NOT_FOUND")) return notFound();
    console.error({ event: "commit.read_failed", sha, error: String(cause) });
    return Response.json({ error: "could not read the commit" }, { status: 503 });
  }
}

function notFound(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}
