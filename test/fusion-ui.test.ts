import { describe, expect, it } from "vitest";

import { FUSE_THRESHOLD } from "../src/judge/fusion";
import { summaryOf } from "../src/room/races";
import type { Task, Verdict } from "../src/room/task";
import { applyEvent, emptyBoard, type WireTask, type WireVerdict } from "../src/ui/board";
import { assistsOf, FUSE_BAR, fusionView } from "../src/ui/fusion";
import { fusionOf, gitGraph } from "../src/ui/gitgraph";
import { raceStats, standings, type RaceRow } from "../src/ui/leaderboard";
import { applyPlatform, emptyPlatform, STAGES } from "../src/ui/platform";

const JUDGED = "2026-10-06T05:40:00.000Z";

function verdict(shipStatus = "merged"): WireVerdict {
  return {
    winner: "testy",
    why: "w",
    judgedAt: JUDGED,
    ship: { status: shipStatus, commit: "33d07d7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    fusion: {
      base: "fd8e0e1",
      commit: "660ef87bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      tried: [
        { agent: "ponder", files: ["test/ponder.test.ts"], status: "added", tests: { passed: 20, total: 20 }, better: 0.6098, question: "coverage" },
        { agent: "zippy", files: ["test/zippy.test.ts"], status: "rejected", tests: { passed: 22, total: 22 }, better: 0.1753, question: "coverage", note: "the judge found nothing new" },
      ],
    },
  };
}

function task(v: WireVerdict | undefined): WireTask {
  return {
    id: "t-e05150fe",
    prompt: "p",
    status: "finished",
    startedAt: "2026-10-06T05:30:00.000Z",
    finishedAt: "2026-10-06T05:38:00.000Z",
    agents: ["ponder", "zippy", "testy"].map((name) => ({ name, status: "done", endedAt: "2026-10-06T05:37:00.000Z" })),
    ...(v === undefined ? {} : { verdict: v }),
  };
}

describe("fusion view", () => {
  it("F1 the page's bar is the judge's threshold", () => {
    expect(FUSE_BAR).toBe(FUSE_THRESHOLD);
  });

  it("F2 fusionView turns each try into a row with its gates, and knows the fusion shipped", () => {
    const view = fusionView(verdict());
    expect(view).toEqual({
      winner: "testy",
      commit: "660ef87",
      shipped: true,
      rows: [
        { agent: "ponder", files: ["test/ponder.test.ts"], outcome: "added", tests: "20/20", green: true, clef: 0.6098, asked: "tests something new the task asks?" },
        { agent: "zippy", files: ["test/zippy.test.ts"], outcome: "rejected", tests: "22/22", green: true, clef: 0.1753, asked: "tests something new the task asks?", note: "the judge found nothing new" },
      ],
    });
  });

  it("F3 no round, no winner or an empty round shows nothing; a round that could not run shows its error", () => {
    expect(fusionView(undefined)).toBeUndefined();
    expect(fusionView({ winner: null, why: "", fusion: verdict().fusion })).toBeUndefined();
    expect(fusionView({ ...verdict(), fusion: { tried: [] } })).toBeUndefined();
    expect(fusionView({ ...verdict(), fusion: { tried: [], error: "sandbox down" } })).toMatchObject({ rows: [], shipped: false, error: "sandbox down" });
  });

  it("F4 an unknown status is a failed try, and Clef's answer is clamped to 0..1", () => {
    const view = fusionView({ ...verdict(), fusion: { tried: [{ agent: "snip", files: ["a.ts"], status: "weird", better: 3 }] } });
    expect(view?.rows[0]).toMatchObject({ outcome: "failed", clef: 1 });
    expect(view?.commit).toBeUndefined();
  });

  it("F5 assists are the added agents, only when the winner merged", () => {
    expect(assistsOf(task(verdict()))).toEqual(["ponder"]);
    expect(assistsOf(task(verdict("conflict")))).toEqual([]);
    expect(fusionView(verdict("conflict"))?.shipped).toBe(false);
  });
});

describe("fusion on the board", () => {
  it("F10 a live verdict keeps its fusion round on the board's task", () => {
    const snapshot = applyEvent(emptyBoard("t-e05150fe"), { kind: "snapshot", taskId: "t-e05150fe", task: task(undefined) }, 0);
    const judged = applyEvent(snapshot, { kind: "verdict", taskId: "t-e05150fe", verdict: verdict() }, 1);
    expect(judged.task?.verdict?.fusion).toEqual(verdict().fusion);
    expect(assistsOf(judged.task!)).toEqual(["ponder"]);
  });
});

describe("fusion in the git graph", () => {
  it("F6 fusionOf places the round at the judge time, and the graph shows it only once t reaches it", () => {
    const fusion = fusionOf(task(verdict()));
    expect(fusion).toMatchObject({ at: Date.parse(JUDGED), winner: "testy", commit: "660ef87" });
    expect(fusion?.tries.map((t) => [t.agent, t.added])).toEqual([["ponder", true], ["zippy", false]]);
    const start = Date.parse("2026-10-06T05:30:00.000Z");
    const base = { agents: ["ponder", "zippy", "testy"], start, ends: {}, dots: [], domainEnd: Date.parse(JUDGED), ...(fusion ? { fusion } : {}) };
    expect(gitGraph({ ...base, t: Date.parse(JUDGED) - 1 }).fusion).toBeUndefined();
    const graph = gitGraph({ ...base, t: Date.parse(JUDGED) });
    expect(graph.fusion?.x).toBe(1);
    expect(graph.fusion?.tries[0]?.label).toBe("Ponder's test/ponder.test.ts: fused into Testy's fork");
    expect(graph.fusion?.tries[1]?.label).toBe("Zippy's test/zippy.test.ts: left out (the judge found nothing new)");
    expect(fusionOf(task(undefined))).toBeUndefined();
  });
});

describe("fusion in the pipeline", () => {
  it("F7 the fusion stage sits between Clef and the merge, and the verdict lights it", () => {
    expect(STAGES.indexOf("fusion")).toBe(STAGES.indexOf("ai") + 1);
    expect(STAGES.indexOf("merge")).toBe(STAGES.indexOf("fusion") + 1);
    const { hits, state } = applyPlatform(emptyPlatform(), { kind: "verdict", taskId: "t-e05150fe", verdict: verdict() }, 0);
    expect(hits.find((h) => h.stage === "fusion")?.text).toBe("fused Ponder's tests into Testy's fix (660ef87)");
    expect(state.counts.fusion).toBe(1);
    const none = applyPlatform(emptyPlatform(), { kind: "verdict", taskId: "t", verdict: { ...verdict(), fusion: { tried: [verdict().fusion!.tried[1]!] } } }, 0);
    expect(none.hits.find((h) => h.stage === "fusion")?.text).toBe("tried 1 loser's tests, kept none");
    const without = applyPlatform(emptyPlatform(), { kind: "verdict", taskId: "t", verdict: { winner: "testy", why: "" } }, 0);
    expect(without.hits.some((h) => h.stage === "fusion")).toBe(false);
  });
});

describe("assists", () => {
  it("F8 summaryOf records the fused agents only when the winner merged", () => {
    const base: Task = {
      id: "t-0123abcd",
      repo: "demo",
      prompt: "p",
      status: "finished",
      createdAt: "2026-10-06T05:00:00.000Z",
      agents: [],
    };
    const v = verdict() as unknown as Verdict;
    expect(summaryOf({ ...base, verdict: { ...v, ship: { status: "merged", winner: "testy", locks: [] } } }, []).fused).toEqual(["ponder"]);
    expect(Object.hasOwn(summaryOf({ ...base, verdict: { ...v, ship: { status: "conflict", winner: "testy", locks: [] } } }, []), "fused")).toBe(false);
    expect(Object.hasOwn(summaryOf({ ...base, verdict: { ...v, fusion: { tried: [] }, ship: { status: "merged", winner: "testy", locks: [] } } }, []), "fused")).toBe(false);
  });

  it("F9 the leaderboard counts assists and the share of races that shipped a fusion", () => {
    const races: RaceRow[] = [
      { id: "a", agents: ["ponder", "zippy", "testy"], winner: "testy", fused: ["ponder"] },
      { id: "b", agents: ["ponder", "zippy", "testy"], winner: "ponder" },
      { id: "c", agents: ["ponder", "zippy", "testy"], winner: "zippy", fused: ["ponder", "testy"] },
      { id: "d", agents: ["ponder", "zippy", "testy"], fused: ["zippy"] }, // not judged: ignored
    ];
    const byAgent = Object.fromEntries(standings(races).map((s) => [s.agent, s.assists]));
    expect(byAgent).toEqual({ ponder: 2, zippy: 0, testy: 1 });
    expect(raceStats(races).fusedRate).toBeCloseTo(2 / 3);
  });
});
