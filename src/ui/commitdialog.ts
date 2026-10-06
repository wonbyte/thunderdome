// A commit the verdict names (the fusion commit or the merge), as git shows it: hash, author,
// committer, parents, message and the files it added. Server text only goes into textContent.
import { colorFor, displayName } from "./board";

/** One file the commit added (src/routes/commits.ts CommitFile). */
interface WireCommitFile { path: string; content?: string; clipped?: boolean; binary?: boolean }
/** GET /tasks/:id/commits/:sha (src/routes/commits.ts CommitView). */
interface WireCommit {
  kind: "fusion" | "merge";
  repo: string;
  hash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  committedAt: number;
  files: WireCommitFile[];
}

const cache = new Map<string, WireCommit>();
const LINE_LIMIT = 4000; // lines drawn per file

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dialog(): HTMLDialogElement {
  const found = document.getElementById("commit-dialog");
  if (found instanceof HTMLDialogElement) return found;
  const d = el("dialog", "diff-dialog commit-dialog");
  d.id = "commit-dialog";
  d.setAttribute("aria-labelledby", "commit-title");
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  return d;
}

async function fetchCommit(taskId: string, hash: string): Promise<WireCommit | number> {
  const key = `${taskId}/${hash}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(`/tasks/${taskId}/commits/${hash}`, { headers: { accept: "application/json" } });
    if (!res.ok) return res.status;
    const body = (await res.json()) as WireCommit;
    cache.set(key, body);
    return body;
  } catch {
    return 0;
  }
}

/** The agent behind a "Thunderdome <agent>" identity, if it is one. */
function agentOf(name: string): string | undefined {
  return /^Thunderdome ([a-z]+)$/.exec(name)?.[1];
}

function header(title: string, close: () => void): HTMLElement {
  const head = el("header", "diff-head");
  const who = el("div", "diff-who");
  const h = el("b", undefined, title);
  h.id = "commit-title";
  who.append(el("span", "diff-swatch"), h);
  const x = el("button", "diff-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", close);
  head.append(who, x);
  return head;
}

function person(p: { name: string; email: string }): HTMLElement {
  const agent = agentOf(p.name);
  const span = el("span", agent === undefined ? "commit-who" : "commit-who agent", `${p.name} <${p.email}>`);
  if (agent !== undefined) span.style.setProperty("--who", colorFor(agent));
  return span;
}

function meta(c: WireCommit): HTMLElement {
  const list = el("dl", "commit-meta");
  const row = (term: string, value: Node): void => {
    const dd = el("dd");
    dd.append(value);
    list.append(el("dt", undefined, term), dd);
  };
  row("commit", el("code", undefined, c.hash));
  row("Author", person(c.author));
  row("Commit", person(c.committer));
  row("Date", document.createTextNode(new Date(c.committedAt * 1000).toUTCString()));
  const parents = el("span");
  parents.append(...c.parents.map((p) => el("code", "commit-parent", p.slice(0, 7))));
  if (c.parents.length > 1) parents.append(document.createTextNode(" (a merge: main, then the fork)"));
  row(c.parents.length === 1 ? "Parent" : "Parents", parents);
  row("Repo", el("code", undefined, c.repo));
  return list;
}

function fileBlock(file: WireCommitFile): HTMLElement {
  const block = el("section", "diff-file");
  const lines = file.content?.split("\n") ?? [];
  if (lines.at(-1) === "") lines.pop();
  const title = el("h3", "diff-path");
  title.append(el("span", undefined, file.path), el("span", "add", ` new file +${lines.length}`));
  block.append(title);
  if (file.content === undefined) {
    block.append(el("p", "diff-note", file.binary === true ? "A binary file." : "This file is not in the commit."));
    return block;
  }
  const pre = el("pre", "diff-code");
  for (const line of lines.slice(0, LINE_LIMIT)) pre.append(el("span", "dl add", `+ ${line}`));
  if (lines.length > LINE_LIMIT) pre.append(el("span", "dl meta", `… ${lines.length - LINE_LIMIT} more lines`));
  if (file.clipped === true) pre.append(el("span", "dl meta", "… the file is longer; the rest is cut off"));
  block.append(pre);
  return block;
}

/** Opens the dialog for one commit the verdict names and fills it when it arrives. */
export async function openCommit(taskId: string, hash: string): Promise<void> {
  const d = dialog();
  const close = (): void => d.close();
  const sha = hash.slice(0, 7);
  d.style.setProperty("--color", "var(--fuse)");
  d.replaceChildren(header(`Commit ${sha}`, close), el("p", "diff-note", "Loading the commit from Artifacts…"));
  if (!d.open) d.showModal();
  const c = await fetchCommit(taskId, hash);
  if (!d.open) return;
  if (typeof c === "number") {
    d.replaceChildren(header(`Commit ${sha}`, close), el("p", "diff-note", c === 404 ? "Artifacts has no such commit for this race." : "Could not load the commit. Try again in a moment."));
    return;
  }
  const author = agentOf(c.author.name);
  if (author !== undefined) d.style.setProperty("--color", colorFor(author));
  const title = c.kind === "fusion" ? `Fusion commit ${sha}${author === undefined ? "" : ` by ${displayName(author)}`}` : `Merge commit ${sha} on main`;
  const body = el("div", "diff-body");
  body.append(meta(c), el("pre", "commit-msg", c.message));
  if (c.files.length > 0) body.append(el("h3", "commit-files", `Files added (${c.files.length})`), ...c.files.map(fileBlock));
  d.replaceChildren(header(title, close), body);
}
