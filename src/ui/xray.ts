// X-ray mode: the race's Cloudflare architecture as a circuit, and which wires each platform hit
// lights. Pure, like platform.ts; the page draws it (app.ts).
import { displayName, type WireTask } from "./board";
import { ganttOf, type GanttRow } from "./gantt";
import { formatMs, type PlatformHit } from "./platform";

/** A box on the circuit, in viewBox units. `binding` is its name in wrangler.jsonc. */
export interface XrayNode {
  id: string;
  label: string;
  binding?: string;
  agent?: string; // a robot's sandbox, drawn in its color
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A wire between two nodes, as a polyline from `from` to `to`. */
export interface XrayEdge {
  from: string;
  to: string;
  points: [number, number][];
}

/** The whole drawing: nodes, wires, and the Durable Object box around the robots' sandboxes. */
export interface XrayCircuit {
  width: number;
  height: number;
  box: { x: number; y: number; w: number; h: number; label: string };
  nodes: XrayNode[];
  edges: XrayEdge[];
}

const W = 160;
const H = 64; // label, binding, and the node's measured time
const node = (id: string, label: string, x: number, y: number, binding?: string): XrayNode => ({ id, label, x, y, w: W, h: H, ...(binding === undefined ? {} : { binding }) });
const left = (n: XrayNode): [number, number] => [n.x, n.y + n.h / 2];
const right = (n: XrayNode): [number, number] => [n.x + n.w, n.y + n.h / 2];
const top = (n: XrayNode): [number, number] => [n.x + n.w / 2, n.y];
const bottom = (n: XrayNode): [number, number] => [n.x + n.w / 2, n.y + n.h];
const edge = (from: XrayNode, to: XrayNode, points: [number, number][]): XrayEdge => ({ from: from.id, to: to.id, points });

/** The sandbox node id of a robot. */
const sandboxId = (agent: string): string => `sandbox:${agent}`;

/** The circuit for a race with these robots, on a 1000 × 540 viewBox. */
export function circuit(agents: readonly string[]): XrayCircuit {
  const pushwf = node("pushwf", "Push Workflow", 620, 24, "PUSH");
  const build = node("build", "Build container", 810, 24, "SANDBOX");
  const events = node("events", "Event Subscriptions", 620, 128, "repo.pushed");
  const previews = node("previews", "Workers Preview", 810, 128);
  const room = node("room", "TaskRoom", 24, 244, "TASK_ROOM");
  const artifacts = node("artifacts", "Artifacts", 620, 244, "ARTIFACTS");
  const ship = node("ship", "Ship · merge", 810, 244);
  const browser = node("browser", "Browser Rendering", 620, 368, "BROWSER");
  const fusion = node("fusion", "Fusion round", 810, 368);
  const tests = node("tests", "Judge containers", 24, 466, "SANDBOX");
  const judge = node("judge", "Judge Workflow", 300, 466, "JUDGE");
  const clef = node("clef", "Workers AI · Clef", 620, 466, "AI");
  const box = { x: 224, y: 196, w: 336, h: 148, label: "Sandboxes · Durable Objects (SANDBOX)" };
  // One row per robot, centered under the box's label.
  const rowH = 22;
  const gap = 4;
  const total = agents.length * rowH + Math.max(0, agents.length - 1) * gap;
  const startY = box.y + 26 + (box.h - 34 - total) / 2;
  const sandboxes = agents.map((agent, i): XrayNode => ({ id: sandboxId(agent), label: displayName(agent), agent, x: 312, y: startY + i * (rowH + gap), w: W, h: rowH }));
  const edges: XrayEdge[] = [
    // The fork goes over the sandboxes' box.
    edge(room, artifacts, [top(room), [top(room)[0], 172], [590, 172], [590, left(artifacts)[1]], left(artifacts)]),
    ...sandboxes.flatMap((sb) => [edge(room, sb, [right(room), left(sb)]), edge(sb, artifacts, [right(sb), left(artifacts)])]),
    edge(artifacts, events, [top(artifacts), bottom(events)]),
    edge(events, pushwf, [top(events), bottom(pushwf)]),
    edge(pushwf, build, [right(pushwf), left(build)]),
    edge(build, previews, [bottom(build), top(previews)]),
    edge(room, judge, [bottom(room), [bottom(room)[0], 430], [top(judge)[0], 430], top(judge)]),
    edge(judge, tests, [left(judge), right(tests)]),
    edge(judge, clef, [right(judge), left(clef)]),
    edge(judge, browser, [[judge.x + W, judge.y + 12], [540, judge.y + 12], [540, left(browser)[1]], left(browser)]),
    edge(browser, clef, [bottom(browser), top(clef)]),
    edge(clef, fusion, [right(clef), [bottom(fusion)[0], right(clef)[1]], bottom(fusion)]),
    edge(fusion, ship, [top(fusion), bottom(ship)]),
    edge(ship, artifacts, [left(ship), right(artifacts)]),
  ];
  return { width: 1000, height: 540, box, nodes: [pushwf, build, events, previews, room, artifacts, ship, browser, fusion, tests, judge, clef, ...sandboxes], edges };
}

/**
 * The paths (node ids, in order) a hit sends packets along; none for a hit X-ray does not know.
 * shortcut: two hit pairs share a stage and differ only in their text (a sandbox coming up vs a
 * judge sandbox, Clef vs the screenshots), matched by prefix here; X1 fails if platform.ts rewords them.
 */
export function edgeFor(hit: PlatformHit, agents: readonly string[]): string[][] {
  const agent = hit.agent !== undefined && agents.includes(hit.agent) ? sandboxId(hit.agent) : undefined;
  if (hit.agent !== undefined && agent === undefined) return [];
  switch (hit.stage) {
    case "fork":
      return [["room", "artifacts"]];
    case "containers":
      if (hit.text.startsWith("judge sandbox")) return [["judge", "tests"]];
      if (agent !== undefined) return [[agent, "room"]];
      return hit.text.startsWith("starting") ? agents.map((a) => ["room", sandboxId(a)]) : [];
    case "claims":
      return agent === undefined ? [] : [[agent, "room"]];
    case "events":
      return agent === undefined ? [] : [[agent, "artifacts", "events"]];
    case "workflows":
      if (agent !== undefined) return [["events", "pushwf", "build"]];
      return hit.text.startsWith("judge started") ? [["room", "judge"]] : [];
    case "previews":
      return [["build", "previews"]];
    case "ai":
      return hit.text.startsWith("screenshots") ? [["judge", "browser", "clef"]] : [["judge", "clef"]];
    case "fusion":
      return [["judge", "clef", "fusion"]];
    case "merge":
      return [["fusion", "ship", "artifacts"]];
    default:
      return [];
  }
}

/** The polyline a packet follows along a path, wires walked backwards where needed; undefined when a wire is missing. */
export function route(c: XrayCircuit, path: readonly string[]): [number, number][] | undefined {
  const points: [number, number][] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const forward = c.edges.find((e) => e.from === a && e.to === b);
    const back = forward === undefined ? c.edges.find((e) => e.from === b && e.to === a) : undefined;
    const leg = forward?.points ?? back?.points.toReversed();
    if (leg === undefined) return undefined;
    // Wires meet a box on different sides: pass through its center, then take the next wire from its start.
    const via = c.nodes.find((n) => n.id === a);
    if (points.length > 0 && via !== undefined) points.push([via.x + via.w / 2, via.y + via.h / 2]);
    points.push(...leg);
  }
  return points.length === 0 ? undefined : points;
}

/** The judge step a running timeline bar belongs to, and the nodes it keeps busy. */
const JUDGE_BUSY: Record<string, string[]> = { look: ["browser", "clef"], split: ["clef"], compare: ["clef"], fuse: ["fusion"], ship: ["ship"] };

/**
 * The nodes working at `now`: whatever the timeline shows running then (ganttOf), so X-ray and
 * the timeline never disagree. A robot's sandbox while its agent runs, the push workflow and build
 * container while a preview builds, the judge and the parts its running steps use.
 */
export function busyNodes(task: WireTask, now: number): Set<string> {
  const busy = new Set<string>();
  for (const row of ganttOf(task, now)?.rows ?? []) {
    // Running live, or (a replay of the whole record) spanning the replay's time.
    if (!row.running && !(row.from <= now && now < row.to)) continue;
    if (row.key.startsWith("agent:")) busy.add(sandboxId(row.key.slice(6)));
    else if (row.key.startsWith("build:")) for (const id of ["pushwf", "build"]) busy.add(id);
    else if (row.key.startsWith("judge:")) {
      const step = row.key.slice(6);
      // A fork step runs that fork's tests, then Clef scores its diff.
      for (const id of ["judge", ...(step.startsWith("fork ") ? ["tests", "clef"] : (JUDGE_BUSY[step] ?? []))]) busy.add(id);
    }
  }
  return busy;
}

/** A node's measured times over its `n` finished runs (ms). */
export interface NodeStat {
  last: number;
  avg: number;
  n: number;
}

/** The node a finished timeline bar measures: preview builds and each judge step's part. */
function statNode(key: string): string | undefined {
  if (key === "base" || key.startsWith("build:")) return "build";
  if (key.startsWith("judge:fork ")) return "tests";
  // A step's first busy node is the one it is timed on (look: Browser Rendering, split: Clef, ...).
  return key.startsWith("judge:") ? JUDGE_BUSY[key.slice(6)]?.[0] : undefined;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * What the circuit measured by `now`, from the timeline's finished bars: each node's times, and at
 * most three plain facts. A build or fork step over twice this race's median (with three or more to
 * compare), a build with no saved preview, a robot out of time, a failed sandbox or judge step.
 */
export function xrayStats(task: WireTask, now: number): { stats: Map<string, NodeStat>; notes: string[] } {
  const rows = ganttOf(task, now)?.rows ?? [];
  const done = rows.filter((r) => !r.running && !r.approx && r.to <= now).toSorted((a, b) => a.to - b.to);
  const stats = new Map<string, NodeStat>();
  const record = (id: string, ms: number): void => {
    const s = stats.get(id);
    stats.set(id, s === undefined ? { last: ms, avg: ms, n: 1 } : { last: ms, avg: (s.avg * s.n + ms) / (s.n + 1), n: s.n + 1 });
  };
  for (const r of done) {
    const id = statNode(r.key);
    if (id !== undefined) record(id, r.to - r.from);
  }
  const judged = done.filter((r) => r.key.startsWith("judge:"));
  if (judged.length > 0) record("judge", Math.max(...judged.map((r) => r.to)) - Math.min(...judged.map((r) => r.from)));

  const notes: string[] = [];
  const slow = (what: string, picked: GanttRow[], name: (r: GanttRow) => string): void => {
    if (picked.length < 3) return;
    const mid = median(picked.map((r) => r.to - r.from));
    for (const r of picked) {
      const ms = r.to - r.from;
      if (ms > 2 * mid) notes.push(`${name(r)} took ${formatMs(ms)}, ${(ms / mid).toFixed(1)}× this race's median ${what} (${formatMs(mid)}).`);
    }
  };
  slow("build", done.filter((r) => r.key.startsWith("build:")), (r) => r.label);
  slow("fork check", done.filter((r) => r.key.startsWith("judge:fork ")), (r) => `${displayName(r.key.slice(11))}'s tests and Clef scoring`);
  // Only once it is true: the build's 80 s limit has passed, or the verdict came first.
  const judgedAt = Date.parse(task.verdict?.judgedAt ?? "");
  for (const r of rows) {
    if (r.approx && (r.to < now || judgedAt <= now)) notes.push(`${r.label} has no saved preview: it did not finish within 80 s, or before the verdict.`);
    if (r.failed && r.to <= now) notes.push(r.key.startsWith("agent:") ? `${r.label}'s sandbox failed.` : `The judge's ${r.key.slice(6)} step failed.`);
  }
  for (const slot of task.agents) {
    const ended = slot.endedAt === undefined ? undefined : Date.parse(slot.endedAt);
    if (slot.status === "timeout" && ended !== undefined && ended <= now) notes.push(`${displayName(slot.name)} ran out of time.`);
  }
  return { stats, notes: notes.slice(0, 3) };
}

/** One robot's newest push by `now`, and the path it took to its preview. */
export interface Trace {
  agent: string;
  commit: string;
  at: number; // ms, when the push was recorded
  previewAt?: number; // ms, when its preview was saved, if by `now`
  path: string[];
}

/** The newest push of `agent` recorded by `now`; undefined before its first. */
export function traceOf(task: WireTask, agent: string, now: number): Trace | undefined {
  const entry = task.agents.find((a) => a.name === agent)?.push?.log?.findLast((e) => Date.parse(e.at) <= now);
  if (entry === undefined) return undefined;
  const previewAt = entry.previewAt === undefined ? undefined : Date.parse(entry.previewAt);
  const path = [sandboxId(agent), "artifacts", "events", "pushwf", "build", "previews"];
  return { agent, commit: entry.commit, at: Date.parse(entry.at), path, ...(previewAt !== undefined && previewAt <= now ? { previewAt } : {}) };
}

/** The trace in words. Only two times exist, so the hops between are named, not timed. */
export function traceLine(trace: Trace, raceStart: number): string {
  const head = `${displayName(trace.agent)}'s push ${trace.commit.slice(0, 7)}, recorded ${formatMs(Math.max(0, trace.at - raceStart))} into the race: sandbox → Artifacts → Event Subscriptions → Push Workflow → build container → Workers Preview`;
  if (trace.previewAt === undefined) return `${head}. No preview saved for it yet: still building, or it never finished.`;
  return `${head}, live ${formatMs(trace.previewAt - trace.at)} after the push was recorded. The hops between are not timed one by one.`;
}
