import { describe, expect, it } from "vitest";

import type { AgentName } from "../src/agents/prompt";
import type { Claim } from "../src/room/claims";
import { RACE_INDEX_MAX, RACE_LIST_LIMIT, summaryOf, upsertRace, type RaceSummary } from "../src/room/races";
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
    agents: [slot("careful"), slot("fast"), slot("lean")],
  };
}

function claim(agent: string, file: string): Claim {
  return { agent, file, shared: false, at: "2025-01-01T00:01:00.000Z" };
}

function race(id: string, createdAt: string, prompt = "p"): RaceSummary {
  return { id, prompt, status: "ready", createdAt, agents: ["careful"], clash: false };
}

describe("summaryOf", () => {
  it("L1: summaryOf copies the task fields, agent names and winner (only when there is a verdict), and sets clash from the claim history", () => {
    const plain = summaryOf(baseTask(), []);
    expect(plain).toEqual({
      id: "t-0123abcd",
      prompt: "Add a dark mode",
      status: "ready",
      createdAt: "2025-01-01T00:00:00.000Z",
      agents: ["careful", "fast", "lean"],
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
      verdict: { winner: "fast", why: "best", judgedAt: "2025-01-01T00:31:00.000Z", ship: { status: "merged", winner: "fast", locks: [] } },
    };
    const summary = summaryOf(judged, [claim("careful", "a.ts"), claim("fast", "a.ts")]);
    expect(summary).toEqual({
      id: "t-0123abcd",
      prompt: "Add a dark mode",
      template: "starter",
      status: "finished",
      createdAt: "2025-01-01T00:00:00.000Z",
      startedAt: "2025-01-01T00:02:00.000Z",
      finishedAt: "2025-01-01T00:30:00.000Z",
      agents: ["careful", "fast", "lean"],
      winner: "fast",
      clash: true,
    });
    for (const key of ["repo", "error", "verdict", "basePreview"]) expect(Object.hasOwn(summary, key), key).toBe(false);

    // A verdict with no winner keeps winner: null.
    const noWinner: Task = { ...judged, verdict: { winner: null, why: "none", judgedAt: "x", ship: { status: "no-winner", winner: null, locks: [] } } };
    const none = summaryOf(noWinner, []);
    expect(Object.hasOwn(none, "winner")).toBe(true);
    expect(none.winner).toBeNull();

    // One agent claiming the same file twice, or agents on different files, is not a clash.
    expect(summaryOf(baseTask(), [claim("careful", "a.ts"), claim("careful", "a.ts"), claim("fast", "b.ts")]).clash).toBe(false);
    expect(summaryOf(baseTask(), [claim("careful", "a.ts"), claim("fast", "b.ts"), claim("lean", "b.ts")]).clash).toBe(true);
  });

  it("X3: summaryOf copies scores (agent and total, ranked order) and decidedBy only when the verdict has them", () => {
    const base: Verdict = { winner: "fast", why: "best", judgedAt: "2025-01-01T00:31:00.000Z", ship: { status: "merged", winner: "fast", locks: [] } };
    const scores = [
      { agent: "fast", total: 91.5, eligible: true, parts: { tests: 50, taskFit: 20, clarity: 11.5, claim: 10 } },
      { agent: "lean", total: 80, eligible: true, parts: { tests: 45, taskFit: 15, clarity: 10, claim: 10 } },
      { agent: "careful", total: 50, eligible: false, parts: { tests: 0, taskFit: 25, clarity: 15, claim: 10 } },
    ];
    const task: Task = { ...baseTask(), status: "finished", verdict: { ...base, scores, decidedBy: "code" } };
    const summary = summaryOf(task, []);
    // Only agent and total, in the verdict's ranked order.
    expect(summary.scores).toEqual([
      { agent: "fast", total: 91.5 },
      { agent: "lean", total: 80 },
      { agent: "careful", total: 50 },
    ]);
    expect(summary.decidedBy).toBe("code");
    expect(summary.scores?.[0]).not.toBe(scores[0]);
    expect(task.verdict?.scores?.[0]?.parts.tests).toBe(50);

    // Scores without decidedBy (no eligible runner-up): only scores.
    const scoresOnly = summaryOf({ ...task, verdict: { ...base, scores: scores.slice(0, 1) } }, []);
    expect(scoresOnly.scores).toEqual([{ agent: "fast", total: 91.5 }]);
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
