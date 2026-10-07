// Draws gitgraph.ts's model as SVG: main on top, a lane per fork, push dots, the merge.
// Built with createElementNS and textContent only, so commit messages stay text.
import { colorFor, displayName } from "./board";
import type { GitGraph, GraphFusion, Lane } from "./gitgraph";
import { robotSvg } from "./sprites";

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const LEFT = 104; // room for the lane names
const RIGHT = 56; // room for the merge label
const TOP = 26;
const LANE_H = 38;
const MAIN_COLOR = "#8b8d98";
/** How far before the merge the fusion commit sits on the winner's lane. */
const FUSE_GAP = 72;

const px = (x: number): number => Math.round(LEFT + x * (W - LEFT - RIGHT));

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, className?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (className !== undefined) node.setAttribute("class", className);
  return node;
}

function text(x: number, y: number, value: string, className: string, anchor = "start"): SVGTextElement {
  const node = svg("text", { x, y, "text-anchor": anchor }, className);
  node.textContent = value;
  return node;
}

function titled<T extends SVGElement>(node: T, title: string): T {
  const t = svg("title", {});
  t.textContent = title;
  node.append(t);
  return node;
}

/**
 * A cubic Bézier's length, rounded up with room to spare: the draw-in animation dashes a path by
 * its length, and a dash shorter than the path leaves the end undrawn. The curve is never longer
 * than its control polygon, so that is a safe upper bound.
 */
function curveLength(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
  return Math.ceil(Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)) + 4;
}

let shown = new Set<string>();

/**
 * Replaces the graph in `host`. Dots and the merge that were not drawn before pop in. `onCommit`
 * opens a commit by its full hash (the fusion commit node).
 */
export function drawGraph(host: Element, graph: GitGraph, live: boolean, onLane: (agent: string) => void, onCommit?: (hash: string) => void): void {
  const height = TOP + (graph.lanes.length + 1) * LANE_H - 8;
  const root = svg("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": "Git graph of the race" }, "graph-svg");
  const mainY = TOP;
  const next = new Set<string>();
  const isNew = (key: string): boolean => {
    next.add(key);
    return !shown.has(key);
  };

  // main: the source repo the forks came from and the winner merges into.
  root.append(svg("line", { x1: px(0), y1: mainY, x2: px(1), y2: mainY }, "main-line"));
  root.append(text(LEFT - 14, mainY + 4, "main", "lane-name main", "end"));
  root.append(titled(svg("circle", { cx: px(0), cy: mainY, r: 5 }, "base-dot"), "base: the commit every fork started from"));

  const fx = graph.fusion === undefined ? undefined : fusionX(graph, graph.fusion);
  graph.lanes.forEach((lane, i) => {
    // The winner's lane stops at the fusion commit: a push drawn past it (the fusion's own) would sit behind the merge.
    const stop = fx !== undefined && lane.agent === graph.fusion?.winner ? fx : Infinity;
    drawLane(root, lane, mainY + (i + 1) * LANE_H, mainY, live, isNew, onLane, stop);
  });

  if (graph.fusion !== undefined && fx !== undefined) drawFusion(root, graph, graph.fusion, fx, mainY, isNew, onCommit);

  if (graph.merge !== undefined) {
    const lane = graph.lanes.findIndex((l) => l.agent === graph.merge?.agent);
    const laneY = mainY + (lane + 1) * LANE_H;
    const mx = px(graph.merge.x);
    const color = graph.lanes[lane]?.color ?? MAIN_COLOR;
    const fresh = isNew("merge") ? " pop" : "";
    // Judging and the merge come after the winner's last push: a dashed bridge to the merge.
    const laneEnd = Math.min(fx ?? Infinity, Math.max(px(0) + 28, px(graph.lanes[lane]?.endX ?? 0)));
    if (mx - 34 > laneEnd + 6) {
      root.append(svg("line", { x1: laneEnd + 6, y1: laneY, x2: mx - 34, y2: laneY, stroke: color }, "judge-bridge"));
      root.append(text((laneEnd + mx - 34) / 2, laneY - 8, "judged", "lane-tag bridge-tag", "middle"));
    }
    const len = curveLength(mx - 34, laneY, mx - 10, laneY, mx - 14, mainY, mx, mainY);
    const path = svg("path", { d: `M ${mx - 34} ${laneY} C ${mx - 10} ${laneY}, ${mx - 14} ${mainY}, ${mx} ${mainY}`, stroke: color, style: `--len:${len}` }, `merge-path${fresh}`);
    root.append(path);
    const dot = svg("circle", { cx: mx, cy: mainY, r: 8, stroke: color }, `merge-dot${fresh}`);
    root.append(titled(dot, `merged into main${graph.merge.commit ? ` as ${graph.merge.commit}` : ""}`));
    root.append(text(mx, mainY - 12, graph.merge.commit ? `merge ${graph.merge.commit}` : "merged", "merge-label", "end"));
  }

  if (live) {
    const nx = px(graph.nowX);
    root.append(svg("line", { x1: nx, y1: mainY - 12, x2: nx, y2: height - 4 }, "now-line"));
  }
  shown = next;
  host.replaceChildren(root);
}

function drawLane(
  root: SVGSVGElement,
  lane: Lane,
  y: number,
  mainY: number,
  live: boolean,
  isNew: (key: string) => boolean,
  onLane: (agent: string) => void,
  stop = Infinity,
): void {
  const g = svg("g", { style: `--color:${lane.color}`, tabindex: 0, role: "button", "aria-label": `${lane.name}: see the code` }, `lane${lane.won ? " won" : ""}${lane.ended && !lane.won ? " lost" : ""}`);
  g.addEventListener("click", () => onLane(lane.agent));
  g.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onLane(lane.agent);
    }
  });
  const x0 = px(0);
  const x1 = Math.min(stop, Math.max(x0 + 28, px(lane.endX)));
  // The fork: a curve out of main, then the lane.
  g.append(svg("path", { d: `M ${x0} ${mainY} C ${x0 + 14} ${mainY}, ${x0 + 6} ${y}, ${x0 + 28} ${y} L ${x1} ${y}`, stroke: lane.color }, "lane-path"));
  g.append(text(LEFT - 14, y + 4, lane.name, "lane-name", "end"));
  for (const dot of lane.dots) {
    const r = 4 + Math.min(4, dot.commits);
    const cx = Math.max(x0 + 28, px(dot.x));
    if (cx > stop - 10) continue;
    const c = svg("circle", { cx, cy: y, r }, `push-dot${dot.approx ? " approx" : ""}${isNew(dot.key) ? " pop" : ""}`);
    g.append(titled(c, `${lane.name} pushed: ${dot.label}${dot.approx ? " (time estimated)" : ""}`));
  }
  if (!lane.ended && live) g.append(svg("circle", { cx: x1, cy: y, r: 4 }, "lane-head"));
  if (lane.ended && !lane.won) {
    g.append(titled(svg("rect", { x: x1 + 4, y: y - 4, width: 8, height: 8, rx: 2 }, "lane-end"), "fork kept as a record"));
  }
  if (!lane.won) g.append(text(x1 + (lane.ended ? 18 : 10), y + 4, lane.ended ? "kept" : "", "lane-tag"));
  root.append(g);
}

/** Where the fusion commit sits: between the winner's last push and where the merge leaves its lane; at the merge's start when there is no room. */
function fusionX(graph: GitGraph, fusion: GraphFusion): number {
  const winner = graph.lanes.find((l) => l.agent === fusion.winner);
  const mergeStart = graph.merge === undefined ? Infinity : px(graph.merge.x) - 34;
  return Math.min(mergeStart, Math.max(px(winner?.endX ?? 0) + 18, px(fusion.x) - FUSE_GAP));
}

/**
 * The fusion round: an arrow from each loser's lane into the winner's lane, just before the merge.
 * A kept try is a solid arrow in the loser's color into a fusion commit; a left-out try is a faint
 * dashed arrow that stops short with a cross. With `onCommit`, the fusion commit is a button.
 */
function drawFusion(
  root: SVGSVGElement,
  graph: GitGraph,
  fusion: GraphFusion,
  fx: number,
  mainY: number,
  isNew: (key: string) => boolean,
  onCommit: ((hash: string) => void) | undefined,
): void {
  const wi = graph.lanes.findIndex((l) => l.agent === fusion.winner);
  const winner = graph.lanes[wi];
  if (winner === undefined) return;
  const wy = mainY + (wi + 1) * LANE_H;
  const fresh = isNew("fusion") ? " pop" : "";
  const g = svg("g", {}, `fusion${fresh}`);
  const added = fusion.tries.filter((t) => t.added).length;
  const asCommit = added > 0 && fusion.hash !== undefined && fusion.author !== undefined && onCommit !== undefined;
  // The label under the dot is placed first, so the left-out arrows and their ✗ stop short of it.
  const tag = added > 0 ? "⚡ fused" : "none kept";
  const labelLeft = asCommit ? commitLeft(fx, commitLabel(fusion.hash ?? "", fusion.author ?? "")) : fx - (tag.length * MONO_CH) / 2;
  const stop = Math.min(fx - 16, labelLeft - 34);
  fusion.tries.forEach((t, k) => {
    const li = graph.lanes.findIndex((l) => l.agent === t.agent);
    const lane = graph.lanes[li];
    if (lane === undefined) return;
    const ly = mainY + (li + 1) * LANE_H;
    // A left-out try stops short of the winner's lane, left of the label, at a height of its own.
    const ex = t.added ? fx - 7 : stop;
    const off = (ly - wy) * 0.4;
    const ey = t.added ? wy : wy + Math.sign(off) * Math.max(12, Math.abs(off));
    const sx = Math.min(px(lane.endX) + 6, ex - 30);
    // Handles scale with the run, so a long arrow eases out of its lane and into the winner's (an S, not a line).
    const h = Math.max(24, (ex - sx) * 0.5);
    const len = curveLength(sx, ly, sx + h, ly, ex - h, ey, ex, ey);
    const path = svg("path", { d: `M ${sx} ${ly} C ${sx + h} ${ly}, ${ex - h} ${ey}, ${ex} ${ey}`, stroke: lane.color, style: `--k:${k};--len:${len}` }, `fuse-path ${t.added ? "kept" : "dropped"}`);
    g.append(titled(path, t.label));
    if (!t.added) g.append(titled(text(ex + 5, ey + 4, "✗", "fuse-x", "middle"), t.label));
  });
  const kept = fusion.tries.filter((t) => t.added).map((t) => t.label);
  if (asCommit && onCommit !== undefined) {
    g.append(commitNode(fx, wy, fusion.hash ?? "", fusion.author ?? "", kept, onCommit));
  } else {
    const dot = svg("circle", { cx: fx, cy: wy, r: added > 0 ? 7 : 4 }, `fuse-dot${added > 0 ? " kept" : ""}`);
    g.append(titled(dot, added > 0 ? `fusion commit${fusion.commit === undefined ? "" : ` ${fusion.commit}`}: ${kept.join("; ")}` : "fusion round: every try was left out"));
    g.append(text(fx, wy + 20, tag, `fuse-tag${added > 0 ? " kept" : ""}`, "middle"));
  }
  root.append(g);
}

/** Width of one 10.5px mono character, to fit the commit label inside the graph. */
const MONO_CH = 6.4;
const SPRITE = 13;

/** "<sha7> · by <Name>": the fusion commit's label. */
function commitLabel(hash: string, author: string): string {
  return `${hash.slice(0, 7)} · by ${displayName(author)}`;
}

/** Where the commit's sprite-and-label row starts: centred under the dot, inside the graph. */
function commitLeft(fx: number, label: string): number {
  const width = SPRITE + 4 + label.length * MONO_CH;
  return Math.max(LEFT, Math.min(W - 4 - width, fx - width / 2));
}

/**
 * The fusion commit as a real commit: the dot, the author robot and "<sha7> · by <Name>". A button
 * that opens the commit.
 */
function commitNode(fx: number, wy: number, hash: string, author: string, kept: string[], onCommit: (hash: string) => void): SVGGElement {
  const sha = hash.slice(0, 7);
  const name = displayName(author);
  const label = commitLabel(hash, author);
  const node = svg("g", { tabindex: 0, role: "button", "aria-label": `Fusion commit ${sha} by ${name}: open the commit` }, "fuse-commit");
  node.addEventListener("click", () => onCommit(hash));
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onCommit(hash);
    }
  });
  node.append(titled(svg("circle", { cx: fx, cy: wy, r: 7 }, "fuse-dot kept"), `fusion commit ${sha} by ${name}: ${kept.join("; ")}`));
  // Sprite and label as one row under the dot, kept inside the graph's right edge.
  const left = commitLeft(fx, label);
  node.append(robot(left, wy + 9, SPRITE, colorFor(author)), text(left + SPRITE + 4, wy + 20, label, "fuse-tag kept fuse-sha"));
  return node;
}

/** The robot sprite (sprites.ts output only) as a nested svg at x, y. */
function robot(x: number, y: number, size: number, color: string): SVGElement {
  const parsed = new DOMParser().parseFromString(robotSvg(color), "image/svg+xml").documentElement;
  const node = document.importNode(parsed, true) as unknown as SVGSVGElement;
  for (const [name, value] of Object.entries({ x, y, width: size, height: size })) node.setAttribute(name, String(value));
  node.setAttribute("class", "fuse-robot");
  return node;
}
