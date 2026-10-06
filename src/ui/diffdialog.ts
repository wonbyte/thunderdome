// The code a robot wrote: a dialog with its fork's diff, as the judge scored it.
// Diff text only ever goes into textContent.
import { colorFor, displayName, styleLabel } from "./board";
import { closeButton, el, fileBlock, modal, showing } from "./dialog";
import { parseDiff, type DiffFile } from "./diffview";

interface SavedDiff {
  agent: string;
  diff: string;
  clipped: boolean;
}

const cache = new Map<string, SavedDiff | number>();

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
  head.append(closeButton(close));
  return head;
}

function messageFor(status: number): string {
  if (status === 404) return "No saved diff for this fork yet. The judge saves each fork's diff when it scores the race, so it shows up once judging is done (races judged before this feature have none).";
  return "Could not load the diff. Try again in a moment.";
}

/** Opens the dialog for one agent and fills it when the diff arrives. */
export async function openDiff(taskId: string, agent: string): Promise<void> {
  const d = modal("diff-dialog", "diff-dialog");
  d.style.setProperty("--color", colorFor(agent));
  const close = (): void => d.close();
  d.replaceChildren(header(agent, undefined, close), el("p", "diff-note", "Loading the diff…"));
  if (!d.open) d.showModal();
  const current = showing(d, `diff:${taskId}/${agent}`);
  const saved = await fetchDiff(taskId, agent);
  if (!current()) return;
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
  body.append(...files.map((file) => fileBlock(file)));
  if (saved.clipped) body.append(el("p", "diff-note", "The diff was too long to save in full; the rest is cut off."));
  d.replaceChildren(header(agent, files, close), body);
}
