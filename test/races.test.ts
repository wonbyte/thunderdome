import { describe, expect, it } from "vitest";

import type { AgentName } from "../src/agents/prompt";
import type { Claim } from "../src/room/claims";
import { MEMORY_MAX, MEMORY_PROMPT_MAX, RACE_INDEX_MAX, RACE_LIST_LIMIT, raceMemory, summaryOf, upsertRace, type RaceSummary } from "../src/room/races";
import type { AgentSlot, Task, Verdict } from "../src/room/task";

function slot(name: AgentName): AgentSlot {
  return { name, fork: `t-0123abcd-${name}`, remote: `https://example.test/${name}.git`, defaultBranch: "main", status: "idle" };
}

function baseTask(): Task {
  return {
    id: "t-0123abcd",
    repo: "demo",
    prompt: "Add a dark mode",
    status: "ready",
    createdAt: "2025-01-01T00:00:00.000Z",
    agents: [slot("ponder"), slot("zippy"), slot("snip")],
  };
}

function claim(agent: string, file: string): Claim {
  return { agent, file, shared: false, at: "2025-01-01T00:01:00.000Z" };
}

function race(id: string, createdAt: string, prompt = "p"): RaceSummary {
  return { id, prompt, status: "ready", createdAt, agents: ["ponder"], clash: false };
}

describe("summaryOf", () => {
  it("L1: summaryOf copies the task fields, agent names and winner (only when there is a verdict), and sets clash", () => {
    const plain = summaryOf(baseTask(), []);
    expect(plain).toEqual({
      id: "t-0123abcd",
      prompt: "Add a dark mode",
      repo: "demo",
      status: "ready",
      createdAt: "2025-01-01T00:00:00.000Z",
      agents: ["ponder", "zippy", "snip"],
      clash: false,
    });
    for (const key of ["template", "startedAt", "finishedAt", "winner"]) expect(Object.hasOwn(plain, key), key).toBe(false);

    const judged: Task = {
      ...baseTask(),
      template: "starter",
      status: "finished",
      startedAt: "2025-01-01T00:02:00.000Z",
      finishedAt: "2025-01-01T00:30:00.000Z",
      error: { error: "x" },
      verdict: { winner: "zippy", why: "best", judgedAt: "2025-01-01T00:31:00.000Z", ship: { status: "merged", winner: "zippy", locks: [] } },
    };
    const summary = summaryOf(judged, [claim("ponder", "a.ts"), claim("zippy", "a.ts")]);
    expect(summary).toEqual({
      id: "t-0123abcd",
      prompt: "Add a dark mode",
      template: "starter",
      repo: "demo",
      status: "finished",
      createdAt: "2025-01-01T00:00:00.000Z",
      startedAt: "2025-01-01T00:02:00.000Z",
      finishedAt: "2025-01-01T00:30:00.000Z",
      agents: ["ponder", "zippy", "snip"],
      winner: "zippy",
      judgedAt: "2025-01-01T00:31:00.000Z",
      clash: false, // two agents on a.ts, but no score lost points for it
    });
    for (const key of ["error", "verdict", "basePreview", "headline", "commit"]) expect(Object.hasOwn(summary, key), key).toBe(false);

    // A verdict with no winner keeps winner: null.
    const noWinner: Task = { ...judged, verdict: { winner: null, why: "none", judgedAt: "x", ship: { status: "no-winner", winner: null, locks: [] } } };
    const none = summaryOf(noWinner, []);
    expect(Object.hasOwn(none, "winner")).toBe(true);
    expect(none.winner).toBeNull();

  });

  it("L12: clash is true only when two agents claimed one file and some fork lost the shared-claim points", () => {
    const scored = (claimPart: number): Task => ({
      ...baseTask(),
      verdict: {
        winner: "zippy",
        why: "best",
        judgedAt: "x",
        ship: { status: "merged", winner: "zippy", locks: [] },
        scores: [
          { agent: "zippy", total: 90, eligible: true, parts: { tests: 50, taskFit: 20, clarity: 10, claim: 10 } },
          { agent: "snip", total: 80, eligible: true, parts: { tests: 45, taskFit: 15, clarity: 10, claim: claimPart } },
        ],
      },
    });
    const clashed = [claim("ponder", "a.ts"), claim("zippy", "b.ts"), claim("snip", "b.ts")];
    expect(summaryOf(scored(8), clashed).clash).toBe(true);
    // A clash that cost nothing, or a claim penalty for an unclaimed file (0 points), is not news.
    expect(summaryOf(scored(10), clashed).clash).toBe(false);
    expect(summaryOf(scored(0), clashed).clash).toBe(false);
    // One agent claiming the same file twice, or agents on different files, is not a clash.
    expect(summaryOf(scored(8), [claim("ponder", "a.ts"), claim("ponder", "a.ts"), claim("zippy", "b.ts")]).clash).toBe(false);
  });

  it("X3: summaryOf copies scores (agent and total, ranked order) and decidedBy only when the verdict has them", () => {
    const base: Verdict = { winner: "zippy", why: "best", judgedAt: "2025-01-01T00:31:00.000Z", ship: { status: "merged", winner: "zippy", locks: [] } };
    const scores = [
      { agent: "zippy", total: 91.5, eligible: true, parts: { tests: 50, taskFit: 20, clarity: 11.5, claim: 10 } },
      { agent: "snip", total: 80, eligible: true, parts: { tests: 45, taskFit: 15, clarity: 10, claim: 10 } },
      { agent: "ponder", total: 50, eligible: false, parts: { tests: 0, taskFit: 25, clarity: 15, claim: 10 } },
    ];
    const task: Task = { ...baseTask(), status: "finished", verdict: { ...base, scores, decidedBy: "code" } };
    const summary = summaryOf(task, []);
    // Only agent and total, in the verdict's ranked order.
    expect(summary.scores).toEqual([
      { agent: "zippy", total: 91.5 },
      { agent: "snip", total: 80 },
      { agent: "ponder", total: 50 },
    ]);
    expect(summary.decidedBy).toBe("code");
    expect(summary.scores?.[0]).not.toBe(scores[0]);
    expect(task.verdict?.scores?.[0]?.parts.tests).toBe(50);

    // Scores without decidedBy (no eligible runner-up): only scores.
    const scoresOnly = summaryOf({ ...task, verdict: { ...base, scores: scores.slice(0, 1) } }, []);
    expect(scoresOnly.scores).toEqual([{ agent: "zippy", total: 91.5 }]);
    expect(Object.hasOwn(scoresOnly, "decidedBy")).toBe(false);

    // decidedBy without scores: only decidedBy.
    const decidedOnly = summaryOf({ ...task, verdict: { ...base, decidedBy: "claims" } }, []);
    expect(decidedOnly.decidedBy).toBe("claims");
    expect(Object.hasOwn(decidedOnly, "scores")).toBe(false);

    // An older verdict, or no verdict: neither key.
    for (const old of [{ ...task, verdict: base }, baseTask()]) {
      const s = summaryOf(old, []);
      expect(Object.hasOwn(s, "scores")).toBe(false);
      expect(Object.hasOwn(s, "decidedBy")).toBe(false);
    }
  });
});

describe("upsertRace", () => {
  it("L2: upsertRace replaces by id, sorts newest first, caps at max, and leaves its input unchanged", () => {
    expect(RACE_INDEX_MAX).toBe(200);
    expect(RACE_LIST_LIMIT).toBe(50);

    const list = [race("t-00000003", "2025-01-03"), race("t-00000001", "2025-01-01")];
    const before = structuredClone(list);
    Object.freeze(list);
    list.forEach((item) => Object.freeze(item));

    // Insert sorts by createdAt descending.
    const inserted = upsertRace(list, race("t-00000002", "2025-01-02"));
    expect(inserted.map((r) => r.id)).toEqual(["t-00000003", "t-00000002", "t-00000001"]);

    // Replace by id, with no duplicate.
    const replaced = upsertRace(list, race("t-00000001", "2025-01-01", "changed"));
    expect(replaced.map((r) => r.id)).toEqual(["t-00000003", "t-00000001"]);
    expect(replaced[1]?.prompt).toBe("changed");

    // Ties keep the new entry first.
    const tied = upsertRace(list, race("t-00000009", "2025-01-03"));
    expect(tied.map((r) => r.id)).toEqual(["t-00000009", "t-00000003", "t-00000001"]);

    // Caps at max, dropping the oldest.
    const capped = upsertRace(list, race("t-00000004", "2025-01-04"), 2);
    expect(capped.map((r) => r.id)).toEqual(["t-00000004", "t-00000003"]);

    // Default cap is RACE_INDEX_MAX.
    const many = Array.from({ length: RACE_INDEX_MAX }, (_, i) => race(`t-${String(i).padStart(8, "0")}`, `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`));
    expect(upsertRace(many, race("t-ffffffff", "2026-01-01"))).toHaveLength(RACE_INDEX_MAX);

    // The input array and its items are unchanged, and the result is a new array.
    expect(list).toEqual(before);
    expect(inserted).not.toBe(list);
  });
});

describe("race memory", () => {
  it("keeps the judge's headline and the merge commit in the summary", () => {
    const task: Task = {
      ...baseTask(),
      status: "finished",
      verdict: { winner: "zippy", why: "w", headline: "Decided by code: zippy won.", lesson: "its tests passed", judgedAt: "x", ship: { status: "merged", winner: "zippy", commit: "c0ffee1234", locks: [] } },
    };
    expect(summaryOf(task, [])).toMatchObject({ headline: "Decided by code: zippy won.", lesson: "its tests passed", commit: "c0ffee1234" });
    const conflict: Task = { ...task, verdict: { ...task.verdict!, ship: { status: "conflict", winner: "zippy", locks: [] } } };
    expect(Object.hasOwn(summaryOf(conflict, []), "commit")).toBe(false);
  });

  const judged = (id: string, over: Partial<RaceSummary> = {}): RaceSummary => ({
    ...race(id, "2025-01-01T00:00:00.000Z", `task ${id}`),
    status: "finished",
    repo: `src-${id}`,
    template: "thunderdome-ui",
    winner: "testy",
    headline: `why ${id}`,
    lesson: `point ${id}`,
    commit: `commit-${id}`,
    ...over,
  });

  it("remembers the newest judged races with a winner on the same template, without their commits", () => {
    const races = [
      judged("t-0000000a"),
      judged("t-0000000b", { winner: null }),
      judged("t-0000000c", { winner: undefined, status: "running" }),
      judged("t-0000000d", { template: "thunderdome-bugs" }),
      judged("t-0000000e"),
      judged("t-0000000f"),
      judged("t-00000010"),
    ];
    const memory = raceMemory(races, { id: "t-0000000a", template: "thunderdome-ui", repo: "src-new" });
    expect(memory).toEqual(
      ["t-0000000e", "t-0000000f", "t-00000010"].map((id) => ({ id, prompt: `task ${id}`, winner: "testy", headline: `why ${id}`, lesson: `point ${id}` })),
    );
    expect(memory).toHaveLength(MEMORY_MAX);
  });

  it("on a given repo, remembers only races on that repo and names their merge, and clips long prompts", () => {
    const long = "x".repeat(MEMORY_PROMPT_MAX + 50);
    const races = [
      judged("t-00000001", { template: undefined, repo: "shop", prompt: long }),
      judged("t-00000002", { template: undefined, repo: "other" }),
      judged("t-00000003", { repo: "shop" }), // a template race whose source happens to share the name
    ];
    const [only, ...rest] = raceMemory(races, { id: "t-00000009", repo: "shop" });
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: "t-00000001", commit: "commit-t-00000001" });
    expect(only?.prompt).toHaveLength(MEMORY_PROMPT_MAX);
    expect(only?.prompt.endsWith("…")).toBe(true);
  });
});
