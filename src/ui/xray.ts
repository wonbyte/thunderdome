// X-ray mode: the race's Cloudflare architecture as a circuit, and which wires each platform hit
// lights. Pure, like platform.ts; the page draws it (app.ts).
import { displayName } from "./board";
import type { PlatformHit } from "./platform";

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
const H = 52;
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
    points.push(...(points.length === 0 ? leg : leg.slice(1)));
  }
  return points.length === 0 ? undefined : points;
}
