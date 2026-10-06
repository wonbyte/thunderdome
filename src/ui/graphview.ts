// Draws gitgraph.ts's model as SVG: main on top, a lane per fork, push dots, the merge.
// Built with createElementNS and textContent only, so commit messages stay text.
import type { GitGraph, Lane } from "./gitgraph";

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const LEFT = 104; // room for the lane names
const RIGHT = 56; // room for the merge label
const TOP = 26;
const LANE_H = 38;
const MAIN_COLOR = "#8b8d98";

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

let shown = new Set<string>();

/** Replaces the graph in `host`. Dots and the merge that were not drawn before pop in. */
export function drawGraph(host: Element, graph: GitGraph, live: boolean, onLane: (agent: string) => void): void {
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

  graph.lanes.forEach((lane, i) => drawLane(root, lane, mainY + (i + 1) * LANE_H, mainY, live, isNew, onLane));

  if (graph.merge !== undefined) {
    const lane = graph.lanes.findIndex((l) => l.agent === graph.merge?.agent);
    const laneY = mainY + (lane + 1) * LANE_H;
    const mx = px(graph.merge.x);
    const color = graph.lanes[lane]?.color ?? MAIN_COLOR;
    const fresh = isNew("merge") ? " pop" : "";
    // Judging and the merge come after the winner's last push: a dashed bridge to the merge.
    const laneEnd = Math.max(px(0) + 28, px(graph.lanes[lane]?.endX ?? 0));
    if (mx - 34 > laneEnd + 6) {
      root.append(svg("line", { x1: laneEnd + 6, y1: laneY, x2: mx - 34, y2: laneY, stroke: color }, "judge-bridge"));
      root.append(text((laneEnd + mx - 34) / 2, laneY - 8, "judged", "lane-tag bridge-tag", "middle"));
    }
    const path = svg("path", { d: `M ${mx - 34} ${laneY} C ${mx - 10} ${laneY}, ${mx - 14} ${mainY}, ${mx} ${mainY}`, stroke: color }, `merge-path${fresh}`);
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
  const x1 = Math.max(x0 + 28, px(lane.endX));
  // The fork: a curve out of main, then the lane.
  g.append(svg("path", { d: `M ${x0} ${mainY} C ${x0 + 14} ${mainY}, ${x0 + 6} ${y}, ${x0 + 28} ${y} L ${x1} ${y}`, stroke: lane.color }, "lane-path"));
  g.append(text(LEFT - 14, y + 4, lane.name, "lane-name", "end"));
  for (const dot of lane.dots) {
    const r = 4 + Math.min(4, dot.commits);
    const c = svg("circle", { cx: Math.max(x0 + 28, px(dot.x)), cy: y, r }, `push-dot${dot.approx ? " approx" : ""}${isNew(dot.key) ? " pop" : ""}`);
    g.append(titled(c, `${lane.name} pushed: ${dot.label}${dot.approx ? " (time estimated)" : ""}`));
  }
  if (!lane.ended && live) g.append(svg("circle", { cx: x1, cy: y, r: 4 }, "lane-head"));
  if (lane.ended && !lane.won) {
    g.append(titled(svg("rect", { x: x1 + 4, y: y - 4, width: 8, height: 8, rx: 2 }, "lane-end"), "fork kept as a record"));
  }
  if (!lane.won) g.append(text(x1 + (lane.ended ? 18 : 10), y + 4, lane.ended ? "kept" : "", "lane-tag"));
  root.append(g);
}
