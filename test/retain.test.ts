import { describe, expect, it } from "vitest";

import { retentionPicks, summaryOf, type RaceSummary } from "../src/room/races";
import type { Task } from "../src/room/task";
import { cached, type EdgeCache } from "../src/routes/cache";
import { retentionDays } from "../src/routes/retain";

const DAY = 86_400_000;
const now = Date.parse("2026-10-07T12:00:00.000Z");

function race(i: number, over: Partial<RaceSummary> = {}): RaceSummary {
  const at = new Date(now - i * DAY).toISOString();
  return { id: `t-${String(i).padStart(8, "0")}`, prompt: "p", status: "finished", createdAt: at, judgedAt: at, agents: ["ponder"], winner: "ponder", clash: false, ...over };
}

describe("retention", () => {
  it("RT1: picks judged races older than the period, never the newest `keep`, never twice", () => {
    const races = [race(0), race(1), race(40), race(45), race(50, { reposGone: true }), race(60), race(70, { winner: undefined, judgedAt: undefined })];
    expect(retentionPicks(races, now, 30, 2).map((r) => r.id)).toEqual([race(40).id, race(45).id, race(60).id]);
    // The newest `keep` stay whatever their age.
    expect(retentionPicks(races, now, 30, 5).map((r) => r.id)).toEqual([race(60).id]);
    expect(retentionPicks(races, now, 100, 0)).toEqual([]);
  });

  it("RT2: an unjudged race uses no date it lacks, and a bad date is never picked", () => {
    expect(retentionPicks([race(90, { judgedAt: "not a date", createdAt: "nope" })], now, 30, 0)).toEqual([]);
    // No judgedAt (older summaries): createdAt stands in.
    expect(retentionPicks([race(90, { judgedAt: undefined })], now, 30, 0)).toHaveLength(1);
  });

  it("RT3: the period comes from RACE_RETENTION_DAYS, with a default for nonsense", () => {
    expect(retentionDays({ RACE_RETENTION_DAYS: "14" })).toBe(14);
    expect(retentionDays({ RACE_RETENTION_DAYS: "soon" })).toBe(30);
    expect(retentionDays({ RACE_RETENTION_DAYS: "0" })).toBe(30);
  });

  it("RT4: a task whose repos were deleted is summarized as reposGone", () => {
    const task = { id: "t-0123abcd", repo: "r", prompt: "p", status: "finished", createdAt: "2026-10-01T00:00:00.000Z", agents: [], reposDeletedAt: "2026-10-07T04:23:00.000Z" } as unknown as Task;
    expect(summaryOf(task, []).reposGone).toBe(true);
    expect(summaryOf({ ...task, reposDeletedAt: undefined }, []).reposGone).toBeUndefined();
  });
});

/** A Cache that keeps responses by URL. */
function fakeCache(): EdgeCache & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (request) => store.get(request.url)?.clone(),
    put: async (request, response) => {
      store.set(request.url, response);
    },
  };
}

describe("edge cache", () => {
  const req = new Request("https://x.test/tasks");
  const pending: Promise<unknown>[] = [];
  const waitUntil = (work: Promise<unknown>) => void pending.push(work);

  it("CA1: a miss produces, stores a 200 with the ttl, and the next call is a hit", async () => {
    const cache = fakeCache();
    let calls = 0;
    const produce = async () => {
      calls += 1;
      return Response.json({ n: calls });
    };
    const first = await cached(cache, req, 10, produce, waitUntil);
    expect(await first.json()).toEqual({ n: 1 });
    expect(first.headers.get("cache-control")).toBe("public, max-age=10");
    await Promise.all(pending);
    const second = await cached(cache, req, 10, produce, waitUntil);
    expect(await second.json()).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it("CA2: errors are not stored, a response's own cache-control is kept, and POSTs and no cache bypass it", async () => {
    const cache = fakeCache();
    await cached(cache, req, 10, async () => Response.json({ error: "x" }, { status: 503 }), waitUntil);
    await Promise.all(pending);
    expect(cache.store.size).toBe(0);
    const own = await cached(cache, req, 10, async () => new Response("png", { headers: { "cache-control": "public, max-age=31536000, immutable" } }), waitUntil);
    expect(own.headers.get("cache-control")).toContain("immutable");
    let calls = 0;
    const count = async () => {
      calls += 1;
      return new Response("ok");
    };
    await cached(cache, new Request("https://x.test/tasks", { method: "POST" }), 10, count, waitUntil);
    await cached(undefined, req, 10, count, waitUntil);
    expect(calls).toBe(2);
  });
});
