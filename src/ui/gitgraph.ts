// The race as a git graph: main on top, one lane per fork, a dot per push, and the winner's
// merge back into main. Pure, like board.ts: times in, positions (0..1) out.
import { colorFor, displayName } from "./board";
import type { WireTask } from "./board";
import { fusionView } from "./fusion";

/** One push to a fork, as a dot on its lane. */
export interface PushDot {
  agent: string;
  at: number; // ms
  commits: number; // commits in this push
  commit?: string;
  message?: string;
  approx?: boolean; // the time is estimated (the task kept only a count)
}

/**
 * What the graph is drawn from: the agents, their pushes and end times, the merge, and the time
 * now.
 */
export interface GraphInput {
  agents: string[];
  start: number; // the fork point: when the race started
  ends: Record<string, number | undefined>; // when each agent ended, if it has
  dots: PushDot[];
  merge?: { agent: string; at: number; commit?: string };
  fusion?: FusionInput;
  t: number; // now (live) or the replay time
  domainEnd: number; // the time at the right edge
}

/** A push dot placed on its lane: x is 0..1 across the graph. */
export interface LaneDot {
  key: string;
  x: number;
  commits: number;
  approx: boolean;
  label: string;
}

/** One fork's lane: its robot, where it stops, and its dots. */
export interface Lane {
  agent: string;
  name: string;
  color: string;
  endX: number; // where the lane's line stops
  ended: boolean;
  won: boolean;
  dots: LaneDot[];
}

/**
 * The graph to draw: the fork point, the now line, the lanes and the merge, all as 0..1 x
 * positions.
 */
export interface GitGraph {
  forkX: number;
  nowX: number;
  lanes: Lane[];
  merge?: { agent: string; x: number; commit?: string };
  fusion?: GraphFusion;
}

/** The fusion round, at the time the judge finished: each loser's try on the winner's fork. */
export interface FusionInput {
  at: number; // ms
  winner: string;
  commit?: string; // short
  hash?: string; // full, to open the commit
  author?: string; // the agent who wrote the fusion commit
  tries: { agent: string; added: boolean; files: string[]; what?: string; note?: string }[]; // what: a hunk's label, else the files
}

/** The fusion round placed on the graph: arrows from losers' lanes into the winner's lane at x. */
export interface GraphFusion {
  x: number;
  winner: string;
  commit?: string; // short
  hash?: string; // full, to open the commit
  author?: string; // the agent who wrote the fusion commit
  tries: { agent: string; added: boolean; label: string }[];
}

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Every push of the race. A task with a push log has exact times; an older one keeps only the
 * count and the last time, so earlier pushes are spread evenly over the agent's run.
 */
export function pushDots(task: WireTask): PushDot[] {
  return task.agents.flatMap((slot): PushDot[] => {
    const push = slot.push;
    if (push === undefined) return [];
    const logged = (push.log ?? []).flatMap((entry): PushDot[] => {
      const at = ms(entry.at);
      if (at === undefined) return [];
      return [{ agent: slot.name, at, commits: entry.commits, commit: entry.commit, ...(entry.message === undefined ? {} : { message: entry.message }) }];
    });
    if (logged.length > 0) return logged;
    const last = ms(push.lastPushAt);
    if (last === undefined) return [];
    const count = Math.max(1, push.pushes ?? push.seen?.length ?? 1);
    const from = ms(slot.startedAt) ?? ms(task.startedAt) ?? last;
    const gap = count > 1 ? Math.max(0, last - from) / count : 0;
    let before = 0;
    return Array.from({ length: count }, (_, i): PushDot => {
      const n = i + 1;
      const total = n === count ? push.commits : Math.max(n, Math.round((push.commits * n) / count));
      const commits = Math.max(0, total - before);
      before = total;
      const dot: PushDot = { agent: slot.name, at: Math.round(last - (count - n) * gap), commits };
      if (n === count && push.head !== undefined) dot.commit = push.head;
      if (n !== count) dot.approx = true;
      return dot;
    });
  });
}

/** The merge into main, once the verdict says the winner merged. */
export function mergeOf(task: WireTask): GraphInput["merge"] {
  const v = task.verdict;
  const at = ms(v?.judgedAt) ?? ms(task.finishedAt);
  if (v === undefined || v.winner === null || v.ship?.status !== "merged" || at === undefined) return undefined;
  return { agent: v.winner, at, ...(v.ship.commit === undefined ? {} : { commit: v.ship.commit }) };
}

/** The fusion round of a judged race, or undefined when there was none. */
export function fusionOf(task: WireTask): FusionInput | undefined {
  const view = fusionView(task.verdict);
  const at = ms(task.verdict?.judgedAt) ?? ms(task.finishedAt);
  if (view === undefined || at === undefined || view.rows.length === 0) return undefined;
  return {
    at,
    winner: view.winner,
    ...(view.commit === undefined ? {} : { commit: view.commit }),
    ...(view.hash === undefined ? {} : { hash: view.hash }),
    ...(view.author === undefined ? {} : { author: view.author }),
    tries: view.rows.map((r) => ({ agent: r.agent, added: r.outcome === "added", files: r.files, what: r.what, ...(r.note === undefined ? {} : { note: r.note }) })),
  };
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function shortSha(commit: string | undefined): string | undefined {
  return commit === undefined ? undefined : commit.slice(0, 7);
}

/** Places every lane and dot at time `input.t`, so a replay draws the graph as it was. */
export function gitGraph(input: GraphInput): GitGraph {
  const { start, t } = input;
  const span = Math.max(1, Math.max(input.domainEnd, t) - start);
  const x = (at: number): number => clamp01((at - start) / span);
  const merge = input.merge !== undefined && input.merge.at <= t ? input.merge : undefined;
  const lanes = input.agents.map((agent): Lane => {
    const end = input.ends[agent];
    const ended = end !== undefined && end <= t;
    const dots = input.dots
      .filter((d) => d.agent === agent && d.at <= t)
      .toSorted((a, b) => a.at - b.at)
      .map((d, i): LaneDot => {
        const sha = shortSha(d.commit);
        const what = `${d.commits} commit${d.commits === 1 ? "" : "s"}`;
        const label = [sha, d.message, what].filter((s) => s !== undefined && s !== "").join(" · ");
        return { key: `${agent}:${i}`, x: x(d.at), commits: d.commits, approx: d.approx === true, label };
      });
    const lastDot = dots.at(-1)?.x ?? 0;
    const endX = Math.max(lastDot, x(ended ? end : t));
    return { agent, name: displayName(agent), color: colorFor(agent), endX, ended, won: merge?.agent === agent, dots };
  });
  return {
    forkX: 0,
    nowX: x(t),
    lanes,
    ...(merge === undefined ? {} : { merge: { agent: merge.agent, x: x(merge.at), ...(merge.commit === undefined ? {} : { commit: shortSha(merge.commit) }) } }),
    ...(input.fusion === undefined || input.fusion.at > t ? {} : { fusion: placeFusion(input.fusion, x) }),
  };
}

function placeFusion(fusion: FusionInput, x: (at: number) => number): GraphFusion {
  return {
    x: x(fusion.at),
    winner: fusion.winner,
    ...(fusion.commit === undefined ? {} : { commit: fusion.commit }),
    ...(fusion.hash === undefined ? {} : { hash: fusion.hash }),
    ...(fusion.author === undefined ? {} : { author: fusion.author }),
    tries: fusion.tries.map((t) => {
      const files = t.what ?? t.files.join(", ");
      const label = t.added
        ? `${displayName(t.agent)}'s ${files}: fused into ${displayName(fusion.winner)}'s fork`
        : `${displayName(t.agent)}'s ${files}: left out${t.note === undefined ? "" : ` (${t.note})`}`;
      return { agent: t.agent, added: t.added, label };
    }),
  };
}
