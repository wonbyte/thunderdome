// The race's phases for the rail under the header: Fork → Race → Judge → Fuse → Merge. Pure, like
// board.ts: the phase comes from the task's status, the judge's steps and the verdict.
import { applyEvent, type Board } from "./board";
import { boardAt, type Timeline } from "./timeline";

/** Every phase, in order. */
export const PHASES = ["fork", "race", "judge", "fuse", "merge"] as const;
/** One phase of a race. */
export type Phase = (typeof PHASES)[number];
/** The rail's label for each phase. */
export const PHASE_LABELS: Record<Phase, string> = { fork: "Fork", race: "Race", judge: "Judge", fuse: "Fuse", merge: "Merge" };

/** Where a race is: the phase it reached, and whether that phase is running, finished or failed. */
export interface PhaseAt {
  phase: Phase;
  state: "current" | "done" | "failed";
  /** The phases after it will not run: a race with no winner has nothing to fuse or merge. */
  skipRest?: boolean;
}

/** How the rail draws one phase. */
export type PhaseState = "waiting" | "current" | "done" | "failed" | "skipped";

/**
 * The phase a board is in. Forks are made while the task is creating or ready, the robots race
 * while it runs, and once it is finished the judge's steps tell judging, fusing and merging apart.
 * A verdict ends the race: merged is done, a ship that failed is a failed merge.
 */
export function phaseOf(b: Board): PhaseAt {
  const task = b.task;
  if (b.ended) {
    if (!b.winner) return { phase: "judge", state: "done", skipRest: true };
    const ship = task?.verdict?.ship?.status;
    return { phase: "merge", state: ship === undefined || ship === "merged" ? "done" : "failed" };
  }
  if (task === undefined) return { phase: "fork", state: "current" };
  if (task.status === "failed") return { phase: task.startedAt === undefined ? "fork" : "race", state: "failed" };
  if (task.status === "running") return { phase: "race", state: "current" };
  if (task.status !== "finished") return { phase: "fork", state: "current" };
  const steps = task.judging ?? [];
  const step = (name: string) => steps.find((s) => s.name === name);
  if (step("ship") !== undefined) return { phase: "merge", state: step("ship")?.state === "failed" ? "failed" : "current" };
  if (step("fuse") !== undefined) return { phase: "fuse", state: "current" };
  return { phase: "judge", state: "current" };
}

/** Each phase's state on the rail: those before the current one are done, those after wait. */
export function railStates(at: PhaseAt): Record<Phase, PhaseState> {
  const index = PHASES.indexOf(at.phase);
  const out = {} as Record<Phase, PhaseState>;
  PHASES.forEach((p, i) => {
    out[p] = i < index ? "done" : i === index ? at.state : at.skipRest === true ? "skipped" : "waiting";
  });
  return out;
}

/** When each phase starts in a replay: the first time the board reaches it. Phases never reached are missing. */
export function phaseStarts(timeline: Timeline): Partial<Record<Phase, number>> {
  let board = boardAt(timeline, timeline.start);
  const out: Partial<Record<Phase, number>> = { [phaseOf(board).phase]: timeline.start };
  for (const { at, event } of timeline.events) {
    if (at <= timeline.start) continue;
    board = applyEvent(board, event, at);
    const phase = phaseOf(board).phase;
    if (out[phase] === undefined) out[phase] = at;
  }
  return out;
}
