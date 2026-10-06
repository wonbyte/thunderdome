// The code a robot wrote: a dialog with its fork's diff, as the judge scored it.
// Diff text only ever goes into textContent.
import { colorFor, displayName, styleLabel } from "./board";
import { parseDiff, type DiffFile } from "./diffview";

interface SavedDiff {
  agent: string;
  diff: string;
  clipped: boolean;
}

const cache = new Map<string, SavedDiff | number>();
const LINE_LIMIT = 4000; // lines drawn per file; the rest is summed up

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dialog(): HTMLDialogElement {
  const found = document.getElementById("diff-dialog");
  if (found instanceof HTMLDialogElement) return found;
  const d = el("dialog", "diff-dialog");
  d.id = "diff-dialog";
  // A click on the backdrop (the dialog itself, outside its box) closes it.
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  return d;
}

async function fetchDiff(taskId: string, agent: string): Promise<SavedDiff | number> {
  const key = `${taskId}/${agent}`;
  const hit = cache.get(key);
  if (hit !== undefined && hit !== 404) return hit;
  try {
    const res = await fetch(`/tasks/${taskId}/forks/${agent}/diff`, { headers: { accept: "application/json" } });
    if (!res.ok) {
      cache.set(key, res.status);
      return res.status;
    }
    const body = (await res.json()) as Partial<SavedDiff>;
    const saved = { agent, diff: typeof body.diff === "string" ? body.diff : "", clipped: body.clipped === true };
    cache.set(key, saved);
    return saved;
  } catch {
    return 0;
  }
}

function header(agent: string, files: DiffFile[] | undefined, close: () => void): HTMLElement {
  const head = el("header", "diff-head");
  const who = el("div", "diff-who");
  who.append(el("span", "diff-swatch"), el("b", undefined, `${displayName(agent)}'s code`));
  const style = styleLabel(agent);
  if (style !== undefined) who.append(el("span", "diff-style", style));
  head.append(who);
  if (files !== undefined) {
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const stat = el("span", "diff-stat");
    stat.append(el("span", "add", `+${added}`), el("span", "del", `−${removed}`), document.createTextNode(` · ${files.length} file${files.length === 1 ? "" : "s"}`));
    head.append(stat);
  }
  const x = el("button", "diff-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", close);
  head.append(x);
  return head;
}

function fileBlock(file: DiffFile): HTMLElement {
  const block = el("section", "diff-file");
  const title = el("h3", "diff-path");
  title.append(el("span", undefined, file.path), el("span", "add", ` +${file.added}`), el("span", "del", ` −${file.removed}`));
  const pre = el("pre", "diff-code");
  for (const line of file.lines.slice(0, LINE_LIMIT)) {
    const row = el("span", `dl ${line.kind}`);
    row.textContent = `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`;
    pre.append(row);
  }
  if (file.lines.length > LINE_LIMIT) pre.append(el("span", "dl meta", `… ${file.lines.length - LINE_LIMIT} more lines`));
  block.append(title, pre);
  return block;
}

function messageFor(status: number): string {
  if (status === 404) return "No saved diff for this fork yet. The judge saves each fork's diff when it scores the race, so it shows up once judging is done (races judged before this feature have none).";
  return "Could not load the diff. Try again in a moment.";
}

/** Opens the dialog for one agent and fills it when the diff arrives. */
export async function openDiff(taskId: string, agent: string): Promise<void> {
  const d = dialog();
  d.style.setProperty("--color", colorFor(agent));
  const close = (): void => d.close();
  d.replaceChildren(header(agent, undefined, close), el("p", "diff-note", "Loading the diff…"));
  if (!d.open) d.showModal();
  const saved = await fetchDiff(taskId, agent);
  if (!d.open) return;
  if (typeof saved === "number") {
    d.replaceChildren(header(agent, undefined, close), el("p", "diff-note", messageFor(saved)));
    return;
  }
  const files = parseDiff(saved.diff);
  const body = el("div", "diff-body");
  if (files.length === 0) body.append(el("p", "diff-note", "This fork changed no files."));
  if (files.length > 1) {
    const nav = el("nav", "diff-files");
    files.forEach((file, i) => {
      const link = el("button", "diff-jump");
      link.type = "button";
      link.append(el("span", undefined, file.path), el("span", "add", `+${file.added}`), el("span", "del", `−${file.removed}`));
      link.addEventListener("click", () => body.querySelectorAll(".diff-file")[i]?.scrollIntoView({ behavior: "smooth", block: "start" }));
      nav.append(link);
    });
    body.append(nav);
  }
  body.append(...files.map(fileBlock));
  if (saved.clipped) body.append(el("p", "diff-note", "The diff was too long to save in full; the rest is cut off."));
  d.replaceChildren(header(agent, files, close), body);
}
