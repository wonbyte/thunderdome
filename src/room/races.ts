// The race gallery: one short summary per task, newest first. Pure, with type-only imports,
// so it never pulls in cloudflare:workers and the tests run it in plain Node.
import type { DecidedBy } from "../judge/why";
import type { Claim } from "./claims";
import type { Task, TaskStatus } from "./task";

/** Summaries the index keeps, and how many GET /tasks returns. */
export const RACE_INDEX_MAX = 200;
/** Summaries one GET /tasks page returns. */
export const RACE_LIST_LIMIT = 50;

/** Past races a new race remembers, and the characters of each past prompt it keeps. */
export const MEMORY_MAX = 3;
/** Characters of each remembered prompt that a new race keeps. */
export const MEMORY_PROMPT_MAX = 200;

/** One robot's total in a race summary. */
export type RaceScore = { agent: string; total: number };

/** What a new race is told about one earlier judged race on the same app. */
export interface RaceMemory {
  id: string;
  prompt: string; // clipped to MEMORY_PROMPT_MAX
  winner: string;
  headline?: string; // the judge's one-line reason
  lesson?: string; // the winner's strongest point, as a clause
  commit?: string; // the winner's merge, only when it landed in the repo the new race forks
}

/** One race in the gallery: enough to draw its card and the leaderboard without loading the task. */
export interface RaceSummary {
  id: string;
  prompt: string;
  template?: string;
  repo?: string; // the source repo; missing on older summaries
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  agents: string[];
  winner?: string | null; // only once judged
  scores?: RaceScore[]; // ranked order, only when the verdict has scores
  decidedBy?: DecidedBy; // only when the verdict has it
  headline?: string; // the judge's one-line reason, only when the verdict has it
  lesson?: string; // the winner's strongest point, only when the verdict has it
  commit?: string; // the merge commit, only when the winner merged
  fused?: string[]; // agents whose files the fusion round added and the winner merged: the race's assists
  losing?: Record<string, number>; // shipped lines by each robot that lost (git blame of the merge); only races with blame
  team?: number; // fused score minus the winner's alone, 1 decimal, when a scored fusion shipped
  clash: boolean;
}

/** The summary of one task. Optional fields appear only when the task has them. */
export function summaryOf(task: Task, history: Claim[]): RaceSummary {
  const v = task.verdict;
  return {
    id: task.id,
    prompt: task.prompt,
    ...(task.template === undefined ? {} : { template: task.template }),
    repo: task.repo,
    status: task.status,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    agents: task.agents.map((slot) => slot.name),
    ...(v === undefined ? {} : { winner: v.winner }),
    ...(v?.scores === undefined ? {} : { scores: v.scores.map(({ agent, total }) => ({ agent, total })) }),
    ...(v?.decidedBy === undefined ? {} : { decidedBy: v.decidedBy }),
    ...(v?.headline === undefined ? {} : { headline: v.headline }),
    ...(v?.lesson === undefined ? {} : { lesson: v.lesson }),
    ...(v?.ship.status === "merged" && v.ship.commit !== undefined ? { commit: v.ship.commit } : {}),
    ...fusedOf(task),
    ...losingOf(task),
    ...teamOf(task),
    clash: hasClash(history),
  };
}

/** `{ losing }`: lines in the merge written by robots that lost, from the ship's blame; else nothing. */
function losingOf(task: Task): { losing?: Record<string, number> } {
  const v = task.verdict;
  const blame = v?.ship.status === "merged" ? v.ship.blame : undefined;
  if (blame === undefined || v === undefined) return {};
  const robots = new Set(task.agents.map((slot) => slot.name as string));
  const losing = Object.fromEntries(Object.entries(blame).filter(([agent, lines]) => agent !== v.winner && robots.has(agent) && lines > 0));
  return Object.keys(losing).length === 0 ? {} : { losing };
}

/** `{ team }`: how much the shipped fusion beat the winner alone by, when it was scored; else nothing. */
function teamOf(task: Task): { team?: number } {
  const v = task.verdict;
  const score = v?.fusion?.score;
  if (v?.ship.status !== "merged" || v.fusion?.commit === undefined || score === undefined) return {};
  return { team: Math.round((score.after.total - score.before.total) * 10) / 10 };
}

/** `{ fused }` when the fusion round added a loser's files and the winner merged them, else nothing. */
function fusedOf(task: Task): { fused?: string[] } {
  const v = task.verdict;
  if (v?.ship.status !== "merged" || v.fusion === undefined) return {};
  const fused = [...new Set(v.fusion.tried.filter((t) => t.status === "added").map((t) => t.agent))];
  return fused.length === 0 ? {} : { fused };
}

/** True when some file was claimed by two or more different agents. */
function hasClash(history: Claim[]): boolean {
  const agentsByFile = new Map<string, Set<string>>();
  for (const claim of history) {
    const agents = agentsByFile.get(claim.file) ?? new Set<string>();
    agents.add(claim.agent);
    agentsByFile.set(claim.file, agents);
    if (agents.size >= 2) return true;
  }
  return false;
}

/**
 * A new list with summary in place of any entry with its id, newest first, at most max long.
 * The new summary goes first, so the stable sort keeps it ahead of entries with the same createdAt.
 */
export function upsertRace(list: readonly RaceSummary[], summary: RaceSummary, max: number = RACE_INDEX_MAX): RaceSummary[] {
  return [summary, ...list.filter((race) => race.id !== summary.id)]
    .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, Math.max(0, max));
}

/**
 * The newest judged races with a winner on the same app as a new race: the same template, or for
 * a race on a given repo, the same repo. A template race forks a fresh copy, so its winner's code
 * is not in the new race's repo; only a same-repo memory names the merge commit.
 */
export function raceMemory(races: readonly RaceSummary[], app: { id: string; template?: string; repo: string }): RaceMemory[] {
  const same = (r: RaceSummary): boolean => (app.template === undefined ? r.template === undefined && r.repo === app.repo : r.template === app.template);
  return races
    .filter((r) => r.id !== app.id && typeof r.winner === "string" && same(r))
    .slice(0, MEMORY_MAX)
    .map((r) => ({
      id: r.id,
      prompt: r.prompt.length <= MEMORY_PROMPT_MAX ? r.prompt : `${r.prompt.slice(0, MEMORY_PROMPT_MAX - 1)}…`,
      winner: r.winner as string,
      ...(r.headline === undefined ? {} : { headline: r.headline }),
      ...(r.lesson === undefined ? {} : { lesson: r.lesson }),
      ...(app.template === undefined && r.commit !== undefined ? { commit: r.commit } : {}),
    }));
}
