// The race gallery: one short summary per task, newest first. Pure, with type-only imports,
// so it never pulls in cloudflare:workers and the tests run it in plain Node.
import type { DecidedBy } from "../judge/why";
import type { Claim } from "./claims";
import type { Task, TaskStatus } from "./task";

// Summaries the index keeps, and how many GET /tasks returns.
export const RACE_INDEX_MAX = 200;
export const RACE_LIST_LIMIT = 50;

export type RaceScore = { agent: string; total: number };

export interface RaceSummary {
  id: string;
  prompt: string;
  template?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  agents: string[];
  winner?: string | null; // only once judged
  scores?: RaceScore[]; // ranked order, only when the verdict has scores
  decidedBy?: DecidedBy; // only when the verdict has it
  clash: boolean;
}

// The summary of one task. Optional fields appear only when the task has them.
export function summaryOf(task: Task, history: Claim[]): RaceSummary {
  const v = task.verdict;
  return {
    id: task.id,
    prompt: task.prompt,
    ...(task.template === undefined ? {} : { template: task.template }),
    status: task.status,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    agents: task.agents.map((slot) => slot.name),
    ...(v === undefined ? {} : { winner: v.winner }),
    ...(v?.scores === undefined ? {} : { scores: v.scores.map(({ agent, total }) => ({ agent, total })) }),
    ...(v?.decidedBy === undefined ? {} : { decidedBy: v.decidedBy }),
    clash: hasClash(history),
  };
}

// True when some file was claimed by two or more different agents.
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

// A new list with summary in place of any entry with its id, newest first, at most max long.
// The new summary goes first, so the stable sort keeps it ahead of entries with the same createdAt.
export function upsertRace(list: readonly RaceSummary[], summary: RaceSummary, max: number = RACE_INDEX_MAX): RaceSummary[] {
  return [summary, ...list.filter((race) => race.id !== summary.id)]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, Math.max(0, max));
}
