import { describe, expect, it } from "vitest";

import type { WireTask } from "../src/ui/board";
import { ganttOf } from "../src/ui/gantt";

const T0 = Date.parse("2026-10-07T18:24:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const at = (s: number) => T0 + s * 1000;

// A judged race: ponder's second push got a preview, its first did not; zippy's one push did.
function judgedTask(): WireTask {
  return {
    id: "t-0123abcd",
    prompt: "Fix the cart",
    status: "finished",
    startedAt: iso(0),
    finishedAt: iso(60),
    basePreview: { url: "https://base.example", commit: "b0", at: iso(15) },
    agents: [
      {
        name: "ponder",
        status: "done",
        startedAt: iso(0),
        endedAt: iso(60),
        push: { commits: 2, preview: { url: "https://p.example", commit: "c2", at: iso(50) }, log: [{ at: iso(30), commit: "c1", commits: 1 }, { at: iso(40), commit: "c2", commits: 1 }] },
      },
      { name: "zippy", status: "done", startedAt: iso(0), endedAt: iso(45), push: { commits: 1, preview: { url: "https://z.example", commit: "f1", at: iso(44) }, log: [{ at: iso(35), commit: "f1", commits: 1 }] } },
    ],
    judging: [
      { name: "look", state: "done", startedAt: iso(61), endedAt: iso(70) },
      { name: "fork zippy", state: "done", startedAt: iso(61), endedAt: iso(66) },
      { name: "fork ponder", state: "done", startedAt: iso(61), endedAt: iso(67) },
      { name: "ship", state: "done", startedAt: iso(80), endedAt: iso(85) },
    ],
    verdict: { winner: "ponder", why: "Best fix.", judgedAt: iso(86), ship: { status: "merged", commit: "abcdef1234567" } },
  };
}

describe("ganttOf", () => {
  it("T1: rows are the base preview, each agent with its builds, then the judge steps by start", () => {
    const gantt = ganttOf(judgedTask(), at(86));
    expect(gantt?.rows.map((r) => r.key)).toEqual(["base", "agent:ponder", "build:ponder:0", "build:ponder:1", "agent:zippy", "build:zippy:0", "judge:look", "judge:fork zippy", "judge:fork ponder", "judge:ship"]);
    expect(gantt?.rows.map((r) => r.product)).toEqual(["previews", "containers", "previews", "previews", "containers", "previews", "ai", "containers", "containers", "merge"]);
    expect(gantt?.rows[0]).toMatchObject({ from: at(0), to: at(15), title: "base preview · 15.0 s" });
    expect(gantt?.start).toBe(at(0));
  });

  it("T2: a build with no preview ends at its 80 s limit, estimated, but never past the race's end", () => {
    const rows = ganttOf(judgedTask(), at(86))?.rows ?? [];
    expect(rows.find((r) => r.key === "build:ponder:1")).toMatchObject({ from: at(40), to: at(50), approx: false });
    // c1 was superseded before its preview: 30 s + 80 s would be 110 s, past the verdict at 86 s.
    expect(rows.find((r) => r.key === "build:ponder:0")).toMatchObject({ from: at(30), to: at(86), approx: true });
    expect(rows.find((r) => r.key === "build:ponder:0")?.title).toContain("(estimated)");
  });

  it("T3: an agent still running and a running judge step end at now", () => {
    const task = judgedTask();
    task.status = "running";
    delete task.agents[0]!.endedAt;
    task.judging = [{ name: "fork zippy", state: "running", startedAt: iso(50) }];
    delete task.verdict;
    const gantt = ganttOf(task, at(55));
    expect(gantt?.rows.find((r) => r.key === "agent:ponder")).toMatchObject({ to: at(55), running: true, title: "Ponder · 55.0 s so far" });
    expect(gantt?.rows.find((r) => r.key === "judge:fork zippy")).toMatchObject({ to: at(55), running: true });
    expect(gantt?.marks).toEqual([]);
    expect(ganttOf({ ...task, startedAt: undefined }, at(55))).toBeUndefined();
  });

  it("T4: the merge mark shows when the winner merged, else the verdict mark", () => {
    const merged = ganttOf(judgedTask(), at(86));
    expect(merged?.marks).toEqual([{ key: "merge", label: "merge into main abcdef1", product: "merge", at: at(86) }]);
    expect(merged?.end).toBe(at(86));
    const task = judgedTask();
    task.verdict = { winner: "ponder", why: "Best fix.", judgedAt: iso(86), ship: { status: "conflict" } };
    expect(ganttOf(task, at(86))?.marks.map((m) => m.key)).toEqual(["verdict"]);
  });
});
