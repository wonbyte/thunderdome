import { DurableObject } from "cloudflare:workers";

import { RACE_INDEX_MAX, RACE_LIST_LIMIT, upsertRace, type RaceSummary } from "./races";

const RACES_KEY = "races";

// Prompt characters kept per summary. The whole list is one KV value (2 MB max), and a prompt
// may be 10,000 chars, so 200 full prompts would not fit. 280 keeps the list well under 1 MB.
export const SUMMARY_PROMPT_MAX = 280;

// One instance, "all": the race list for GET /tasks and the gallery. TaskRooms record each change.
export class RaceIndex extends DurableObject<Env> {
  // Adds the summary, or replaces the one with its id. Keeps the newest RACE_INDEX_MAX.
  record(summary: RaceSummary): void {
    const races = upsertRace(this.#races().map(clipped), clipped(summary), RACE_INDEX_MAX);
    this.ctx.storage.kv.put(RACES_KEY, races);
  }

  // Drops the races with these ids.
  remove(ids: string[]): void {
    const drop = new Set(ids);
    this.ctx.storage.kv.put(RACES_KEY, this.#races().filter((race) => !drop.has(race.id)));
  }

  // Newest first, at most limit.
  list(limit: number = RACE_LIST_LIMIT): RaceSummary[] {
    return this.#races().slice(0, Math.max(0, limit));
  }

  #races(): RaceSummary[] {
    return this.ctx.storage.kv.get<RaceSummary[]>(RACES_KEY) ?? [];
  }
}

// The summary with its prompt cut to SUMMARY_PROMPT_MAX chars (a new object).
function clipped(summary: RaceSummary): RaceSummary {
  if (summary.prompt.length <= SUMMARY_PROMPT_MAX) return summary;
  return { ...summary, prompt: `${summary.prompt.slice(0, SUMMARY_PROMPT_MAX - 1)}…` };
}
