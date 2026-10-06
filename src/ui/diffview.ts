// A unified diff split into files and typed lines for the diff viewer. Pure, like board.ts.

/** What a diff line is: added, removed, context, a hunk header, or a meta line. */
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";
/** One typed diff line, without its +/- prefix. */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}
/** One file of a diff: its path, its added and removed line counts, and its lines. */
export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[]; // hunks and their lines; the file header lines are left out
}

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** Files in diff order. Lines before the first "diff --git" are ignored. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const header = HEADER.exec(line);
    if (header !== null) {
      file = { path: header[2] ?? header[1] ?? "", added: 0, removed: 0, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (file === undefined) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      file.lines.push({ kind: "hunk", text: line });
    } else if (!inHunk) {
      // index, ---/+++ and mode lines. A new or deleted file says so here.
      if (/^(new|deleted) file mode/.test(line)) file.lines.push({ kind: "meta", text: line.startsWith("new") ? "new file" : "deleted file" });
      else if (line.startsWith("Binary files")) file.lines.push({ kind: "meta", text: "binary file" });
    } else if (line.startsWith("+")) {
      file.added += 1;
      file.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      file.removed += 1;
      file.lines.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      file.lines.push({ kind: "ctx", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      file.lines.push({ kind: "meta", text: line.slice(2) });
    }
  }
  return files;
}

/** Unchanged lines kept around each change in a file diff. */
export const DIFF_CONTEXT = 3;
/** Above this many line pairs the diff is not worked out: the old file is shown removed, the new added. */
export const DIFF_CELLS_MAX = 2_000_000;

/**
 * One file's change from its text before to its text after, as diff lines: a new file is all
 * added, a deleted one all removed, and an edited one an LCS line diff with DIFF_CONTEXT lines
 * of context. Undefined text means the file is not there.
 */
export function fileDiff(path: string, before: string | undefined, after: string | undefined): DiffFile {
  const ops = diffOps(linesOf(before), linesOf(after));
  return {
    path,
    added: ops.filter((l) => l.kind === "add").length,
    removed: ops.filter((l) => l.kind === "del").length,
    lines: withContext(ops),
  };
}

function linesOf(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const line = (kind: DiffLineKind) => (text: string): DiffLine => ({ kind, text });

function diffOps(a: string[], b: string[]): DiffLine[] {
  // The common head and tail need no table, which keeps the usual small edit cheap.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return [...a.slice(0, start).map(line("ctx")), ...middle(a.slice(start, endA), b.slice(start, endB)), ...a.slice(endA).map(line("ctx"))];
}

function middle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > DIFF_CELLS_MAX) return [...a.map(line("del")), ...b.map(line("add"))];
  // lcs[i * w + j]: the longest common subsequence of a[i..] and b[j..].
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number): number => lcs[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: "del", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  return [...out, ...a.slice(i).map(line("del")), ...b.slice(j).map(line("add"))];
}

/** Keeps DIFF_CONTEXT unchanged lines around each change; a longer unchanged run becomes one hunk line. */
function withContext(ops: DiffLine[]): DiffLine[] {
  const near = Array.from({ length: ops.length }, () => false);
  ops.forEach((op, k) => {
    if (op.kind === "ctx") return;
    for (let d = Math.max(0, k - DIFF_CONTEXT); d <= Math.min(ops.length - 1, k + DIFF_CONTEXT); d += 1) near[d] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  const flush = (): void => {
    if (skipped > 0) out.push({ kind: "hunk", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
    skipped = 0;
  };
  ops.forEach((op, k) => {
    if (near[k] === true) {
      flush();
      out.push(op);
    } else skipped += 1;
  });
  flush();
  return out;
}
