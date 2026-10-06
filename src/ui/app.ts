// The race page: follows a race live (WebSocket) or replays a recorded one (?replay), and draws
// the board, the Cloudflare pipeline under it, the judging and the before/after compare.
// Server text only ever goes into textContent; innerHTML is only for sprites.ts art.
import { AGENT_IDS, applyEvent, applyScores, colorFor, styleLabel, bubbleFor, decidedLine, displayName, initBoard, PROGRESS_LABELS, PROGRESS_STEPS, progressOf, whyWithNames } from "./board";
import type { Action, Board, BoardEvent, Fighter, WireClaimBoard, WirePreview, WireScore, WireStep, WireMemory, WireTask } from "./board";
import { applyPlatform, emptyPlatform, formatMs, STAGE_INFO, STAGES } from "./platform";
import type { PlatformHit, PlatformState, Stage } from "./platform";
import { coreSvg, crownSvg, hammerSvg, robotSvg } from "./sprites";
import { openCommit } from "./commitdialog";
import { openDiff } from "./diffdialog";
import { assistsOf, FUSE_BAR, fusionView, type FuseOutcome, type FuseRow } from "./fusion";
import { fusionOf, gitGraph, mergeOf, pushDots, type PushDot } from "./gitgraph";
import { gitLog, type LogLine } from "./gitlog";
import { drawGraph } from "./graphview";
import { boardAt, buildTimeline, stepsAt } from "./timeline";
import type { TimedEvent, Timeline } from "./timeline";

const TASK_PATH = /^\/race\/(t-[0-9a-f]{8})$/;
const LOG_MAX = 40;
const STEP_PAGE = 500;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];
const SCORE_TRIES = 5;
const SCORE_WAIT_MS = 2000;
/** Look is a part only in races judged on the look of each preview; it scores 0 and stays hidden otherwise. */
const PARTS = ["tests", "taskFit", "clarity", "look", "claim"] as const;
type Part = (typeof PARTS)[number];
const PART_MAX: Record<Part, number> = { tests: 50, taskFit: 25, clarity: 15, look: 0, claim: 10 };
const LOOK_MAX: Record<Part, number> = { tests: 45, taskFit: 20, clarity: 10, look: 15, claim: 10 };
const PART_LABEL: Record<Part, string> = { tests: "tests", taskFit: "task fit", clarity: "clarity", look: "look", claim: "claims" };

/** A part's points, 0 for a part the race does not have. */
function partPoints(parts: { look?: number } & Record<Exclude<Part, "look">, number>, part: Part): number {
  return parts[part] ?? 0;
}

/** The parts a score shows and their maximums: look only when the race was judged on look. */
function scoreParts(parts: { look?: number }): { shown: Part[]; max: Record<Part, number> } {
  const looked = parts.look !== undefined;
  return { shown: PARTS.filter((p) => looked || p !== "look"), max: looked ? LOOK_MAX : PART_MAX };
}
const MOTES = 28;
const SPARKS = 6;
const CONFETTI = 14;
const TOAST_MS = 2600;
const TICKER_MAX = 3;
const TICKER_MS = 5200;
const SPEEDS = [1, 2, 4, 8];
/** The judging reveal: one part of the score per beat, then the winner. */
const REVEAL_LEAD_MS = 600;
const REVEAL_PART_MS = 1100;
/** When the winner shows: once every part of the race has filled. */
function revealWinnerMs(parts: readonly Part[]): number {
  return REVEAL_LEAD_MS + parts.length * REVEAL_PART_MS + 300;
}

/** The parts the reveal steps through: look only when the race was judged on look. */
function revealParts(b: Board): Part[] {
  return b.fighters.some((f) => f.score?.parts.look !== undefined) ? [...PARTS] : PARTS.filter((p) => p !== "look");
}
const WHY_TYPE_MS = 2200;

const LABELS: Record<Action, string> = {
  idle: "ready",
  think: "thinking",
  scan: "reading",
  hammer: "editing",
  charge: "testing",
  work: "working",
  flag: "claiming",
  clash: "clash!",
  push: "pushed",
  hurt: "error",
  finished: "finished",
  down: "down",
  won: "winner",
  lost: "out",
};

/** Moves that play once when they happen; the rest loop while they last. */
const ONE_SHOT: ReadonlySet<Action> = new Set(["push", "clash", "flag", "hurt"]);

interface BotView {
  root: HTMLElement;
  bubble: HTMLElement;
  bubbleText: HTMLElement;
  pips: HTMLElement;
  state: HTMLElement;
  meter: HTMLElement;
  segs: Record<Part, HTMLElement>;
  meterValue: HTMLElement;
  body: HTMLElement;
  /** "⚡ assist" on the nameplate of a loser whose files the fusion round shipped. */
  assist: HTMLElement;
  action?: Action;
  actionAt?: number;
  bubbleKey?: string;
  pipsKey?: string;
}
interface PreviewView { root: HTMLElement; frame: HTMLElement; host: HTMLElement; commit: HTMLElement; link: HTMLAnchorElement; iframe?: HTMLIFrameElement; shown?: string }
interface Slot { key: string; label: string; color?: string; preview?: WirePreview }
type Scored = Fighter & { score: NonNullable<Fighter["score"]> };

interface Replay {
  timeline: Timeline;
  steps: WireStep[];
  t: number;
  playing: boolean;
  speed: number;
  frame?: number;
  lastTick?: number;
}

const bots = new Map<string, BotView>();
const previews = new Map<string, PreviewView>();
let taskId = "";
let board: Board | undefined;
let log: WireStep[] = [];
let ranked: WireScore[] | undefined;
let scoresLoading = false;
let loading = false;
let stopped = false;
let pending: BoardEvent[] = [];
let platform: PlatformState = emptyPlatform();
let replay: Replay | undefined;
/** performance.now() when the judging reveal started; undefined when there is none to play. */
let revealStart: number | undefined;
let revealFrame: number | undefined;
/** armed: the verdict is in but the scores are not, so the result waits for the reveal. */
let revealArmed = false;
let botsKey = "";
let claimsKey = "";
let previewsKey = "";
let resultKey = "";
let logKey = "";
let logShown = new Set<number>();
let wipeKey = "";
let toastKey = "";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** The git graph: the whole recorded task (replay) or the pushes seen so far (live). */
let recorded: WireTask | undefined;
let liveDots: PushDot[] = [];
const endSeen = new Map<string, number>();
let graphKey = "";

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

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

function showMessage(text: string): void {
  const message = byId("message");
  message.textContent = text;
  message.hidden = false;
  if (board === undefined) byId("thunderdome").hidden = true;
}

function hideMessage(): void {
  byId("message").hidden = true;
  byId("thunderdome").hidden = false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The JSON body of a 2xx GET, else undefined (also on network errors). */
async function getJson(path: string): Promise<unknown> {
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Restarts a CSS animation class on an element. */
function kick(node: Element, className: string): void {
  node.classList.remove(className);
  void (node as HTMLElement).offsetWidth;
  node.classList.add(className);
}

/** The race clock: replay time in a replay, else now. */
function clock(): number {
  return replay?.t ?? Date.now();
}

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- start ----

function main(): void {
  byId("core-art").innerHTML = coreSvg();
  addMotes();
  buildPipeline();
  const id = TASK_PATH.exec(location.pathname)?.[1];
  if (id === undefined) {
    showMessage("This is not a race address. Open /race/<task id>.");
    return;
  }
  taskId = id;
  setInterval(() => {
    renderTimer();
    if (replay === undefined && board !== undefined) renderGraph(board);
  }, 250);
  window.addEventListener("resize", () => {
    if (board !== undefined) drawBeams(board);
  });
  setupWipe();
  if (new URLSearchParams(location.search).has("replay")) {
    void startReplay(id);
    return;
  }
  // load() marks itself loading at once, so early socket events wait for the board.
  void load(id);
  connect(id, 0);
}

/** Floating dust in the stage, so the page is never still. */
function addMotes(): void {
  const sky = document.querySelector(".motes");
  if (sky === null) return;
  for (let i = 0; i < MOTES; i++) {
    const mote = el("span");
    mote.style.left = `${(i * 37) % 100}%`;
    mote.style.animationDelay = `${-((i * 1.7) % 14)}s`;
    mote.style.animationDuration = `${10 + ((i * 13) % 9)}s`;
    mote.style.opacity = String(0.25 + ((i * 7) % 10) / 20);
    sky.append(mote);
  }
}

async function fetchRace(id: string): Promise<{ task: WireTask; steps: WireStep[]; claims: WireClaimBoard } | number> {
  // The three reads are independent, so they go out together.
  const [res, steps, raw] = await Promise.all([fetch(`/tasks/${id}`, { headers: { accept: "application/json" } }), loadSteps(id), getJson(`/tasks/${id}/claims`)]);
  if (!res.ok) return res.status;
  const task = (await res.json()) as WireTask;
  const claims: WireClaimBoard = isObject(raw) && Array.isArray(raw.active) && Array.isArray(raw.history) ? (raw as unknown as WireClaimBoard) : { active: [], history: [] };
  return { task, steps, claims };
}

function failMessage(status: number): string {
  return status === 404 ? "No race with this id." : `Could not load the race (HTTP ${status}).`;
}

/** Fetches the task, its steps and claims, then rebuilds the board. Events that arrive meanwhile wait. */
async function load(id: string): Promise<boolean> {
  loading = true;
  try {
    const race = await fetchRace(id);
    if (typeof race === "number") {
      if (board === undefined) {
        stopped = race === 404;
        showMessage(failMessage(race));
      }
      return false;
    }
    const now = Date.now();
    let next = initBoard(race.task, race.steps, race.claims, now);
    if (ranked !== undefined) next = applyScores(next, ranked);
    for (const event of pending) next = applyEvent(next, event, now);
    platform = platformOf(buildTimeline(race.task, race.steps, race.claims).events);
    recorded = race.task;
    liveDots = pushDots(race.task);
    addLog(race.steps);
    hideMessage();
    setBoard(next);
    renderPipeline([]);
    return true;
  } catch {
    if (board === undefined) showMessage("Could not load the race. Try again in a moment.");
    return false;
  } finally {
    loading = false;
    pending = [];
  }
}

/** Pages through the step log until `next` stops moving. */
async function loadSteps(id: string): Promise<WireStep[]> {
  const all: WireStep[] = [];
  let after = 0;
  for (;;) {
    const page = await getJson(`/tasks/${id}/steps?after=${after}&limit=${STEP_PAGE}`);
    if (!isObject(page) || !Array.isArray(page.steps)) break;
    all.push(...(page.steps as WireStep[]));
    if (typeof page.next !== "number" || page.next <= after) break;
    after = page.next;
  }
  return all;
}

/** Reconnects with backoff (1, 2, 4, 8, then 10 s); every reconnect refetches the board. */
function connect(id: string, attempt: number): void {
  if (stopped) return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/tasks/${id}/live`);
  let opened = false;
  socket.addEventListener("open", () => {
    opened = true;
    setLive("live");
    if (attempt > 0) void load(id);
  });
  socket.addEventListener("message", (message: MessageEvent) => onMessage(message.data));
  socket.addEventListener("close", () => {
    setLive("reconnecting");
    if (stopped) return;
    const step = opened ? 0 : Math.min(attempt, BACKOFF_MS.length - 1);
    setTimeout(() => connect(id, opened ? 1 : attempt + 1), BACKOFF_MS[step] ?? 10000);
  });
}

function setLive(state: "live" | "reconnecting" | "replay"): void {
  const live = byId("live");
  live.dataset.live = state === "live" ? "on" : state === "replay" ? "replay" : "off";
  live.textContent = state;
}

function parseEvent(data: unknown): BoardEvent | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const event: unknown = JSON.parse(data);
    return isObject(event) && typeof event.kind === "string" && typeof event.taskId === "string" ? (event as unknown as BoardEvent) : undefined;
  } catch {
    return undefined;
  }
}

function onMessage(data: unknown): void {
  const event = parseEvent(data);
  if (event === undefined) return;
  if (event.kind === "steps" && Array.isArray(event.steps)) addLog(event.steps);
  if (loading) {
    pending.push(event);
    return;
  }
  if (board === undefined) return;
  const now = Date.now();
  const before = board;
  if (event.kind === "verdict") armReveal();
  if (event.kind === "push") addLiveDot(event.agent, event.push, now);
  setBoard(applyEvent(board, event, now));
  happened(before, [{ at: now, event }], true);
}

/** Side effects of events that just happened: platform hits, beams, banners. */
function happened(before: Board, events: TimedEvent[], animate: boolean): void {
  const hits: PlatformHit[] = [];
  for (const { at, event } of events) {
    const out = applyPlatform(platform, event, at);
    platform = out.state;
    hits.push(...out.hits);
    if (!animate) continue;
    if (event.kind === "push") fireBeam(event.agent);
    if (event.kind === "claim" && event.result.ok) {
      const clash = event.result.clashes[0] ?? clashIn(before, event.agent, event.result.claimed);
      if (clash !== undefined) toast(`${displayName(event.agent)} vs ${clash.heldBy.map(displayName).join(" & ")}`, `clash on ${clash.file}`, "clash");
    }
  }
  renderPipeline(animate ? hits : []);
}

/** A replayed claim has no clash list; read it from who held the file before. */
function clashIn(before: Board, agent: string, files: string[]): { file: string; heldBy: string[] } | undefined {
  for (const file of files) {
    const heldBy = Object.keys(before.grid.cells[file] ?? {}).filter((a) => a !== agent);
    if (heldBy.length > 0) return { file, heldBy };
  }
  return undefined;
}

function platformOf(events: TimedEvent[]): PlatformState {
  let state = emptyPlatform();
  for (const { at, event } of events) state = applyPlatform(state, event, at).state;
  return state;
}

function setBoard(next: Board): void {
  board = next;
  render(next);
  if (next.ended && ranked === undefined && replay === undefined) void loadScores();
}

/** The judge may still be writing its output when the verdict lands, so retry a few times. */
async function loadScores(): Promise<void> {
  if (scoresLoading) return;
  scoresLoading = true;
  try {
    for (let i = 0; i < SCORE_TRIES; i++) {
      if (i > 0) await sleep(SCORE_WAIT_MS);
      const found = rankedOf(await getJson(`/tasks/${taskId}/judge`));
      if (found === undefined) continue;
      ranked = found;
      if (board !== undefined) {
        // Watched live to the end: play the judging. Opened after the end: show the result.
        if (revealArmed) startReveal();
        setBoard(applyScores(board, found));
      }
      return;
    }
    // No scores: show the verdict as it is.
    if (revealArmed) {
      stopReveal();
      if (board !== undefined) render(board);
    }
  } finally {
    scoresLoading = false;
  }
}

function rankedOf(body: unknown): WireScore[] | undefined {
  if (!isObject(body) || !isObject(body.output) || !isObject(body.output.scores)) return undefined;
  const list = body.output.scores.ranked;
  if (!Array.isArray(list)) return undefined;
  return list.filter(
    (item): item is WireScore => isObject(item) && typeof item.agent === "string" && typeof item.total === "number" && isObject(item.parts),
  );
}

function addLog(steps: WireStep[]): void {
  const seen = new Set(log.map((step) => step.seq));
  const fresh = steps.filter((step) => isObject(step) && typeof step.seq === "number" && !seen.has(step.seq));
  if (fresh.length === 0) return;
  log = [...log, ...fresh].toSorted((a, b) => a.seq - b.seq).slice(-LOG_MAX);
  if (board !== undefined) renderLog(board);
}

// ---- replay ----

async function startReplay(id: string): Promise<void> {
  setLive("replay");
  const race = await fetchRace(id).catch(() => 0);
  if (typeof race === "number") {
    showMessage(race === 0 ? "Could not load the race. Try again in a moment." : failMessage(race));
    return;
  }
  if (race.task.status !== "finished" && race.task.verdict === undefined) {
    // Nothing to replay yet: watch it live instead.
    location.replace(`/race/${id}`);
    return;
  }
  ranked = rankedOf(await getJson(`/tasks/${id}/judge`));
  recorded = race.task;
  const built = buildTimeline(race.task, race.steps, race.claims);
  // Start a moment before the run: the time between create and run is only waiting.
  const runAt = Date.parse(race.task.startedAt ?? "");
  const timeline = Number.isNaN(runAt) ? built : { ...built, start: Math.max(built.start, runAt - 1500) };
  replay = { timeline, steps: race.steps, t: timeline.start, playing: true, speed: 1 };
  hideMessage();
  setupReplayBar(timeline);
  seek(timeline.start, false);
  play(true);
}

function setupReplayBar(timeline: Timeline): void {
  const bar = byId("replay-bar");
  bar.hidden = false;
  const range = byId("replay-range") as HTMLInputElement;
  range.min = "0";
  range.max = String(timeline.end - timeline.start);
  range.step = "100";
  range.addEventListener("input", () => seek(timeline.start + Number(range.value), false));
  byId("replay-play").addEventListener("click", () => play(!(replay?.playing ?? false)));
  const speeds = byId("replay-speeds");
  speeds.replaceChildren(
    ...SPEEDS.map((speed) => {
      const button = el("button", speed === 1 ? "on" : undefined, `${speed}×`);
      button.type = "button";
      button.addEventListener("click", () => {
        if (replay === undefined) return;
        replay.speed = speed;
        for (const other of Array.from(speeds.children)) other.classList.toggle("on", other === button);
      });
      return button;
    }),
  );
  // Marks on the scrub bar: clashes, pushes and the verdict.
  const marks = byId("replay-marks");
  const span = Math.max(1, timeline.end - timeline.start);
  let held = boardAt(timeline, timeline.start);
  const items: HTMLElement[] = [];
  for (const { at, event } of timeline.events) {
    const before = held;
    held = applyEvent(held, event, at);
    let kind: string | undefined;
    if (event.kind === "push") kind = "push";
    if (event.kind === "verdict") kind = "verdict";
    if (event.kind === "claim" && event.result.ok && clashIn(before, event.agent, event.result.claimed) !== undefined) kind = "clash";
    if (kind === undefined) continue;
    const mark = el("i", `mark ${kind}`);
    mark.style.left = `${((at - timeline.start) / span) * 100}%`;
    mark.title = kind;
    items.push(mark);
  }
  marks.replaceChildren(...items);
}

function play(on: boolean): void {
  if (replay === undefined) return;
  if (on && replay.t >= replay.timeline.end) seek(replay.timeline.start, false);
  replay.playing = on;
  byId("replay-play").textContent = on ? "❚❚" : "▶";
  byId("replay-play").setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) {
    replay.lastTick = undefined;
    replay.frame = requestAnimationFrame(tick);
  } else if (replay.frame !== undefined) {
    cancelAnimationFrame(replay.frame);
  }
}

function tick(now: number): void {
  const r = replay;
  if (r === undefined || !r.playing) return;
  const dt = r.lastTick === undefined ? 0 : now - r.lastTick;
  r.lastTick = now;
  seek(Math.min(r.timeline.end, r.t + dt * r.speed), true);
  if (r.t >= r.timeline.end) {
    play(false);
    return;
  }
  r.frame = requestAnimationFrame(tick);
}

/** Moves the replay to time t. Playing forward animates what happened in between; a jump does not. */
function seek(t: number, animate: boolean): void {
  const r = replay;
  if (r === undefined) return;
  const from = r.t;
  r.t = t;
  const crossed = r.timeline.events.filter((e) => e.at > from && e.at <= t);
  const forward = animate && t >= from;
  if (!forward) {
    platform = platformOf(r.timeline.events.filter((e) => e.at <= t));
    stopReveal();
  }
  log = stepsAt(r.steps, t).slice(-LOG_MAX);
  const before = board ?? boardAt(r.timeline, from);
  let next = boardAt(r.timeline, t);
  if (next.ended && ranked !== undefined) next = applyScores(next, ranked);
  const verdictNow = forward && crossed.some((e) => e.event.kind === "verdict");
  if (verdictNow) startReveal();
  if (!next.ended) stopReveal();
  setBoard(next);
  if (forward) happened(before, crossed, true);
  else renderPipeline([]);
  const range = byId("replay-range") as HTMLInputElement;
  range.value = String(t - r.timeline.start);
  byId("replay-time").textContent = `${mmss(t - r.timeline.start)} / ${mmss(r.timeline.end - r.timeline.start)}`;
}

function mmss(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

// ---- judging reveal ----

/** The verdict arrived live: hold the result back until the scores can be revealed. */
function armReveal(): void {
  if (reducedMotion()) return;
  revealArmed = true;
  byId("stage").classList.add("revealing");
  byId("result-panel").classList.add("revealing");
}

function startReveal(): void {
  if (reducedMotion()) return;
  revealArmed = false;
  revealStart = performance.now();
  byId("stage").classList.add("revealing");
  byId("result-panel").classList.add("revealing");
  if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
  revealFrame = requestAnimationFrame(revealTick);
}

function stopReveal(): void {
  stopFusionAct();
  revealArmed = false;
  revealStart = undefined;
  byId("stage").classList.remove("revealing", "revealed");
  byId("result-panel").classList.remove("revealing");
  if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
  revealFrame = undefined;
}

/** 0..1 per part at `elapsed` ms into the reveal; all 1 when no reveal runs. */
function revealFractions(parts: readonly Part[], elapsed: number | undefined): Record<Part, number> {
  const out = { tests: 1, taskFit: 1, clarity: 1, look: 1, claim: 1 };
  if (elapsed === undefined) return out;
  parts.forEach((part, i) => {
    const start = REVEAL_LEAD_MS + i * REVEAL_PART_MS;
    out[part] = Math.min(1, Math.max(0, (elapsed - start) / (REVEAL_PART_MS * 0.8)));
  });
  return out;
}

function revealTick(): void {
  if (revealStart === undefined || board === undefined) return;
  const elapsed = performance.now() - revealStart;
  renderMeters(board, elapsed);
  const stage = byId("stage");
  const parts = revealParts(board);
  const part = parts[Math.min(parts.length - 1, Math.floor((elapsed - REVEAL_LEAD_MS) / REVEAL_PART_MS))];
  stage.dataset.part = elapsed < REVEAL_LEAD_MS || part === undefined ? "" : part;
  if (elapsed >= revealWinnerMs(parts)) {
    revealStart = undefined;
    stage.classList.remove("revealing");
    stage.classList.add("revealed");
    byId("result-panel").classList.remove("revealing");
    // Started before the render, so the assist tags wait for the act.
    playFusionAct(board);
    render(board);
    if (board.winner) fireBeam(board.winner);
    typeWhy();
    return;
  }
  revealFrame = requestAnimationFrame(revealTick);
}

/** The why types itself out once the winner is shown. */
function typeWhy(): void {
  const why = byId("why");
  const full = why.textContent ?? "";
  if (full === "" || reducedMotion()) return;
  const start = performance.now();
  const step = (): void => {
    const p = Math.min(1, (performance.now() - start) / WHY_TYPE_MS);
    why.textContent = full.slice(0, Math.ceil(full.length * p));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- rendering ----

function render(b: Board): void {
  renderHeader(b);
  renderBots(b);
  renderMeters(b, revealStart === undefined ? undefined : performance.now() - revealStart);
  drawBeams(b);
  renderGraph(b);
  renderBanner(b, revealStart === undefined && !revealArmed);
  renderClaims(b);
  renderPreviews(b);
  renderWipe(b);
  renderResult(b);
  renderFusion(b);
  renderLog(b);
  renderTimer();
}

/** A live push: one more dot, with the commits it added. */
function addLiveDot(agent: string, push: { commits: number; lastPushAt?: string; head?: string; headMessage?: string }, now: number): void {
  const before = liveDots.filter((d) => d.agent === agent).reduce((n, d) => n + d.commits, 0);
  const at = Date.parse(push.lastPushAt ?? "");
  const dot: PushDot = { agent, at: Number.isNaN(at) ? now : at, commits: Math.max(0, push.commits - before) };
  if (push.head !== undefined) dot.commit = push.head;
  if (push.headMessage !== undefined) dot.message = push.headMessage;
  liveDots = [...liveDots, dot];
}

const msOf = (iso: string | undefined): number | undefined => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? undefined : t;
};

function renderGraph(b: Board): void {
  const task = b.task;
  const start = msOf(task?.startedAt) ?? msOf(recorded?.startedAt);
  const panel = byId("graph-panel");
  if (task === undefined || start === undefined) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const agents = b.fighters.map((f) => f.agent);
  const ends: Record<string, number | undefined> = {};
  let input: Parameters<typeof gitGraph>[0];
  if (replay !== undefined && recorded !== undefined) {
    for (const slot of recorded.agents) ends[slot.name] = msOf(slot.endedAt);
    const merge = mergeOf(recorded);
    const fusion = fusionOf(recorded);
    input = { agents, start, ends, dots: pushDots(recorded), t: replay.t, domainEnd: Math.max(replay.timeline.end, merge?.at ?? 0), ...(merge ? { merge } : {}), ...(fusion ? { fusion } : {}) };
  } else {
    const now = Date.now();
    for (const f of b.fighters) {
      const slotEnd = msOf(recorded?.agents.find((s) => s.name === f.agent)?.endedAt);
      if (f.status === "done" || f.status === "failed" || f.status === "timeout") {
        if (!endSeen.has(f.agent)) endSeen.set(f.agent, slotEnd ?? now);
        ends[f.agent] = endSeen.get(f.agent);
      }
    }
    const merge = mergeOf(task);
    // Once judged, the graph stops at the merge instead of stretching with the clock.
    const t = b.ended ? (merge?.at ?? msOf(task.verdict?.judgedAt) ?? now) : now;
    const fusion = fusionOf(task);
    input = { agents, start, ends, dots: liveDots, t, domainEnd: t, ...(merge ? { merge } : {}), ...(fusion ? { fusion } : {}) };
  }
  const graph = gitGraph(input);
  // The log of main shows once the graph draws the merge (in a replay, once it reaches it).
  renderGitLog(graph.merge === undefined ? undefined : gitLog(replay !== undefined && recorded !== undefined ? recorded : task));
  const key = JSON.stringify(graph, (_k, v: unknown) => (typeof v === "number" ? Math.round(v * 400) : v));
  if (key === graphKey) return;
  graphKey = key;
  drawGraph(byId("graph"), graph, replay === undefined && !b.ended, (agent) => void openDiff(taskId, agent), (hash) => void openCommit(taskId, hash));
  const pushes = graph.lanes.reduce((n, l) => n + l.dots.length, 0);
  const fused = graph.fusion?.tries.filter((t) => t.added).length ?? 0;
  byId("graph-stat").textContent = `${graph.lanes.length} forks · ${pushes} push${pushes === 1 ? "" : "es"}${fused > 0 ? ` · ${fused} fused` : ""}${graph.merge ? " · 1 merge" : ""}`;
}

let gitLogKey = "";

/** `git log --graph main` under the graph: text only, the author column in each robot's color. */
function renderGitLog(lines: LogLine[] | undefined): void {
  const key = JSON.stringify(lines ?? null);
  if (key === gitLogKey) return;
  gitLogKey = key;
  byId("gitlog").hidden = lines === undefined;
  if (lines === undefined) return;
  byId("gitlog-lines").replaceChildren(
    ...lines.map((line) => {
      const item = el("li", line.sha === undefined && line.message === undefined ? "gl-row edge" : "gl-row");
      item.append(el("span", "gl-graph", line.graph));
      if (line.hash !== undefined) {
        const open = el("button", "gl-sha link", line.sha);
        open.type = "button";
        open.setAttribute("aria-label", `Open commit ${line.sha ?? ""}`);
        const hash = line.hash;
        open.addEventListener("click", () => void openCommit(taskId, hash));
        item.append(open);
      } else if (line.message !== undefined) {
        item.append(el("span", "gl-sha", line.sha ?? "·······"));
      }
      if (line.message !== undefined) item.append(el("span", "gl-msg", line.message));
      if (line.who !== undefined) {
        const who = el("span", "gl-who", line.who);
        who.style.setProperty("--color", line.color ?? "#8b8d98");
        item.append(who);
      }
      return item;
    }),
  );
}

/** What the robots were told about earlier races on this app. Rebuilt only when it changes. */
let memoryKey = "";
/** Earlier races in this race's memory, for the tag on each robot's nameplate. */
let memoryCount = 0;

function setMemoryTag(tag: HTMLElement, agent: string): void {
  tag.hidden = memoryCount === 0;
  tag.textContent = `◆ ${memoryCount}`;
  tag.title = `${displayName(agent)} remembers ${memoryCount} earlier race${memoryCount === 1 ? "" : "s"} on this app`;
}
function renderMemory(memory: WireMemory[] | undefined): void {
  const list = memory ?? [];
  const key = JSON.stringify(list);
  if (key === memoryKey) return;
  memoryKey = key;
  const box = byId("memory");
  box.hidden = list.length === 0;
  memoryCount = list.length;
  for (const [agent, view] of bots) {
    const tag = view.root.querySelector<HTMLElement>(".mem-tag");
    if (tag !== null) setMemoryTag(tag, agent);
  }
  const races = list.length === 1 ? "1 earlier race" : `${list.length} earlier races`;
  byId("memory-count").textContent = `The robots remember ${races} on this app`;
  byId("memory-list").replaceChildren(
    ...list.map((m) => {
      const card = el("li", "mem-card");
      card.style.setProperty("--color", colorFor(m.winner));
      const bot = art("mini", robotSvg(colorFor(m.winner)));
      bot.append(art("mini-crown", crownSvg()));
      const top = el("div", "mem-top");
      const replayLink = el("a", undefined, "replay ›");
      replayLink.href = `/race/${m.id}?replay`;
      top.append(el("b", undefined, `${displayName(m.winner)} won`), replayLink);
      const task = el("p", "mem-task", `“${m.prompt}”`);
      task.title = m.prompt;
      card.append(bot, top, task);
      // The winner's strongest point says more than the scoring headline, so it leads; the headline is the hover text.
      const why = m.lesson === undefined ? m.headline : `Won because ${m.lesson}.`;
      if (why !== undefined) card.append(el("p", "mem-lesson", whyWithNames(why, [m.winner, ...AGENT_IDS])));
      if (m.headline !== undefined) card.title = whyWithNames(m.headline, [m.winner, ...AGENT_IDS]);
      return card;
    }),
  );
}

function renderHeader(b: Board): void {
  const task = b.task;
  byId("prompt").textContent = task?.prompt ?? "";
  renderMemory(task?.memory);
  let status: string = task?.status ?? "unknown";
  if (b.ended) status = b.winner ? `won by ${displayName(b.winner)}` : "no winner";
  else if (task?.status === "finished") status = "judging";
  const pill = byId("status");
  pill.textContent = status;
  const state = b.ended ? "ended" : task?.status === "finished" ? "judging" : (task?.status ?? "unknown");
  pill.dataset.state = state;
  byId("stage").dataset.state = state;
  document.title = task ? `Thunderdome · ${status}` : "Thunderdome race";
  const replayLink = byId("replay-link") as HTMLAnchorElement;
  replayLink.hidden = replay !== undefined || !b.ended;
  replayLink.href = `/race/${b.taskId}?replay`;
}

function renderTimer(): void {
  const timer = document.getElementById("timer");
  if (timer === null) return;
  const task = board?.task;
  const start = task?.startedAt === undefined ? NaN : Date.parse(task.startedAt);
  if (Number.isNaN(start) || task?.status === "ready") {
    timer.textContent = "--:--";
    return;
  }
  const finished = task?.finishedAt === undefined ? NaN : Date.parse(task.finishedAt);
  const end = Number.isNaN(finished) ? clock() : Math.min(finished, clock());
  timer.textContent = mmss(end - start);
  timer.dataset.running = Number.isNaN(finished) || clock() < finished ? "yes" : "no";
}

/** Robots stand in a row across the front of the stage, facing the core. */
function botX(index: number, count: number): number {
  const span = count <= 3 ? 64 : 80;
  return 50 - span / 2 + (span * (index + 0.5)) / count;
}

function renderBots(b: Board): void {
  const row = byId("bots");
  const key = b.fighters.map((f) => f.agent).join("\n");
  if (key !== botsKey) {
    botsKey = key;
    for (const agent of bots.keys()) if (!b.fighters.some((f) => f.agent === agent)) bots.delete(agent);
    row.replaceChildren(...b.fighters.map((f, i) => botView(f, i).root));
  }
  b.fighters.forEach((f, i) => updateBot(b, f, i));
}

/** The Thunderdome mascot, perched on a robot's head while it claims or pushes. */
function mascot(): HTMLElement {
  const img = el("img", "fx-mascot");
  img.src = "/mascot.svg";
  img.alt = "";
  img.decoding = "async";
  return img;
}

function botView(f: Fighter, index: number): BotView {
  const existing = bots.get(f.agent);
  if (existing !== undefined) return existing;
  const root = el("div", "bot");
  root.style.setProperty("--color", f.color);
  root.style.setProperty("--i", String(index));
  const bubble = el("div", "bubble");
  const bubbleText = el("span", "bubble-text");
  bubble.append(el("span", "bubble-dot"), bubbleText);
  const body = el("div", "body");
  const fx = el("div", "fx");
  fx.append(
    el("div", "fx-spot"),
    el("div", "fx-ring"),
    el("div", "fx-ring fx-ring-2"),
    el("div", "fx-scan"),
    art("fx-hammer", hammerSvg()),
    mascot(),
    art("fx-crown", crownSvg()),
  );
  const sparks = el("div", "fx-sparks");
  for (let i = 0; i < SPARKS; i++) sparks.append(el("span"));
  const confetti = el("div", "fx-confetti");
  for (let i = 0; i < CONFETTI; i++) {
    const bit = el("span");
    bit.style.setProperty("--k", String(i));
    confetti.append(bit);
  }
  const smoke = el("div", "fx-smoke");
  for (let i = 0; i < 3; i++) smoke.append(el("span"));
  fx.append(sparks, confetti, smoke);
  const sprite = art("sprite", robotSvg(f.color));
  body.append(el("div", "aura"), sprite, fx);
  // The score tower beside the robot, filled part by part when the judge reports.
  const meter = el("div", "meter");
  const stack = el("div", "meter-stack");
  const segs = {} as Record<Part, HTMLElement>;
  for (const part of PARTS) {
    const seg = el("i", `part-${part}`);
    segs[part] = seg;
    stack.append(seg);
  }
  const meterValue = el("b", "meter-value");
  meter.append(meterValue, stack);
  body.append(meter);
  const plate = el("div", "plate");
  plate.append(el("span", "name", displayName(f.agent)));
  const style = styleLabel(f.agent);
  if (style !== undefined) plate.append(el("span", "style", style));
  const tag = el("span", "mem-tag");
  setMemoryTag(tag, f.agent);
  const assist = el("span", "assist-tag", "⚡ assist");
  assist.title = `${displayName(f.agent)}'s tests were fused into the winning change`;
  assist.hidden = true;
  plate.append(tag, assist);
  const pips = el("span", "pips");
  const state = el("span", "state");
  const meta = el("div", "meta");
  meta.append(pips, state);
  root.append(bubble, el("div", "shadow"), body, plate, meta);
  root.tabIndex = 0;
  root.setAttribute("role", "button");
  root.setAttribute("aria-label", `${displayName(f.agent)}: see the code`);
  root.title = `See ${displayName(f.agent)}'s code`;
  root.addEventListener("click", () => void openDiff(taskId, f.agent));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void openDiff(taskId, f.agent);
    }
  });
  const view: BotView = { root, bubble, bubbleText, pips, state, meter, segs, meterValue, body, assist };
  bots.set(f.agent, view);
  return view;
}

function updateBot(b: Board, f: Fighter, index: number): void {
  const view = botView(f, index);
  const root = view.root;
  root.style.left = `${botX(index, b.fighters.length)}%`;
  // A clash lunges toward the middle of the stage.
  root.style.setProperty("--lunge", botX(index, b.fighters.length) < 50 ? "1" : "-1");
  if (view.action !== f.action) {
    if (view.action !== undefined) root.classList.remove(`act-${view.action}`);
    root.classList.add(`act-${f.action}`);
    view.action = f.action;
  }
  if (view.actionAt !== f.actionAt) {
    view.actionAt = f.actionAt;
    if (ONE_SHOT.has(f.action)) kick(root, "kick");
  }
  root.dataset.status = f.status;
  // Held back while the fusion act plays, so the tag lands with the file.
  view.assist.hidden = !(b.ended && fusionActDone && b.task !== undefined && assistsOf(b.task).includes(f.agent));
  root.classList.toggle("clashing", f.clashFile !== undefined && !b.ended);
  const bubble = bubbleOf(b, f);
  if (bubble !== view.bubbleKey) {
    view.bubbleKey = bubble;
    view.bubbleText.textContent = bubble;
    kick(view.bubble, "pop");
  }
  // One square per step of the race; the winner's bar fills completely.
  const reached = progressOf(b, f);
  const key = PROGRESS_STEPS.map((step) => (reached.has(step) ? "1" : "0")).join("");
  if (key !== view.pipsKey) {
    const before = view.pipsKey;
    view.pipsKey = key;
    view.pips.replaceChildren(...PROGRESS_STEPS.map((step, i) => {
      // Only a square that just lit up pops; the others were already on.
      const lit = reached.has(step);
      const pip = el("i", lit ? (before !== undefined && before[i] !== "1" ? "on new" : "on") : undefined);
      pip.title = PROGRESS_LABELS[step];
      pip.style.setProperty("--i", String(i));
      return pip;
    }));
    view.pips.classList.toggle("full", reached.size === PROGRESS_STEPS.length);
  }
  const done = PROGRESS_STEPS.filter((step) => reached.has(step)).map((step) => PROGRESS_LABELS[step]);
  view.pips.setAttribute("aria-label", done.length === 0 ? "not started" : done.join(", "));
  view.state.textContent = f.score === undefined ? LABELS[f.action] : `#${f.score.place}`;
  root.setAttribute("aria-label", `${displayName(f.agent)}: ${LABELS[f.action]}, ${f.commits} commits`);
}

function renderMeters(b: Board, elapsed: number | undefined): void {
  const fractions = revealFractions(revealParts(b), elapsed);
  for (const f of b.fighters) {
    const view = bots.get(f.agent);
    if (view === undefined) continue;
    view.meter.hidden = f.score === undefined;
    if (f.score === undefined) continue;
    let total = 0;
    for (const part of PARTS) {
      const points = partPoints(f.score.parts, part) * fractions[part];
      total += points;
      view.segs[part].style.height = `${points}%`;
    }
    view.meterValue.textContent = total.toFixed(1);
  }
}

function bubbleOf(b: Board, f: Fighter): string {
  if (b.ended) return f.action === "won" ? "I win!" : f.action === "down" ? "…" : "good race";
  if (b.task?.status === "finished") return "waiting for the judge";
  if (f.status === "done") return "done ✓";
  if (f.status === "failed" || f.status === "timeout") return f.status === "timeout" ? "out of time" : "crashed";
  return f.bubble ?? (f.status === "running" ? "warming up" : "waiting");
}

/** One curved beam from each robot to the core. It runs while the robot works. */
function drawBeams(b: Board): void {
  const stage = byId("stage");
  const svg = byId("beams");
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const core = byId("core");
  const cx = core.offsetLeft + core.offsetWidth / 2;
  const cy = core.offsetTop + core.offsetHeight * 0.42;
  const existing = new Map<string, SVGPathElement>();
  for (const path of Array.from(svg.querySelectorAll<SVGPathElement>("path"))) existing.set(path.dataset.agent ?? "", path);
  b.fighters.forEach((f, i) => {
    const x = (botX(i, b.fighters.length) / 100) * width;
    const y = height - 150;
    let path = existing.get(f.agent);
    if (path === undefined) {
      path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.dataset.agent = f.agent;
      path.setAttribute("class", "beam");
      path.style.setProperty("--color", f.color);
      svg.append(path);
    }
    existing.delete(f.agent);
    const mx = (x + cx) / 2;
    const my = Math.min(y, cy) - 30;
    path.setAttribute("d", `M ${x.toFixed(1)} ${y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)}`);
    path.classList.toggle("on", !b.ended && f.status === "running");
    path.classList.toggle("won", f.action === "won");
  });
  for (const stale of existing.values()) stale.remove();
}

/** A push sends a bright pulse up the robot's beam into the core. */
function fireBeam(agent: string): void {
  const path = document.querySelector<SVGPathElement>(`#beams path[data-agent="${CSS.escape(agent)}"]`);
  if (path !== null) {
    path.classList.remove("fire");
    void path.getBoundingClientRect();
    path.classList.add("fire");
  }
  kick(byId("core"), "hit");
}

/** One added fusion: whose files joined the winner's fix. */
interface Fused { agent: string; files: string[] }

function toast(title: string, detail: string, kind: string, note?: string, fused: Fused[] = []): void {
  const key = `${title}|${detail}|${note ?? ""}|${JSON.stringify(fused)}`;
  if (key === toastKey) return;
  toastKey = key;
  const banner = byId("banner");
  banner.dataset.kind = kind;
  banner.replaceChildren(el("strong", undefined, title), el("span", undefined, detail));
  if (note !== undefined) banner.append(el("em", undefined, note));
  if (fused.length > 0) {
    const row = el("div", "fused");
    row.append(el("b", undefined, "⚡ Fused in"));
    for (const f of fused) {
      const chip = el("span", "fused-chip", `${displayName(f.agent)}'s ${f.files.join(", ")}`);
      chip.style.setProperty("--color", colorFor(f.agent));
      row.append(chip);
    }
    banner.append(row);
  }
  banner.hidden = false;
  kick(banner, "show");
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (board?.ended !== true && board?.task?.status !== "finished") banner.hidden = true;
  }, TOAST_MS);
}

/** Judging while the judge runs; the winner once it has spoken (after the reveal, when one plays). */
function renderBanner(b: Board, final: boolean): void {
  const banner = byId("banner");
  if (!b.ended) {
    if (b.task?.status === "finished") {
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toast("Judging", "tests in every fork · Clef scores each diff", "judge");
    } else if (banner.dataset.kind === "judge" || banner.dataset.kind === "win" || banner.dataset.kind === "none") {
      banner.hidden = true;
      toastKey = "";
    }
    return;
  }
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  if (!final) {
    toast("The judge's scores", "tests · task fit · clarity · claims", "judge");
    return;
  }
  const winner = b.fighters.find((f) => f.agent === b.winner);
  if (winner !== undefined) {
    banner.style.setProperty("--color", winner.color);
    const ship = b.task?.verdict?.ship;
    const merged = ship?.status === "merged" && ship.commit !== undefined ? ` · merged ${ship.commit.slice(0, 7)}` : "";
    const detail = winner.score === undefined ? `the judge has spoken${merged}` : `${winner.score.total.toFixed(2)} / 100${merged}`;
    const decided = decidedLine(b.why);
    // Only a fusion that reached the merge counts: the ship merges the winner's fork with it.
    const fused = ship?.status === "merged" ? (b.task?.verdict?.fusion?.tried ?? []).filter((t) => t.status === "added") : [];
    toast(
      `${displayName(winner.agent)} wins`,
      detail,
      "win",
      decided === undefined ? undefined : whyWithNames(decided, b.fighters.map((f) => f.agent)),
      fused.map(({ agent, files }) => ({ agent, files })),
    );
  } else {
    toast("No winner", "no fork passed", "none");
  }
}

// ---- the Cloudflare pipeline ----
// Each product is a small server unit: an LCD count, activity LEDs, a fan and a terminal line.
// A hit sends a packet along the bus from the stage before it, then the unit works for a moment.

interface StageView { root: HTMLElement; count: HTMLElement; line: HTMLElement; text: string; busy?: ReturnType<typeof setTimeout> }
const stageViews = new Map<Stage, StageView>();
const BUSY_MS = 3_200;
const PACKET_MS = 650;
const TYPE_MS = 18; // per character
const LEDS = 4;

const svgNs = "http://www.w3.org/2000/svg";

/** A four-blade fan; CSS spins it. */
function fanSvg(): SVGSVGElement {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "-10 -10 20 20");
  svg.setAttribute("class", "fan");
  svg.setAttribute("aria-hidden", "true");
  const ring = document.createElementNS(svgNs, "circle");
  ring.setAttribute("r", "9");
  ring.setAttribute("class", "fan-ring");
  svg.append(ring);
  const blades = document.createElementNS(svgNs, "g");
  blades.setAttribute("class", "fan-blades");
  for (let i = 0; i < 4; i++) {
    const blade = document.createElementNS(svgNs, "path");
    blade.setAttribute("d", "M0 0 C2 -3 2 -7 0 -7.5 C-2.5 -7 -2 -3 0 0 Z");
    blade.setAttribute("transform", `rotate(${i * 90})`);
    blades.append(blade);
  }
  const hub = document.createElementNS(svgNs, "circle");
  hub.setAttribute("r", "1.8");
  hub.setAttribute("class", "fan-hub");
  svg.append(blades, hub);
  return svg;
}

function buildPipeline(): void {
  const list = byId("pipeline");
  list.replaceChildren(
    ...STAGES.map((stage, i) => {
      const item = el("li", "unit");
      item.dataset.stage = stage;
      item.style.setProperty("--n", String(i));
      const info = STAGE_INFO[stage];
      const top = el("div", "unit-top");
      const count = el("span", "count lcd", "00");
      top.append(el("span", "product", info.product), count);
      const face = el("div", "unit-face");
      const leds = el("span", "leds");
      leds.append(el("i", "led power"));
      for (let k = 1; k < LEDS; k++) {
        const led = el("i", "led act");
        led.style.setProperty("--k", String(k));
        leds.append(led);
      }
      face.append(leds, el("span", "vents"), fanSvg());
      const screen = el("div", "screen");
      const line = el("span", "line", info.role);
      screen.append(el("span", "prompt", ">"), line, el("span", "caret"));
      item.append(top, face, screen);
      stageViews.set(stage, { root: item, count, line, text: info.role });
      return item;
    }),
  );
}

/** Types a new terminal line; an older typing is cut short by the newer one. */
function typeLine(view: StageView, text: string): void {
  if (text === view.text) return;
  view.text = text;
  if (reducedMotion()) {
    view.line.textContent = text;
    return;
  }
  const start = performance.now();
  const step = (): void => {
    if (view.text !== text) return;
    const n = Math.min(text.length, Math.ceil((performance.now() - start) / TYPE_MS));
    view.line.textContent = text.slice(0, n);
    if (n < text.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The unit works for a moment: fast fan, flickering LEDs. */
function setBusy(view: StageView): void {
  view.root.classList.add("busy");
  if (view.busy !== undefined) clearTimeout(view.busy);
  view.busy = setTimeout(() => view.root.classList.remove("busy"), BUSY_MS);
}

/** The bus y under a unit, and the x of its center, in the pipeline's coordinates. */
function busY(n: HTMLElement): number {
  return n.offsetTop + n.offsetHeight + 7;
}

function busX(n: HTMLElement): number {
  return n.offsetLeft + n.offsetWidth / 2;
}

/** A packet along the bus from the stage before (or the bus start) into this unit. */
function sendPacket(stage: Stage): void {
  if (reducedMotion()) return;
  const list = byId("pipeline");
  const to = stageViews.get(stage)?.root;
  if (to === undefined || to.offsetParent === null) return;
  const index = STAGES.indexOf(stage);
  const before = STAGES[index - 1];
  const from = before === undefined ? undefined : stageViews.get(before)?.root;
  const startX = from === undefined ? 0 : busX(from);
  const startY = from === undefined ? busY(to) : busY(from);
  const packet = el("i", "packet");
  list.append(packet);
  const anim = packet.animate(
    [
      { transform: `translate(${startX}px, ${startY}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${startX}px, ${startY}px) scale(1)`, opacity: 1, offset: 0.1 },
      { transform: `translate(${busX(to)}px, ${busY(to)}px) scale(1)`, opacity: 1, offset: 0.85 },
      { transform: `translate(${busX(to)}px, ${busY(to) - 10}px) scale(.4)`, opacity: 0 },
    ],
    { duration: PACKET_MS, easing: "cubic-bezier(.5,0,.3,1)" },
  );
  anim.onfinish = () => packet.remove();
}

function renderPipeline(hits: PlatformHit[]): void {
  for (const stage of STAGES) {
    const view = stageViews.get(stage);
    if (view === undefined) continue;
    const count = platform.counts[stage];
    view.count.textContent = String(Math.min(count, 99)).padStart(2, "0");
    view.root.classList.toggle("used", count > 0);
    // Seeking back can power a unit down while it still works; it stops at once.
    if (count === 0 && view.busy !== undefined) {
      clearTimeout(view.busy);
      view.busy = undefined;
      view.root.classList.remove("busy");
    }
    const last = platform.last[stage];
    typeLine(view, last === undefined ? STAGE_INFO[stage].role : `${last.text}${last.ms === undefined ? "" : ` · ${formatMs(last.ms)}`}`);
  }
  for (const h of hits) {
    const view = stageViews.get(h.stage);
    if (view !== undefined) {
      sendPacket(h.stage);
      // The unit lights up as the packet lands.
      setTimeout(() => {
        if (!view.root.classList.contains("used")) return; // a seek back powered it down meanwhile
        kick(view.root, "ping");
        setBusy(view);
      }, reducedMotion() ? 0 : PACKET_MS * 0.8);
    }
    addTicker(h);
  }
}

/** The newest platform events, as chips in the stage corner. */
function addTicker(h: PlatformHit): void {
  const ticker = byId("ticker");
  const chip = el("li", "tick");
  chip.dataset.stage = h.stage;
  chip.append(el("b", undefined, STAGE_INFO[h.stage].product), el("span", undefined, h.text));
  if (h.ms !== undefined) chip.append(el("em", undefined, formatMs(h.ms)));
  ticker.prepend(chip);
  while (ticker.children.length > TICKER_MAX) ticker.lastElementChild?.remove();
  setTimeout(() => chip.classList.add("gone"), TICKER_MS);
  setTimeout(() => chip.remove(), TICKER_MS + 600);
}

// ---- panels ----

function renderClaims(b: Board): void {
  const key = JSON.stringify([b.claimed, b.grid.cells, b.fighters.map((f) => f.agent)]);
  if (key === claimsKey) return;
  claimsKey = key;
  const box = byId("claims");
  if (b.claimed.files.length === 0) {
    box.replaceChildren(el("p", "empty", "No claims yet."));
    return;
  }
  const clashes = new Set(b.claimed.clashes);
  const files = b.claimed.files.toSorted((x, y) => Number(clashes.has(y)) - Number(clashes.has(x)) || x.localeCompare(y));
  const list = el("ul", "claim-list");
  for (const file of files) {
    const item = el("li", clashes.has(file) ? "claim clash" : "claim");
    const slash = file.lastIndexOf("/");
    const path = el("span", "path");
    if (slash >= 0) path.append(el("span", "dir", file.slice(0, slash + 1)));
    path.append(el("span", "file", file.slice(slash + 1)));
    const holders = el("span", "holders");
    for (const f of b.fighters) {
      const cell = b.claimed.cells[file]?.[f.agent];
      if (cell === undefined) continue;
      const held = b.grid.cells[file]?.[f.agent] !== undefined;
      const chip = el("span", `chip ${cell}${held ? " held" : ""}`, displayName(f.agent));
      chip.style.setProperty("--color", f.color);
      chip.title = `${displayName(f.agent)}: ${cell === "shared" ? "shared claim" : "claimed first"}${held ? "" : " (released)"}`;
      holders.append(chip);
    }
    item.append(path);
    if (clashes.has(file)) item.append(el("span", "tag", "clash"));
    item.append(holders);
    list.append(item);
  }
  box.replaceChildren(list);
}

function renderPreviews(b: Board): void {
  const slots: Slot[] = [
    { key: "base", label: "Before", ...(b.basePreview === undefined ? {} : { preview: b.basePreview }) },
    ...b.fighters.map((f) => ({ key: `agent:${f.agent}`, label: displayName(f.agent), color: f.color, ...(f.preview === undefined ? {} : { preview: f.preview }) })),
  ];
  const views = slots.map(previewView);
  const key = slots.map((slot) => slot.key).join("\n");
  if (key !== previewsKey) {
    previewsKey = key;
    byId("previews").replaceChildren(...views.map((view) => view.root));
  }
  slots.forEach((slot, i) => {
    const view = views[i];
    if (view !== undefined) updatePreview(view, slot, b.ended && b.winner === slot.key.slice("agent:".length));
  });
}

function previewView(slot: Slot): PreviewView {
  const existing = previews.get(slot.key);
  if (existing !== undefined) return existing;
  const root = el("figure", slot.key === "base" ? "preview base" : "preview");
  if (slot.color !== undefined) root.style.setProperty("--color", slot.color);
  const bar = el("div", "chrome");
  const dots = el("span", "dots");
  dots.append(el("i"), el("i"), el("i"));
  const host = el("span", "host", "waiting for a push…");
  const commit = el("span", "commit");
  bar.append(dots, host, commit);
  const frame = el("div", "frame");
  frame.append(skeleton());
  const caption = el("figcaption");
  caption.append(el("span", "who", slot.label));
  const link = el("a", "open");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "open ↗";
  link.hidden = true;
  caption.append(link);
  root.append(caption, bar, frame);
  const view: PreviewView = { root, frame, host, commit, link };
  previews.set(slot.key, view);
  return view;
}

function skeleton(): HTMLElement {
  const box = el("div", "skeleton");
  for (let i = 0; i < 4; i++) box.append(el("span"));
  return box;
}

/** Only https URLs are shown; a new commit reloads the frame. A replay can go back to no preview. */
function updatePreview(view: PreviewView, slot: Slot, winner: boolean): void {
  view.root.classList.toggle("winner", winner);
  const preview = slot.preview;
  const url = preview === undefined ? undefined : httpsUrl(preview.url);
  if (preview === undefined || url === undefined) {
    if (view.shown !== undefined) {
      view.shown = undefined;
      delete view.iframe;
      view.frame.replaceChildren(skeleton());
      view.host.textContent = "waiting for a push…";
      view.commit.textContent = "";
      view.link.hidden = true;
    }
    return;
  }
  if (view.shown === preview.commit) return;
  const first = view.shown === undefined;
  view.shown = preview.commit;
  let iframe = view.iframe;
  if (iframe === undefined) {
    iframe = frameFor(`Preview: ${slot.label}`);
    view.iframe = iframe;
    view.frame.replaceChildren(iframe);
  }
  iframe.src = url;
  view.host.textContent = new URL(url).host;
  view.commit.textContent = preview.commit.slice(0, 7);
  view.link.href = url;
  view.link.hidden = false;
  if (!first) kick(view.root, "updated");
}

function frameFor(title: string): HTMLIFrameElement {
  const iframe = el("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
  iframe.title = title;
  iframe.tabIndex = -1;
  return iframe;
}

function httpsUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

// ---- before / after ----

const FLIP_MS = 2000;
const PAGE_WIDTH = 800; // the width each page is laid out at, then scaled to fit its frame
let flipTimer: ReturnType<typeof setInterval> | undefined;
let flipPaused = false;
const frameSizer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fitFrames);

/**
 * Each page renders at least PAGE_WIDTH wide and is scaled down to its frame, so it looks like a real
 * page. A frame wider than that (the flip view) renders the page at its own width, so it fills it.
 */
function fitFrames(entries: ResizeObserverEntry[]): void {
  for (const entry of entries) {
    const box = entry.target as HTMLElement;
    const width = entry.contentRect.width;
    const page = Math.max(PAGE_WIDTH, width);
    box.style.setProperty("--pw", `${page}px`);
    box.style.setProperty("--s", String(width / page));
  }
}

function setupWipe(): void {
  const modes = byId("compare-modes");
  for (const button of Array.from(modes.querySelectorAll("button"))) {
    button.addEventListener("click", () => setCompareMode(button.dataset.mode === "flip" ? "flip" : "side"));
  }
  const compare = byId("compare");
  compare.addEventListener("mouseenter", () => (flipPaused = true));
  compare.addEventListener("mouseleave", () => (flipPaused = false));
  for (const id of ["cmp-before", "cmp-after"]) frameSizer?.observe(byId(id));
}

/** Side by side shows both; flip stacks them and swaps every FLIP_MS (paused while hovered). */
function setCompareMode(mode: "side" | "flip"): void {
  const compare = byId("compare");
  compare.dataset.mode = mode;
  for (const button of Array.from(byId("compare-modes").querySelectorAll("button"))) {
    const on = button.dataset.mode === mode;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
  }
  if (flipTimer !== undefined) clearInterval(flipTimer);
  flipTimer = undefined;
  compare.classList.remove("show-before");
  if (mode !== "flip") return;
  compare.classList.add("show-before");
  flipTimer = setInterval(() => {
    if (!flipPaused) compare.classList.toggle("show-before");
  }, FLIP_MS);
}

/** The base preview next to the winner's. */
function renderWipe(b: Board): void {
  const winner = b.fighters.find((f) => f.agent === b.winner);
  const before = b.basePreview === undefined ? undefined : httpsUrl(b.basePreview.url);
  const after = winner?.preview === undefined ? undefined : httpsUrl(winner.preview.url);
  const box = byId("wipe-panel");
  const revealing = revealArmed || revealStart !== undefined;
  const ready = b.ended && !revealing && before !== undefined && after !== undefined && winner !== undefined;
  box.hidden = !ready;
  if (!ready) {
    wipeKey = "";
    return;
  }
  const key = `${before}|${after}`;
  if (key === wipeKey) return;
  wipeKey = key;
  box.style.setProperty("--color", winner.color);
  byId("cmp-after-tag").textContent = `After · ${displayName(winner.agent)}`;
  const ship = b.task?.verdict?.ship;
  byId("cmp-after-sub").textContent = ship?.status === "merged" && ship.commit ? `merged as ${ship.commit.slice(0, 7)}` : "the winning fork";
  const beforeFrame = frameFor("Before");
  beforeFrame.src = before;
  const afterFrame = frameFor(`After: ${displayName(winner.agent)}`);
  afterFrame.src = after;
  byId("cmp-before").replaceChildren(beforeFrame);
  byId("cmp-after").replaceChildren(afterFrame);
  // A sheen sweeps over the new page once, so the eye lands on it.
  kick(byId("compare"), "fresh");
}

function renderResult(b: Board): void {
  const scored = b.fighters.filter((f): f is Scored => f.score !== undefined).toSorted((x, y) => x.score.place - y.score.place);
  const key = JSON.stringify([b.ended, b.winner, b.why, scored.map((f) => [f.agent, f.score])]);
  if (key === resultKey) return;
  resultKey = key;
  byId("result-panel").hidden = !b.ended && scored.length === 0;
  byId("winner").textContent = b.winner ? displayName(b.winner) : "no winner";
  const decided = decidedLine(b.why);
  const decidedBox = byId("decided");
  decidedBox.hidden = decided === undefined;
  decidedBox.textContent = decided === undefined ? "" : whyWithNames(decided, b.fighters.map((f) => f.agent));
  byId("why").textContent = whyWithNames(b.why ?? "", b.fighters.map((f) => f.agent));
  // Podium order: 2nd, 1st, 3rd.
  const top = [scored[1], scored[0], scored[2]].filter((f): f is Scored => f !== undefined);
  byId("podium").replaceChildren(...top.map(podiumStep));
  byId("scoreboard").replaceChildren(...scored.map(scoreRow));
  byId("legend-look").hidden = !scored.some((f) => f.score.parts.look !== undefined);
}

function podiumStep(f: Scored): HTMLElement {
  const step = el("div", `step place-${f.score.place}`);
  step.style.setProperty("--color", f.color);
  const bot = art("podium-bot", robotSvg(f.color));
  if (f.score.place === 1) bot.append(art("podium-crown", crownSvg()));
  const block = el("div", "block");
  block.append(el("span", "place", String(f.score.place)), el("span", "pname", displayName(f.agent)), el("span", "total", f.score.total.toFixed(2)));
  step.append(bot, block);
  return step;
}

/** One stacked bar per robot; each part's width is its points out of 100. */
function scoreRow(f: Scored): HTMLElement {
  const row = el("li", "score-row");
  row.style.setProperty("--color", f.color);
  const name = el("span", "score-name");
  name.append(el("b", undefined, String(f.score.place)), document.createTextNode(` ${displayName(f.agent)}`));
  const bar = el("span", "bar");
  bar.setAttribute("role", "img");
  const { shown, max } = scoreParts(f.score.parts);
  bar.setAttribute("aria-label", shown.map((part) => `${PART_LABEL[part]} ${partPoints(f.score.parts, part)} of ${max[part]}`).join(", "));
  shown.forEach((part, i) => {
    const seg = el("span", `seg part-${part}`);
    const points = partPoints(f.score.parts, part);
    seg.style.width = `${Math.max(0, Math.min(100, points))}%`;
    seg.style.animationDelay = `${0.15 * i}s`;
    seg.title = `${PART_LABEL[part]}: ${points} / ${max[part]}`;
    bar.append(seg);
  });
  const total = el("span", "score-total", f.score.total.toFixed(2));
  const code = el("button", "code-btn", "code");
  code.type = "button";
  code.title = `See ${displayName(f.agent)}'s code`;
  code.addEventListener("click", () => void openDiff(taskId, f.agent));
  row.append(name, bar, total, code);
  if (!f.score.eligible) row.append(el("span", "tag", "not eligible"));
  return row;
}

// ---- the fusion round ----

/** False while the stage act runs; the assist tags show once it is done. */
let fusionActDone = true;
let fusionActTimers: ReturnType<typeof setTimeout>[] = [];
const FUSE_ACT_LEAD_MS = 900;
const FUSE_ACT_STEP_MS = 1_900;
const FUSE_FLIGHT_MS = 1_100;
const FUSE_STAMP_MS = 1_500;

/** Centre of a bot's body in the stage's coordinates. */
function bodyCentre(view: BotView, stage: DOMRect): { x: number; y: number } {
  const r = view.body.getBoundingClientRect();
  return { x: r.left - stage.left + r.width / 2, y: r.top - stage.top + r.height * 0.35 };
}

/**
 * The fusion round on the stage, after the winner is revealed: each loser in turn throws its test
 * file at the winner. A kept file lands and the mascot stamps it; a left-out file falls short with
 * Clef's answer. Skipped for reduced motion; the panel and the graph show the same thing.
 */
function playFusionAct(b: Board): void {
  stopFusionAct();
  const view = fusionView(b.task?.verdict);
  const winner = view === undefined ? undefined : bots.get(view.winner);
  if (view === undefined || winner === undefined || view.rows.length === 0 || reducedMotion()) return;
  fusionActDone = false;
  const stage = byId("stage");
  view.rows.forEach((row, i) => {
    fusionActTimers.push(setTimeout(() => throwFile(stage, row, winner), FUSE_ACT_LEAD_MS + i * FUSE_ACT_STEP_MS));
  });
  fusionActTimers.push(
    setTimeout(() => {
      fusionActDone = true;
      if (board !== undefined) renderBots(board);
    }, FUSE_ACT_LEAD_MS + view.rows.length * FUSE_ACT_STEP_MS),
  );
}

function stopFusionAct(): void {
  for (const timer of fusionActTimers) clearTimeout(timer);
  fusionActTimers = [];
  fusionActDone = true;
  for (const node of document.querySelectorAll(".fuse-card, .fuse-stamp")) node.remove();
  for (const view of bots.values()) view.root.classList.remove("assisting");
}

/** One keyframe of a flying file card: centred on `p`. */
function flyFrame(p: { x: number; y: number }, scale: number, opacity: number): Keyframe {
  return { transform: `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${scale})`, opacity };
}

function throwFile(stage: HTMLElement, row: FuseRow, winner: BotView): void {
  const loser = bots.get(row.agent);
  if (loser === undefined) return;
  const box = stage.getBoundingClientRect();
  const from = bodyCentre(loser, box);
  const to = bodyCentre(winner, box);
  const kept = row.outcome === "added";
  loser.root.classList.add("assisting");
  const card = el("div", `fuse-card ${kept ? "kept" : "dropped"}`);
  card.style.setProperty("--color", colorFor(row.agent));
  card.append(el("b", undefined, "{ }"), el("span", undefined, (row.files[0] ?? "").split("/").at(-1) ?? ""));
  stage.append(card);
  // An arc: up and over to the winner, or up and short of it for a left-out file.
  const end = kept ? to : { x: from.x + (to.x - from.x) * 0.62, y: to.y + 70 };
  const peak = { x: (from.x + end.x) / 2, y: Math.min(from.y, to.y) - 90 };
  const flight = card.animate(
    kept
      ? [flyFrame(from, 0.4, 0), flyFrame(from, 1, 1), flyFrame(peak, 1.15, 1), flyFrame(to, 0.6, 1)]
      : [flyFrame(from, 0.4, 0), flyFrame(from, 1, 1), flyFrame(peak, 1.05, 1), { ...flyFrame(end, 0.9, 0.9), offset: 0.85 }, flyFrame({ x: end.x, y: end.y + 40 }, 0.8, 0)],
    { duration: FUSE_FLIGHT_MS, easing: "cubic-bezier(.3, .7, .4, 1)", fill: "forwards" },
  );
  flight.onfinish = () => {
    card.remove();
    loser.root.classList.remove("assisting");
    stamp(stage, kept ? to : end, kept, kept ? "fused!" : (row.clef === undefined ? "left out" : `Clef ${row.clef.toFixed(2)} < ${FUSE_BAR.toFixed(2)}`));
    if (kept) {
      kick(winner.root, "fused");
      fireBeam(row.agent);
    }
  };
}

function stamp(stage: HTMLElement, at: { x: number; y: number }, kept: boolean, label: string): void {
  const node = el("div", `fuse-stamp ${kept ? "kept" : "dropped"}`);
  // Above the winner's crown and bubble, or above the spot a left-out file fell.
  node.style.left = `${at.x}px`;
  node.style.top = `${at.y - (kept ? 170 : 110)}px`;
  if (kept) node.append(mascot());
  node.append(el("b", undefined, kept ? "✓" : "✗"), el("span", undefined, label));
  stage.append(node);
  const anim = node.animate(
    [
      { transform: "translate(-50%, -50%) scale(.3) rotate(-14deg)", opacity: 0 },
      { transform: "translate(-50%, -50%) scale(1.15) rotate(-6deg)", opacity: 1, offset: 0.18 },
      { transform: "translate(-50%, -50%) scale(1) rotate(-6deg)", opacity: 1, offset: 0.8 },
      { transform: "translate(-50%, -80%) scale(1) rotate(-6deg)", opacity: 0 },
    ],
    { duration: FUSE_STAMP_MS, easing: "ease-out", fill: "forwards" },
  );
  anim.onfinish = () => node.remove();
}

let fusionKey = "";

const FUSE_BADGE: Record<FuseOutcome, string> = { added: "⚡ fused", rejected: "left out", failed: "could not try" };

/** The fusion panel: one row per loser's try, with each gate it passed or failed. */
function renderFusion(b: Board): void {
  const view = b.ended ? fusionView(b.task?.verdict) : undefined;
  const key = JSON.stringify(view ?? null);
  if (key === fusionKey) return;
  fusionKey = key;
  const panel = byId("fusion-panel");
  panel.hidden = view === undefined;
  if (view === undefined) return;
  const kept = view.rows.filter((r) => r.outcome === "added");
  byId("fusion-stat").textContent = `${kept.length} of ${view.rows.length} kept`;
  const result = byId("fusion-result");
  result.classList.toggle("kept", kept.length > 0);
  const winner = displayName(view.winner);
  if (view.error !== undefined && view.rows.length === 0) result.textContent = `The fusion round could not run: ${view.error}`;
  else if (kept.length === 0) result.textContent = `Nothing was added: ${winner}'s fix shipped as it was.`;
  else {
    const what = `${kept.map((r) => `${displayName(r.agent)}'s ${r.files.join(", ")}`).join(" and ")} ${view.shipped ? "shipped" : "joined"} with ${winner}'s fix`;
    const tail = `: the losing fork${kept.length === 1 ? "" : "s"} still made the code better.`;
    result.replaceChildren(document.createTextNode(what));
    if (view.hash !== undefined && view.commit !== undefined) {
      // The commit is a button: it opens the real commit, read from Artifacts.
      const hash = view.hash;
      const open = el("button", "commit-link", view.commit);
      open.type = "button";
      open.setAttribute("aria-label", `Open fusion commit ${view.commit}`);
      open.addEventListener("click", () => void openCommit(taskId, hash));
      result.append(document.createTextNode(" in fusion commit "), open);
    }
    result.append(document.createTextNode(tail));
  }
  byId("fusion-rows").replaceChildren(...view.rows.map((row, i) => fuseRow(row, i)));
}

function fuseRow(row: FuseRow, index: number): HTMLElement {
  const color = colorFor(row.agent);
  const item = el("li", `fuse-row ${row.outcome}`);
  item.style.setProperty("--color", color);
  item.style.setProperty("--i", String(index));
  const who = el("div", "fuse-who");
  who.append(art("mini", robotSvg(color)), el("b", undefined, displayName(row.agent)));
  const files = el("div", "fuse-files");
  for (const file of row.files) files.append(el("code", undefined, file));
  const gates = el("div", "fuse-gates");
  if (row.tests !== undefined) {
    const gate = el("span", `gate ${row.green === true ? "pass" : "fail"}`, `${row.green === true ? "✓" : "✗"} tests ${row.tests}`);
    gate.title = "Gate 1: every test passes with these files on top of the winner's fix";
    gates.append(gate);
  }
  if (row.clef !== undefined) gates.append(clefGate(row));
  const badge = el("span", "fuse-badge", FUSE_BADGE[row.outcome]);
  item.append(who, files, gates, badge);
  if (row.note !== undefined) item.append(el("p", "fuse-note", row.note));
  return item;
}

/** Gate 2: Clef's yes as a bar, with the bar it had to clear. */
function clefGate(row: FuseRow): HTMLElement {
  const clef = row.clef ?? 0;
  const pass = clef >= FUSE_BAR;
  const gate = el("span", `gate clef ${pass ? "pass" : "fail"}`);
  gate.title = `Gate 2: Clef (Workers AI) was asked whether it ${row.asked ?? "makes the change better?"} Yes ${clef.toFixed(2)}; it needs ${FUSE_BAR.toFixed(2)}.`;
  const meter = el("span", "clef-meter");
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", `Clef yes ${clef.toFixed(2)} of a needed ${FUSE_BAR.toFixed(2)}`);
  const fill = el("i");
  fill.style.width = `${Math.round(clef * 100)}%`;
  const mark = el("b");
  mark.style.left = `${FUSE_BAR * 100}%`;
  meter.append(fill, mark);
  gate.append(el("span", undefined, `${pass ? "✓" : "✗"} Clef`), meter, el("span", "clef-val", clef.toFixed(2)));
  return gate;
}

/** Newest first. Each line is the step's short label; the raw step is its tooltip. */
function renderLog(b: Board): void {
  const lines: { step: WireStep; label: string }[] = [];
  for (const step of log) {
    const label = step.kind === "init" ? "entered the thunderdome" : (bubbleFor(step) ?? step.text);
    const last = lines.findLast((line) => line.step.agent === step.agent);
    if (last !== undefined && last.label === label) continue;
    lines.push({ step, label });
  }
  const key = lines.map((line) => line.step.seq).join(",");
  if (key === logKey) return;
  logKey = key;
  const color = new Map(b.fighters.map((f) => [f.agent, f.color]));
  // Only rows that were not shown before slide in.
  const shown = logShown;
  logShown = new Set(lines.map((line) => line.step.seq));
  byId("log").replaceChildren(
    ...lines
      .toReversed()
      .map(({ step, label }) => {
        const item = el("li", `kind-${step.kind}${shown.has(step.seq) ? "" : " new"}`);
        item.style.setProperty("--color", color.get(step.agent) ?? "#8b8d98");
        item.title = step.text;
        item.append(el("span", "who", displayName(step.agent)), el("span", "what", label));
        return item;
      }),
  );
}

main();
