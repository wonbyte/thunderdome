// Link previews: the og tags a page gets, and the result card drawn for GET /race/:id/card.png.
// Pure, so the tests run it without the Workers runtime. Prompts are written by players and the
// why by the judge, so every string is escaped before it goes into markup.
import { isTaskId, type Task } from "../room/task";

/** The card's size in CSS pixels (the og:image size every crawler expects). */
export const CARD = { width: 1200, height: 630 } as const;
/** A card is kept under this many bytes (the DO row limit is 2 MB; a flat card is far smaller). */
export const CARD_MAX_BYTES = 1_000_000;
/** The prompt's characters on the card and in og:title. */
const PROMPT_MAX = 180;

/** Mirrors AGENT_COLORS and AGENT_DISPLAY_NAMES in src/ui/board.ts (the page is browser code). */
const ROBOTS: Readonly<Record<string, { name: string; color: string }>> = {
  ponder: { name: "Ponder", color: "#d97757" },
  zippy: { name: "Zippy", color: "#e5484d" },
  testy: { name: "Testy", color: "#3e8ed0" },
  snip: { name: "Snip", color: "#30a46c" },
  sparkle: { name: "Sparkle", color: "#8e4ec6" },
};
const FALLBACK_COLOR = "#8b8d98";

const robotName = (agent: string): string => (Object.hasOwn(ROBOTS, agent) ? ROBOTS[agent]!.name : agent);
const robotColor = (agent: string): string => (Object.hasOwn(ROBOTS, agent) ? ROBOTS[agent]!.color : FALLBACK_COLOR);

/** Text safe inside an element or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** The task id in GET /race/:id/card.png, or undefined for any other path. */
export function cardTaskId(pathname: string): string | undefined {
  const parts = pathname.split("/");
  const [empty, root, id = "", file] = parts;
  return parts.length === 4 && empty === "" && root === "race" && isTaskId(id) && file === "card.png" ? id : undefined;
}

/** The prompt on one line, cut for a title. */
function shortPrompt(prompt: string, max = PROMPT_MAX): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The judge's headline with each agent id swapped for its name (whyWithNames in src/ui/board.ts, without the table case). */
function withNames(text: string, agents: readonly string[]): string {
  let out = text;
  for (const agent of agents) {
    const name = robotName(agent);
    if (name === agent || !/^[a-z]+$/.test(agent)) continue;
    out = out.replace(new RegExp(`(?<![/\\w.-])${agent}(?![\\w-]|\\.\\w)`, "g"), name);
  }
  return out;
}

/** One og or twitter tag. */
export interface MetaTag { property: string; content: string }

/** The tags every page gets: the site, the card type and the static image. */
export function siteTags(origin: string, title: string, description: string): MetaTag[] {
  return [
    { property: "og:site_name", content: "Thunderdome" },
    { property: "og:type", content: "website" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:image", content: `${origin}/og.png` },
    { property: "og:image:width", content: String(CARD.width) },
    { property: "og:image:height", content: String(CARD.height) },
    { property: "og:image:type", content: "image/png" },
    { property: "twitter:card", content: "summary_large_image" },
  ];
}

/**
 * The tags for /race/:id: the prompt as the title, the winner and the judge's headline (or "live
 * race") as the description, and the result card once there is a verdict. No task: the site's tags.
 */
export function raceTags(task: Task | null | undefined, origin: string): MetaTag[] {
  if (task === null || task === undefined) return siteTags(origin, "Thunderdome race", "Watch AI agents race on forks of one repo, and see why the judge shipped the winner.");
  const agents = task.agents.map((a) => a.name);
  const v = task.verdict;
  let description: string;
  if (v === undefined) description = task.status === "finished" ? "The judge is scoring every fork." : `A live race: ${agents.map(robotName).join(", ")} on their own forks of one repo.`;
  else if (v.winner === null) description = "No winner: no fork passed.";
  else description = `${robotName(v.winner)} won${v.headline === undefined ? "." : `: ${withNames(v.headline, agents)}`}`;
  const tags = siteTags(origin, shortPrompt(task.prompt, 90), description);
  tags.push({ property: "og:url", content: `${origin}/race/${task.id}` });
  if (v !== undefined && v.winner !== null) {
    const image = tags.find((t) => t.property === "og:image");
    if (image !== undefined) image.content = `${origin}/race/${task.id}/card.png`;
  }
  return tags;
}

/** `<meta>` elements for the tags, ready to append to `<head>`. */
export function metaHtml(tags: MetaTag[]): string {
  return tags.map((t) => `<meta ${t.property.startsWith("twitter:") ? "name" : "property"}="${escapeHtml(t.property)}" content="${escapeHtml(t.content)}">`).join("\n");
}

/** The ranked forks for the podium: best first, from the verdict's scores. Older verdicts have none. */
function podium(task: Task): { agent: string; total: number }[] {
  const scores = task.verdict?.scores ?? [];
  return scores
    .filter((s) => Number.isFinite(s.total))
    .toSorted((a, b) => b.total - a.total)
    .slice(0, 3);
}

/**
 * The result card as a page: the winner in its color, the podium, the prompt and the judge's
 * headline, at 1200x630, inline styles only (the browser that shoots it loads nothing else). No
 * emoji and no web fonts: the renderer has neither.
 */
export function cardHtml(task: Task): string {
  const v = task.verdict;
  const winner = v?.winner ?? null;
  const agents = task.agents.map((a) => a.name);
  const color = winner === null ? FALLBACK_COLOR : robotColor(winner);
  const title = winner === null ? "No winner" : `${robotName(winner)} won`;
  const headline = v?.headline === undefined ? "" : withNames(v.headline, agents);
  const steps = podium(task);
  const fused = v?.ship?.status === "merged" ? (v.fusion?.tried ?? []).filter((t) => t.status === "added").length : 0;
  const rows = steps
    .map((s, i) => {
      const c = robotColor(s.agent);
      return `<li style="--c:${c}"><b>${i + 1}</b><span class="n">${escapeHtml(robotName(s.agent))}</span><i><u style="width:${Math.max(2, Math.min(100, s.total))}%"></u></i><em>${s.total.toFixed(1)}</em></li>`;
    })
    .join("");
  const lineup = agents
    .filter((a) => !steps.some((s) => s.agent === a))
    .map((a) => `<span style="--c:${robotColor(a)}">${escapeHtml(robotName(a))}</span>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
* { box-sizing: border-box; margin: 0; }
html, body { width: ${CARD.width}px; height: ${CARD.height}px; overflow: hidden; }
body { --c: ${color}; font: 26px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e6e9f2;
  background: radial-gradient(900px 500px at 15% 0%, color-mix(in srgb, var(--c) 28%, transparent), transparent 70%), radial-gradient(700px 400px at 100% 100%, #1a2140, transparent 70%), #07080d;
  padding: 56px 64px; display: flex; flex-direction: column; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 14px; font-weight: 800; letter-spacing: .22em; text-transform: uppercase; font-size: 22px; color: #c9cede; }
.brand i { width: 26px; height: 26px; border-radius: 7px; background: conic-gradient(from 0deg, #d97757, #e5484d, #3e8ed0, #30a46c, #8e4ec6, #d97757); }
.brand small { margin-left: auto; font: 500 20px/1 ui-monospace, Menlo, monospace; letter-spacing: 0; text-transform: none; color: #7d839b; }
h1 { font-size: 76px; line-height: 1; font-weight: 800; letter-spacing: -.02em; color: var(--c); }
.why { margin-top: 14px; font-size: 28px; color: #d5d9e6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.main { display: flex; gap: 48px; align-items: flex-end; }
.left { flex: 1 1 0; min-width: 0; }
.prompt { font-size: 22px; color: #8a90a6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.prompt::before { content: "Task · "; color: #7d839b; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; font-size: 16px; }
ol { flex: 0 0 440px; list-style: none; padding: 20px 24px; border-radius: 20px; background: #0f121b; border: 1px solid #1f2536; display: grid; gap: 14px; }
li { display: grid; grid-template-columns: 34px 120px 1fr 72px; align-items: center; gap: 12px; font-size: 24px; }
li b { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 16px; background: var(--c); color: #0b0d14; }
li .n { font-weight: 700; color: var(--c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
li i { height: 12px; border-radius: 6px; background: #1f2536; overflow: hidden; display: block; }
li u { display: block; height: 100%; background: var(--c); border-radius: 6px; }
li em { font: 700 22px/1 ui-monospace, Menlo, monospace; text-align: right; }
.lineup { display: flex; gap: 8px; margin-top: 4px; }
.lineup span { font-size: 16px; font-weight: 700; color: var(--c); opacity: .7; }
.fused { display: inline-block; margin-top: 12px; padding: 4px 12px; border-radius: 999px; font-size: 16px; font-weight: 700; color: #ffb02e; border: 1px solid #ffb02e66; }
</style></head><body>
<div class="brand"><i></i>Thunderdome<small>${escapeHtml(task.id)}</small></div>
<div class="main"><div class="left"><h1>${escapeHtml(title)}</h1>
${headline === "" ? "" : `<p class="why">${escapeHtml(headline)}</p>`}
${fused > 0 ? `<span class="fused">+ ${fused} fused from the losers</span>` : ""}
</div>${rows === "" ? "" : `<ol>${rows}${lineup === "" ? "" : `<div class="lineup">${lineup}</div>`}</ol>`}</div>
<p class="prompt">${escapeHtml(shortPrompt(task.prompt))}</p>
</body></html>`;
}

/**
 * The site's card (public/og.png), for the gallery and the play page: the brand, what Thunderdome
 * does, and the five robots. `node scripts/build-og.mjs` prints it; a browser at 1200x630 shoots it.
 */
export function siteCardHtml(): string {
  const robots = Object.values(ROBOTS)
    .map((r) => `<span style="--c:${r.color}"><i></i>${r.name}</span>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Thunderdome</title><style>
* { box-sizing: border-box; margin: 0; }
html, body { width: ${CARD.width}px; height: ${CARD.height}px; overflow: hidden; }
body { font: 26px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e6e9f2; padding: 64px;
  background: radial-gradient(1000px 520px at 50% -10%, #1a2140, transparent 70%), #07080d;
  display: flex; flex-direction: column; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 18px; font-weight: 800; letter-spacing: .24em; text-transform: uppercase; font-size: 30px; }
.brand i { width: 36px; height: 36px; border-radius: 9px; background: conic-gradient(from 0deg, #d97757, #e5484d, #3e8ed0, #30a46c, #8e4ec6, #d97757); box-shadow: 0 0 30px #7fe3ff55; }
h1 { font-size: 64px; line-height: 1.1; font-weight: 800; letter-spacing: -.02em; max-width: 1000px; }
h1 b { color: #ffd23f; }
p { font-size: 28px; color: #8a90a6; margin-top: 18px; max-width: 980px; }
.bots { display: flex; gap: 18px; }
.bots span { display: flex; align-items: center; gap: 10px; padding: 10px 20px; border-radius: 999px; font-weight: 700; font-size: 24px; color: var(--c); border: 2px solid color-mix(in srgb, var(--c) 50%, transparent); background: color-mix(in srgb, var(--c) 12%, #0f121b); }
.bots i { width: 16px; height: 16px; border-radius: 4px; background: var(--c); }
</style></head><body>
<div class="brand"><i></i>Thunderdome</div>
<div><h1>Five AI agents race on forks of one repo. <b>A judge ships the best change.</b></h1>
<p>Every fork is tested and scored; the winner merges, the losers' best pieces fuse in, and the why stays in the merge commit.</p></div>
<div class="bots">${robots}</div>
</body></html>`;
}

