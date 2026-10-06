// The shell both code dialogs share (a robot's diff, a verdict commit): the modal, its close
// button, a file's diff block, and a guard against a slow load landing in a dialog that moved on.
// Text only ever goes into textContent.
import type { DiffFile } from "./diffview";

/** Lines drawn per file; the rest is summed up. */
export const LINE_LIMIT = 4000;

/** A new element with an optional class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The modal with this id, made on first use. A click on the backdrop closes it. */
export function modal(id: string, className: string): HTMLDialogElement {
  const found = document.getElementById(id);
  if (found instanceof HTMLDialogElement) return found;
  const d = el("dialog", className);
  d.id = id;
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  return d;
}

/** The ✕ button in a dialog's header. */
export function closeButton(close: () => void): HTMLButtonElement {
  const x = el("button", "diff-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", close);
  return x;
}

/**
 * Marks the dialog as showing `key` and returns a check: true while it still shows `key`. Call
 * the check after each await, so an older, slower load never replaces a newer one.
 */
export function showing(d: HTMLDialogElement, key: string): () => boolean {
  d.dataset.showing = key;
  return () => d.open && d.dataset.showing === key;
}

/** One file of a diff: its path, its +/− counts, and its lines. */
export function fileBlock(file: DiffFile, note?: string): HTMLElement {
  const block = el("section", "diff-file");
  const title = el("h3", "diff-path");
  title.append(el("span", undefined, file.path), el("span", "add", ` +${file.added}`), el("span", "del", ` −${file.removed}`));
  if (note !== undefined) title.append(el("span", "diff-tag", note));
  const pre = el("pre", "diff-code");
  for (const line of file.lines.slice(0, LINE_LIMIT)) {
    const row = el("span", `dl ${line.kind}`);
    row.textContent = line.kind === "hunk" || line.kind === "meta" ? line.text : `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`;
    pre.append(row);
  }
  if (file.lines.length > LINE_LIMIT) pre.append(el("span", "dl meta", `… ${file.lines.length - LINE_LIMIT} more lines`));
  block.append(title, pre);
  return block;
}
