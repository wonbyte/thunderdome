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
