// GET /tasks/:id/commits/:sha: a commit the verdict names, read from Artifacts, so the race page
// can show that the fusion and the merge are real git. Never answers for any other hash.
import type { Task } from "../room/task";

/** Characters of one file the route returns; the rest is cut off. */
export const COMMIT_FILE_MAX = 64_000;
/** Files one commit view carries at most. */
export const COMMIT_FILES_MAX = 10;

/** Which commit of the verdict: the fusion commit on the winner's fork, or the merge on main. */
export type CommitKind = "fusion" | "merge";

/** One file the commit added, as the route returns it. */
export interface CommitFile {
  path: string;
  content?: string; // absent when the file is missing at the commit or is binary
  clipped?: boolean;
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

/** Where a hash the verdict names lives, and which files it added; undefined for any other hash. */
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
  if (verdict.ship.commit === sha) return { kind: "merge", repo: task.repo, files: [] };
  return undefined;
}

/** A file's text for the view: clipped when long, left out when binary. */
export function fileView(path: string, text: string | undefined): CommitFile {
  if (text === undefined) return { path };
  if (text.includes("\u0000")) return { path, binary: true };
  return text.length > COMMIT_FILE_MAX ? { path, content: text.slice(0, COMMIT_FILE_MAX), clipped: true } : { path, content: text };
}

/** Reads the commit and its added files. Commits never change, so a found one is cached for good. */
export async function commitResponse(artifacts: Artifacts, task: Task, sha: string): Promise<Response> {
  const target = commitTarget(task, sha);
  if (target === undefined) return Response.json({ error: "not found" }, { status: 404 });
  using repo = await artifacts.get(target.repo);
  const commit = await repo.readCommit(sha);
  if (commit === null) return Response.json({ error: "not found" }, { status: 404 });
  const files = await Promise.all(
    target.files.map(async (path) => {
      const blob = await repo.readFile({ ref: sha, path }).catch(() => null);
      return fileView(path, blob === null ? undefined : await blob.text());
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
    files,
  };
  return Response.json(view, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
}
