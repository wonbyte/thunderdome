// The race gallery: every race from GET /tasks, newest first, each a link to watch or replay it.
// Server text only ever goes into textContent; innerHTML is only for sprites.ts art.
import { AGENT_IDS, colorFor, displayName, styleLabel, whyWithNames } from "./board";
import { raceStats, standings, teamPill, type DecidedBy, type Standing } from "./leaderboard";
import { coreSvg, crownSvg, robotSvg } from "./sprites";

interface RaceSummary {
  id: string;
  prompt: string;
  template?: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  judgedAt?: string;
  agents: string[];
  winner?: string | null;
  clash?: boolean;
  scores?: { agent: string; total: number }[];
  decidedBy?: DecidedBy;
  headline?: string;
  fused?: string[];
  losing?: Record<string, number>;
  team?: number;
}

const ID = /^t-[0-9a-f]{8}$/;
/** Finished races that show their result card; the rest skip it, so a fresh gallery draws few at once. */
const CARD_IMAGES = 12;
let cards = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function art(className: string, markup: string): HTMLElement {
  const node = el("div", className);
  node.innerHTML = markup; // sprites.ts output only
  return node;
}

function isRace(value: unknown): value is RaceSummary {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && ID.test(r.id) && typeof r.prompt === "string" && typeof r.status === "string" && Array.isArray(r.agents);
}

function ago(iso: string): string {
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(secs)) return "";
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
  if (secs < 129600) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

function duration(r: RaceSummary): string | undefined {
  const start = Date.parse(r.startedAt ?? "");
  const end = Date.parse(r.finishedAt ?? "");
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const secs = Math.round((end - start) / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function card(r: RaceSummary): HTMLElement {
  const ended = r.winner !== undefined;
  const link = el("a", `race ${ended ? "ended" : r.status}`);
  link.href = ended ? `/race/${r.id}?replay` : `/race/${r.id}`;
  const top = el("div", "race-top");
  const state = ended ? (r.winner === null ? "no winner" : "finished") : r.status === "running" ? "live" : r.status;
  top.append(el("span", `pill state-${state.replace(" ", "-")}`, state));
  if (r.clash === true) top.append(el("span", "pill clash", "clash"));
  if (r.decidedBy !== undefined) top.append(el("span", `pill decided-${r.decidedBy}`, decidedLabel(r.decidedBy)));
  if ((r.fused?.length ?? 0) > 0) top.append(el("span", "pill fused", "⚡ fused"));
  const team = teamPill(r.team);
  if (team !== undefined) {
    const pill = el("span", "pill fused team", team);
    pill.title = "the fused change's judge score minus the winner's alone";
    top.append(pill);
  }
  if (r.template !== undefined) top.append(el("span", "pill tpl", `demo: ${r.template.replace(/^thunderdome-/, "")}`));
  top.append(el("span", "when", ago(r.createdAt)));
  const prompt = el("p", "race-prompt", r.prompt);
  // The result card, drawn on its first request: only the newest finished races ask for one, and a
  // card that cannot be drawn (no verdict scores, the browser busy) leaves no gap.
  const image = ended && r.winner && cards < CARD_IMAGES ? el("img", "race-img") : undefined;
  if (image !== undefined) {
    cards += 1;
    image.src = `/race/${r.id}/card.png`;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.width = 1200;
    image.height = 630;
    image.addEventListener("error", () => image.remove());
  }
  const why = r.headline === undefined ? undefined : el("p", "race-why", whyWithNames(r.headline, [...r.agents, ...AGENT_IDS]));
  const lineup = el("div", "lineup");
  for (const agent of r.agents) {
    const fighter = el("div", agent === r.winner ? "fighter won" : ended ? "fighter lost" : "fighter");
    fighter.style.setProperty("--color", colorFor(agent));
    const bot = art("mini", robotSvg(colorFor(agent)));
    if (agent === r.winner) bot.append(art("mini-crown", crownSvg()));
    fighter.append(bot, el("span", undefined, displayName(agent)));
    // A loser whose files the fusion round shipped: it lost the race but its work is in main.
    if (r.fused?.includes(agent) === true) {
      fighter.classList.add("assisted");
      const assist = el("span", "assist-tag", "⚡ assist");
      assist.title = `${displayName(agent)}'s tests were fused into the winning change`;
      fighter.append(assist);
    }
    lineup.append(fighter);
  }
  const foot = el("div", "race-foot");
  const time = duration(r);
  foot.append(el("span", undefined, ended ? (r.winner ? `${displayName(r.winner)} won${time ? ` in ${time}` : ""}` : "no winner") : "in progress"));
  foot.append(el("span", "cta", ended ? "▶ replay" : "● watch live"));
  link.append(top, ...(image === undefined ? [] : [image]), prompt, ...(why === undefined ? [] : [why]), lineup, foot);
  return link;
}

function mmss(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function tile(value: string, label: string, extra?: HTMLElement): HTMLElement {
  const box = el("div", "stat");
  box.append(el("b", undefined, value), el("span", undefined, label));
  if (extra !== undefined) box.append(extra);
  return box;
}

function decidedLabel(by: DecidedBy): string {
  return by === "close" ? "close call" : by === "same" ? "same fix" : `by ${by}`;
}

function standingRow(s: Standing, i: number, top: number): HTMLElement {
  const row = el("li", `standing${i === 0 ? " first" : ""}`);
  row.style.setProperty("--color", s.color);
  row.style.setProperty("--i", String(i));
  const bot = art("mini", robotSvg(s.color));
  if (i === 0 && s.wins > 0) bot.append(art("mini-crown", crownSvg()));
  const who = el("div", "who");
  who.append(el("b", undefined, s.name));
  const style = styleLabel(s.agent);
  if (style !== undefined) who.append(el("span", "style", style));
  const bar = el("div", "wins-bar col-bar");
  const fill = el("i");
  fill.style.width = `${top === 0 ? 0 : (s.wins / top) * 100}%`;
  bar.append(fill);
  const wins = el("span", "wins", `${s.wins} win${s.wins === 1 ? "" : "s"}`);
  const rate = el("span", "rate col-rate", `${Math.round(s.winRate * 100)}% of ${s.races}`);
  const avg = el("span", "avg", s.avgScore === undefined ? "–" : s.avgScore.toFixed(1));
  avg.title = "average judge score";
  const assists = el("span", `assists${s.assists > 0 ? " some" : ""}`, s.assists > 0 ? `⚡ ${s.assists}` : "–");
  assists.title = `assists: races it lost, but its work was fused into the winner's change and shipped${s.losingLines > 0 ? ` (${s.losingLines} lines shipped while losing)` : ""}`;
  row.append(el("span", "rank", String(i + 1)), bot, who, bar, wins, rate, assists, avg);
  return row;
}

function renderBoard(races: RaceSummary[]): void {
  const rows = standings(races);
  const panel = document.getElementById("board");
  if (panel === null || rows.length === 0) return;
  const stats = raceStats(races);
  const tiles = [tile(String(stats.judged), stats.judged === 1 ? "race judged" : "races judged")];
  if (stats.mergeSeconds !== undefined) tiles.push(tile(mmss(stats.mergeSeconds), "start to merged, on average"));
  tiles.push(tile(`${Math.round(stats.fusedRate * 100)}%`, "shipped a loser's work too"));
  if (stats.losingLines > 0) tiles.push(tile(String(stats.losingLines), "lines shipped while losing"));
  if (stats.scoredFusions > 0) tiles.push(tile(`${stats.teamBeat} of ${stats.scoredFusions}`, "fusions beat the winner alone"));
  if (stats.avgSeconds !== undefined) tiles.push(tile(mmss(stats.avgSeconds), "robots at work, on average"));
  document.getElementById("stats")?.replaceChildren(...tiles);
  const top = Math.max(...rows.map((r) => r.wins));
  const head = el("li", "standing head");
  head.append(el("span"), el("span"), el("span", undefined, "agent"), el("span", "col-bar"), el("span", undefined, "wins"), el("span", "col-rate", "win rate"), el("span", undefined, "assists"), el("span", undefined, "avg"));
  document.getElementById("standings")?.replaceChildren(head, ...rows.map((r, i) => standingRow(r, i, top)));
  panel.hidden = false;
}

/** The race list, or undefined when it could not be read (then the page keeps what it shows). */
async function loadRaces(): Promise<RaceSummary[] | undefined> {
  try {
    const res = await fetch("/tasks", { headers: { accept: "application/json" } });
    const body: unknown = res.ok ? await res.json() : undefined;
    const raw = typeof body === "object" && body !== null ? (body as { races?: unknown }).races : undefined;
    return Array.isArray(raw) ? raw.filter(isRace) : undefined;
  } catch (error) {
    console.warn("GET /tasks failed", error);
    return undefined;
  }
}

/** How often the gallery rereads the list while a race may still change; the list is edge-cached 10 s. */
const REFRESH_MS = 15_000;
/** A race not judged this long after it was made has failed or stalled: it no longer keeps the page polling. */
const LIVE_FOR_MS = 30 * 60_000;

/** True while some race may still change: not judged, not failed, and made in the last half hour. */
function anyLive(races: RaceSummary[], now: number): boolean {
  return races.some((r) => r.winner === undefined && r.status !== "failed" && now - Date.parse(r.createdAt) < LIVE_FOR_MS);
}

let shownKey = "";

function draw(list: HTMLElement, races: RaceSummary[]): void {
  // A refresh that changed nothing leaves the cards (and their entrance animation) alone.
  const key = JSON.stringify(races);
  if (key === shownKey) return;
  shownKey = key;
  const count = document.getElementById("count");
  renderBoard(races);
  if (count !== null) count.textContent = races.length === 1 ? "1 race" : `${races.length} races`;
  cards = 0;
  list.replaceChildren(...(races.length === 0 ? [el("p", "empty", "No races yet.")] : races.map(card)));
}

async function main(): Promise<void> {
  const core = document.getElementById("hero-core");
  if (core !== null) core.innerHTML = coreSvg();
  const list = document.getElementById("races");
  if (list === null) return;
  let races = (await loadRaces()) ?? [];
  draw(list, races);
  // A race running when the page opened turns finished here, without a reload.
  while (anyLive(races, Date.now())) {
    await new Promise((resolve) => setTimeout(resolve, REFRESH_MS));
    races = (await loadRaces()) ?? races;
    draw(list, races);
  }
}

void main();
