// Retention: judged races older than the retention period lose their Artifacts repos (the
// forks, and a source repo made from a template). The race itself stays: its replay, scores and
// saved diffs live in the room. Runs daily from the cron trigger, or from POST /admin/retain.
import { RACE_INDEX_MAX, RACE_INDEX_NAME, RACE_LIST_LIMIT, retentionPicks } from "../room/races";

type RetainEnv = Pick<Env, "TASK_ROOM" | "RACE_INDEX"> & { RACE_RETENTION_DAYS?: string };
/** Days a judged race keeps its repos when RACE_RETENTION_DAYS is unset or not a number. */
export const DEFAULT_RETENTION_DAYS = 30;

/** What one run did. */
export interface RetainResult {
  days: number;
  released: { id: string; deleted: string[] }[];
  skipped: { id: string; error: string }[];
}

/** The retention period from the env, in days. */
export function retentionDays(env: { RACE_RETENTION_DAYS?: string }): number {
  const days = Number(env.RACE_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

/** Deletes the repos of every race past retention, one room at a time so Artifacts is not flooded. */
export async function retainRaces(env: RetainEnv, now: number = Date.now()): Promise<RetainResult> {
  const days = retentionDays(env);
  const index = env.RACE_INDEX.getByName(RACE_INDEX_NAME);
  // The races off the list come after it, so the gallery's newest RACE_LIST_LIMIT are still skipped.
  const races = [...(await index.list(RACE_INDEX_MAX)), ...(await index.pending())];
  const result: RetainResult = { days, released: [], skipped: [] };
  for (const race of retentionPicks(races, now, days, RACE_LIST_LIMIT)) {
    const out = await env.TASK_ROOM.getByName(race.id).releaseRepos();
    if (out.ok) result.released.push({ id: race.id, deleted: out.deleted });
    else result.skipped.push({ id: race.id, error: out.error });
  }
  if (result.released.length > 0 || result.skipped.length > 0) console.log({ event: "retain.ran", days, released: result.released.length, skipped: result.skipped.length });
  return result;
}
