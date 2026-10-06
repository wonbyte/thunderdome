// A commit the verdict names (the fusion commit or the merge), as git shows it: hash, author,
// committer, parents, message and the files it changed. Server text only goes into textContent.
import { colorFor, displayName } from "./board";
import { closeButton, el, fileBlock, modal, showing } from "./dialog";
import { fileDiff } from "./diffview";

/** One file the commit changed (src/routes/commits.ts CommitFile). */
interface WireCommitFile {
  path: string;
  change: "added" | "modified" | "deleted";
  content?: string;
  before?: string;
  clipped?: boolean;
  binary?: boolean;
}
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
const CHANGE_LABEL: Record<WireCommitFile["change"], string> = { added: "new file", modified: "changed", deleted: "deleted" };

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
  head.append(who, closeButton(close));
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

function changedFile(file: WireCommitFile): HTMLElement {
  const label = CHANGE_LABEL[file.change];
  if (file.binary === true || file.content === undefined) {
    const block = el("section", "diff-file");
    const title = el("h3", "diff-path");
    title.append(el("span", undefined, file.path), el("span", "diff-tag", label));
    block.append(title, el("p", "diff-note", "A binary file."));
    return block;
  }
  const diff =
    file.change === "added" ? fileDiff(file.path, undefined, file.content) : file.change === "deleted" ? fileDiff(file.path, file.content, undefined) : fileDiff(file.path, file.before ?? "", file.content);
  const block = fileBlock(diff, label);
  if (file.clipped === true) block.append(el("p", "diff-note", "The file is long; only its start was read, so the diff may be incomplete."));
  return block;
}

/** Opens the dialog for one commit the verdict names and fills it when it arrives. */
export async function openCommit(taskId: string, hash: string): Promise<void> {
  const d = modal("commit-dialog", "diff-dialog commit-dialog");
  d.setAttribute("aria-labelledby", "commit-title");
  const close = (): void => d.close();
  const sha = hash.slice(0, 7);
  d.style.setProperty("--color", "var(--fuse)");
  d.replaceChildren(header(`Commit ${sha}`, close), el("p", "diff-note", "Loading the commit from Artifacts…"));
  if (!d.open) d.showModal();
  const current = showing(d, `commit:${taskId}/${hash}`);
  const c = await fetchCommit(taskId, hash);
  if (!current()) return;
  if (typeof c === "number") {
    d.replaceChildren(header(`Commit ${sha}`, close), el("p", "diff-note", c === 404 ? "Artifacts has no such commit for this race." : "Could not load the commit. Try again in a moment."));
    return;
  }
  const author = agentOf(c.author.name);
  if (author !== undefined) d.style.setProperty("--color", colorFor(author));
  const title = c.kind === "fusion" ? `Fusion commit ${sha}${author === undefined ? "" : ` by ${displayName(author)}`}` : `Merge commit ${sha} on main`;
  const body = el("div", "diff-body");
  body.append(meta(c), el("pre", "commit-msg", c.message));
  if (c.files.length > 0) body.append(el("h3", "commit-files", `Files changed (${c.files.length})`), ...c.files.map(changedFile));
  d.replaceChildren(header(title, close), body);
}
