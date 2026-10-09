// The race as a Gantt: everything that ran, from the record, on one time axis. Pure, like
// gitgraph.ts: a task and the time it runs to in, rows and marks (ms) out; app.ts draws them.
import { buildEnd } from "./bill";
import { displayName } from "./board";
import type { WireTask } from "./board";
import { mergeOf, pushDots } from "./gitgraph";
import { formatMs } from "./platform";
import type { Stage } from "./platform";

/** What a row ran on: a pipeline stage, so this card and the pipeline name products alike. */
export type GanttProduct = Extract<Stage, "containers" | "workflows" | "previews" | "ai" | "merge">;

/** One thing that ran, from `from` to `to` (ms). */
export interface GanttRow {
  key: string;
  label: string;
  product: GanttProduct;
  from: number;
  to: number;
  running: boolean; // no end in the record yet: it runs to `now`
  approx: boolean; // the end is estimated
  failed: boolean;
  title: string; // the hover label, with the duration
}

/** A moment on the axis: the verdict, and the merge into main. */
export interface GanttMark {
  key: "verdict" | "merge";
  label: string;
  product: GanttProduct;
  at: number;
}

/** The chart: its time span, the rows in order and the marks. */
export interface Gantt {
  start: number;
  end: number;
  rows: GanttRow[];
  marks: GanttMark[];
}

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

function judgeProduct(name: string): GanttProduct {
  if (name.startsWith("fork ") || name === "fuse") return "containers";
  return name === "ship" ? "merge" : "ai";
}

function judgeLabel(name: string): string {
  return name.startsWith("fork ") ? `judge · fork ${displayName(name.slice(5))}` : `judge · ${name}`;
}

/**
 * The rows of a race, in order: the base preview, each agent followed by its preview builds, then
 * the judge steps by start. Whatever has no end runs to `now`, and a build whose preview the
 * record does not show ends at its time limit, but never past `now`. Undefined before the start.
 */
export function ganttOf(task: WireTask, now: number): Gantt | undefined {
  const start = ms(task.startedAt);
  if (start === undefined) return undefined;
  const rows: GanttRow[] = [];
  const add = (row: Omit<GanttRow, "to" | "running" | "title" | "approx" | "failed">, to: number | undefined, more: { approx?: boolean; failed?: boolean } = {}): void => {
    const end = Math.max(row.from, to ?? now);
    const approx = more.approx === true;
    const failed = more.failed === true;
    const title = `${row.label} · ${formatMs(end - row.from)}${to === undefined ? " so far" : ""}${approx ? " (estimated)" : ""}${failed ? " · failed" : ""}`;
    rows.push({ ...row, to: end, running: to === undefined, approx, failed, title });
  };
  const base = ms(task.basePreview?.at);
  // The base build starts with the race (TaskRoom.run).
  if (base !== undefined) add({ key: "base", label: "base preview", product: "previews", from: start }, base);
  const dots = pushDots(task);
  for (const slot of task.agents) {
    const from = ms(slot.startedAt);
    if (from === undefined) continue;
    const name = displayName(slot.name);
    add({ key: `agent:${slot.name}`, label: name, product: "containers", from }, ms(slot.endedAt), { failed: slot.status === "failed" });
    const preview = slot.push?.preview;
    const mine = dots.filter((d) => d.agent === slot.name);
    // The record keeps only the latest preview, so a build before it has no end: leave it out.
    const latest = mine.findIndex((d) => d.commit !== undefined && d.commit === preview?.commit);
    mine.forEach((d, i) => {
      if (i < latest) return;
      const shown = i === latest;
      const label = `${name}'s preview${d.commit === undefined ? "" : ` ${d.commit.slice(0, 7)}`}`;
      const end = buildEnd(d.at, d.commit, preview);
      add({ key: `build:${slot.name}:${i}`, label, product: "previews", from: d.at }, shown ? end : Math.min(now, end), { approx: !shown });
    });
  }
  // One segment per step: the record keeps only a step's latest attempt.
  for (const step of (task.judging ?? []).toSorted((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const from = ms(step.startedAt);
    if (from === undefined) continue;
    add({ key: `judge:${step.name}`, label: judgeLabel(step.name), product: judgeProduct(step.name), from }, ms(step.endedAt), { failed: step.state === "failed" });
  }
  const marks: GanttMark[] = [];
  // A merge lands at the verdict's time, so it stands in for the verdict's mark.
  const merge = mergeOf(task);
  const judged = ms(task.verdict?.judgedAt);
  if (merge !== undefined) marks.push({ key: "merge", label: `merge into main${merge.commit === undefined ? "" : ` ${merge.commit.slice(0, 7)}`}`, product: "merge", at: merge.at });
  else if (judged !== undefined) marks.push({ key: "verdict", label: "verdict", product: "workflows", at: judged });
  const end = Math.max(start + 1, ...rows.map((r) => r.to), ...marks.map((m) => m.at));
  return { start, end, rows, marks };
}
