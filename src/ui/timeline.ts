// Replay: rebuilds a recorded race as timed live events, and the board at any moment of it.
// Pure, like board.ts. Times are ms since the epoch, taken from the recorded timestamps.
import { applyEvent, emptyBoard } from "./board";
import type { Board, BoardEvent, WireAgent, WireClaim, WireClaimBoard, WireStep, WireTask } from "./board";
import { pushDots } from "./gitgraph";

/** A live event at the time it happened. */
export interface TimedEvent {
  at: number;
  event: BoardEvent;
  approx?: boolean; // the time is estimated (earlier pushes only keep their count)
}

/** A recorded race as timed events, oldest first. */
export interface Timeline {
  taskId: string;
  start: number; // when the replay begins (task created)
  end: number; // the last event
  events: TimedEvent[]; // oldest first; ties keep build order
}

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

const RELEASED = /^released\s+(.+)$/;

/** The task as it looked when it was created: forks made, nothing run yet. */
function createdTask(task: WireTask): WireTask {
  const { verdict: _v, basePreview: _b, finishedAt: _f, startedAt: _s, ...rest } = task;
  return {
    ...rest,
    status: "ready",
    agents: task.agents.map((slot) => ({ name: slot.name, status: "idle" })),
  };
}

function runningTask(task: WireTask): WireTask {
  const base = createdTask(task);
  return {
    ...base,
    status: "running",
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    agents: task.agents.map((slot): WireAgent => ({ name: slot.name, status: "running", ...(slot.startedAt === undefined ? {} : { startedAt: slot.startedAt }) })),
  };
}

/** Claims that share a time and agent were one claim call. */
function claimEvents(taskId: string, history: WireClaim[]): TimedEvent[] {
  const groups = new Map<string, WireClaim[]>();
  for (const claim of history) {
    const key = `${claim.agent}\n${claim.at}`;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  return [...groups.values()].flatMap((claims): TimedEvent[] => {
    const first = claims[0];
    const at = ms(first?.at);
    if (first === undefined || at === undefined) return [];
    return [
      {
        at,
        event: {
          kind: "claim",
          taskId,
          agent: first.agent,
          result: { ok: true, claimed: claims.map((c) => c.file), shared: claims.filter((c) => c.shared).map((c) => c.file), clashes: [] },
        },
      },
    ];
  });
}

/** A claim step "released a, b" is the agent letting go of those files. */
function releaseEvents(taskId: string, steps: WireStep[]): TimedEvent[] {
  return steps.flatMap((step): TimedEvent[] => {
    const files = step.kind === "claim" ? RELEASED.exec(step.text.trim())?.[1] : undefined;
    const at = ms(step.at);
    if (files === undefined || at === undefined) return [];
    return [{ at, event: { kind: "release", taskId, agent: step.agent, released: files.split(/,\s*/).filter((f) => f !== "") } }];
  });
}

/** One event per push, with the agent's running commit count. Older tasks get estimated times. */
function pushEvents(taskId: string, task: WireTask): TimedEvent[] {
  const totals = new Map<string, { commits: number; pushes: number }>();
  return [...pushDots(task)]
    .toSorted((a, b) => a.at - b.at)
    .map((dot): TimedEvent => {
      const sum = totals.get(dot.agent) ?? { commits: 0, pushes: 0 };
      const next = { commits: sum.commits + dot.commits, pushes: sum.pushes + 1 };
      totals.set(dot.agent, next);
      return {
        at: dot.at,
        event: { kind: "push", taskId, agent: dot.agent, push: { ...next, lastPushAt: new Date(dot.at).toISOString() } },
        ...(dot.approx === true ? { approx: true } : {}),
      };
    });
}

/** Rebuilds the race's live events from the task, its steps and its claim history, with their times. */
export function buildTimeline(task: WireTask, steps: WireStep[], claims: WireClaimBoard): Timeline {
  const taskId = task.id;
  const startedAt = ms(task.startedAt);
  const start = ms(task.createdAt) ?? startedAt ?? 0;
  const events: TimedEvent[] = [{ at: start, event: { kind: "snapshot", taskId, task: createdTask(task) } }];
  if (startedAt !== undefined) events.push({ at: startedAt, event: { kind: "status", taskId, task: runningTask(task) } });
  const basePreviewAt = ms(task.basePreview?.at);
  if (task.basePreview !== undefined && basePreviewAt !== undefined) {
    events.push({ at: basePreviewAt, event: { kind: "base-preview", taskId, preview: task.basePreview } });
  }
  for (const step of steps) {
    const at = ms(step.at);
    if (at !== undefined) events.push({ at, event: { kind: "steps", taskId, agent: step.agent, steps: [step] } });
  }
  events.push(...claimEvents(taskId, claims.history), ...releaseEvents(taskId, steps), ...pushEvents(taskId, task));
  for (const slot of task.agents) {
    const preview = slot.push?.preview;
    const previewAt = ms(preview?.at);
    if (preview !== undefined && previewAt !== undefined) events.push({ at: previewAt, event: { kind: "preview", taskId, agent: slot.name, preview } });
  }
  // Agents end in order; the last one to end finishes the task.
  const ends = task.agents
    .map((slot) => ({ slot, at: ms(slot.endedAt) }))
    .filter((x): x is { slot: WireAgent; at: number } => x.at !== undefined && (x.slot.status === "done" || x.slot.status === "failed" || x.slot.status === "timeout"))
    .toSorted((a, b) => a.at - b.at);
  ends.forEach(({ slot, at }, i) => {
    const end = slot.status === "done" || slot.status === "failed" || slot.status === "timeout" ? slot.status : "done";
    const status = i === ends.length - 1 && ends.length === task.agents.length ? "finished" : "running";
    events.push({ at, event: { kind: "agent-end", taskId, agent: slot.name, outcome: { end }, status } });
  });
  const judgedAt = ms(task.verdict?.judgedAt) ?? ms(task.finishedAt);
  if (task.verdict !== undefined && judgedAt !== undefined) events.push({ at: judgedAt, event: { kind: "verdict", taskId, verdict: task.verdict } });
  // Stable sort: same-time events keep build order (a snapshot before its steps).
  const sorted = events.map((e, i) => ({ e, i })).toSorted((a, b) => a.e.at - b.e.at || a.i - b.i).map(({ e }) => e);
  return { taskId, start, end: sorted.at(-1)?.at ?? start, events: sorted };
}

/** The board after every event at or before `t`. Each event uses its own time as `now`. */
export function boardAt(timeline: Timeline, t: number): Board {
  let board = emptyBoard(timeline.taskId);
  for (const { at, event } of timeline.events) {
    if (at > t) break;
    board = applyEvent(board, withClashes(board, event), at);
  }
  return board;
}

/** Recorded claims have no clash list; it comes from who held each file at that moment. */
function withClashes(board: Board, event: BoardEvent): BoardEvent {
  if (event.kind !== "claim" || !event.result.ok) return event;
  const clashes = event.result.claimed.flatMap((file) => {
    const heldBy = Object.keys(board.grid.cells[file] ?? {}).filter((agent) => agent !== event.agent);
    return heldBy.length > 0 ? [{ file, heldBy }] : [];
  });
  return { ...event, result: { ...event.result, clashes } };
}

/** The steps a replay has reached by `t`. */
export function stepsAt(steps: WireStep[], t: number): WireStep[] {
  return steps.filter((step) => (ms(step.at) ?? Infinity) <= t);
}
