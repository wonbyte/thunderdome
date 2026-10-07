import { describe, expect, it } from "vitest";

import { FUSE_THRESHOLD, hunkLabel } from "../src/judge/fusion";
import { summaryOf } from "../src/room/races";
import type { Task, Verdict } from "../src/room/task";
import { applyEvent, emptyBoard, type WireTask, type WireVerdict } from "../src/ui/board";
import { assistsOf, FUSE_BAR, fusionView, hunkWhat, scoreBars } from "../src/ui/fusion";
import { fusionOf, gitGraph } from "../src/ui/gitgraph";
import { gitLog, LOG_PUSHES_MAX, subjectOf } from "../src/ui/gitlog";
import { raceStats, standings, teamPill, type RaceRow } from "../src/ui/leaderboard";
import { blameView, wholePercents } from "../src/ui/blame";
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
      hash: "660ef87bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      author: "ponder",
      shipped: true,
      rows: [
        { agent: "ponder", files: ["test/ponder.test.ts"], kind: "file", what: "test/ponder.test.ts", outcome: "added", tests: "20/20", green: true, clef: 0.6098, asked: "tests something new the task asks?" },
        { agent: "zippy", files: ["test/zippy.test.ts"], kind: "file", what: "test/zippy.test.ts", outcome: "rejected", tests: "22/22", green: true, clef: 0.1753, asked: "tests something new the task asks?", note: "the judge found nothing new" },
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

describe("the fused score and hunks", () => {
  const scored = (after: number, commit = true): WireVerdict => {
    const v = verdict();
    const fusion = { ...v.fusion!, score: { before: { total: 91.92, tests: { passed: 20, total: 20 } }, after: { total: after, tests: { passed: 26, total: 26 } } } };
    if (!commit) delete fusion.commit;
    return { ...v, fusion };
  };

  it("F11 a kept fusion shows the winner alone vs fused, with both bars and an aria-label", () => {
    const view = fusionView(scored(94.63))!;
    expect(view.score).toEqual({ before: 91.9, after: 94.6, delta: 2.7, testsBefore: "20/20", testsAfter: "26/26", kept: true, headline: "Testy alone 91.9 → fused 94.6 · tests 20 → 26" });
    const bars = scoreBars(view)!;
    expect(bars.bars.map((b) => [b.name, b.width, b.tests])).toEqual([["Testy alone", 91.9, "20/20"], ["Fused", 94.6, "26/26"]]);
    expect(bars.label).toBe("Testy alone scored 91.9 with tests 20/20; fused scored 94.6 with tests 26/26 (+2.7)");
  });

  it("F12 a fusion dropped for scoring lower says so; a pushed-out fusion or no score shows none", () => {
    const low = fusionView(scored(90.1, false))!;
    expect(low.score).toMatchObject({ kept: false, delta: -1.8, headline: "Fused 90.1 < Testy alone 91.9: the fusion was dropped" });
    expect(scoreBars(low)?.label).toContain("(-1.8)");
    expect(fusionView(scored(95, false))?.score).toBeUndefined();
    // A tests-only fusion that scored lower was still pushed: kept, and the headline says why.
    expect(fusionView(scored(90.1))?.score).toMatchObject({ kept: true, delta: -1.8, headline: "Testy alone 91.9 → fused 90.1 · tests 20 → 26 · tests only, kept" });
    expect(fusionView(verdict())?.score).toBeUndefined();
    expect(scoreBars(fusionView(verdict())!)).toBeUndefined();
    expect(fusionView({ ...verdict(), fusion: { ...verdict().fusion!, scoreNote: "Clef is down" } })?.scoreNote).toBe("Clef is down");
  });

  it("F13 a hunk try is labelled by its name and file in the panel, the graph, the log and the pipeline", () => {
    const hunk = { agent: "ponder", files: ["src/cart.ts"], kind: "hunk", hunk: { file: "src/cart.ts", header: "@@ -9,3 +9,6 @@", name: "cartMessage" }, status: "added", tests: { passed: 21, total: 21 }, better: 0.8, question: "better" };
    const v: WireVerdict = { ...verdict(), fusion: { ...verdict().fusion!, tried: [hunk] } };
    expect(fusionView(v)?.rows[0]).toMatchObject({ kind: "hunk", what: "cartMessage in src/cart.ts" });
    const graph = gitGraph({ agents: ["ponder", "zippy", "testy"], start: 0, ends: {}, dots: [], domainEnd: Date.parse(JUDGED), t: Date.parse(JUDGED), fusion: fusionOf(task(v))! });
    expect(graph.fusion?.tries[0]?.label).toBe("Ponder's cartMessage in src/cart.ts: fused into Testy's fork");
    const t = { ...task(v), baseCommit: "f".repeat(40) };
    expect(gitLog(t)?.find((l) => l.sha === "660ef87")?.message).toBe("fusion: add Ponder's cartMessage in src/cart.ts");
    const { hits } = applyPlatform(emptyPlatform(), { kind: "verdict", taskId: "t", verdict: v }, 0);
    expect(hits.find((h) => h.stage === "fusion")?.text).toBe("fused Ponder's work into Testy's fix (660ef87)");
  });

  it("F14 the page's hunk label is the judge's", () => {
    for (const h of [{ file: "a.ts", header: "@@ -1 +12,7 @@" }, { file: "a.ts", header: "@@ -1,2 +3 @@", name: "x" }, { file: "b.ts", header: "@@ -4,0 +5 @@" }]) expect(hunkWhat(h)).toBe(hunkLabel(h));
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
    expect(fusion).toMatchObject({ at: Date.parse(JUDGED), winner: "testy", commit: "660ef87", hash: "660ef87bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", author: "ponder" });
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

describe("git log --graph", () => {
  const pushed = (n: number): WireTask => {
    const t = task(verdict());
    const log = Array.from({ length: n }, (_, i) => ({ at: `2026-10-06T05:3${i}:00.000Z`, commit: `${i}`.repeat(40), commits: i === 0 ? 2 : 1, message: `fix ${i}` }));
    return { ...t, baseCommit: "fd8e0e1cccccccccccccccccccccccccccccccc", agents: t.agents.map((a) => (a.name === "testy" ? { ...a, push: { commits: n + 1, log } } : a)) };
  };

  it("G1 the merge on top, the fusion head on the winner's side, its pushes newest first, then the base", () => {
    const lines = gitLog(pushed(2));
    expect(lines?.map((l) => [l.graph, l.sha ?? "", l.message ?? "", l.who ?? ""])).toEqual([
      ["*   ", "33d07d7", "Thunderdome: ship Testy's fork", "Thunderdome"],
      ["|\\  ", "", "", ""],
      ["| * ", "660ef87", "fusion: add Ponder's test/ponder.test.ts", "Ponder"],
      ["| * ", "1111111", "fix 1", "Testy"],
      ["| * ", "0000000", "fix 0 (+1 more)", "Testy"],
      ["|/  ", "", "", ""],
      ["* ", "fd8e0e1", "base: where every fork started", ""],
    ]);
    // The merge and the fusion head open as commits; the author column is in the robot's color.
    expect(lines?.[0]?.hash).toBe("33d07d7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(lines?.[2]).toMatchObject({ hash: "660ef87bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", color: "#d97757" });
    expect(lines?.[3]?.hash).toBeUndefined();
  });

  it("G3 the fusion push in the winner's push log is not shown twice", () => {
    const t = pushed(1);
    const testy = t.agents.find((a) => a.name === "testy")!;
    const fusionPush = { at: "2026-10-06T05:39:00.000Z", commit: verdict().fusion!.commit!, commits: 1, message: "Thunderdome fusion: add ponder's test/ponder.test.ts" };
    const withFusion = { ...t, agents: t.agents.map((a) => (a === testy ? { ...a, push: { commits: 2, log: [...(testy.push?.log ?? []), fusionPush] } } : a)) };
    expect(gitLog(withFusion)?.filter((l) => l.sha === "660ef87")).toHaveLength(1);
  });

  it("G4 a push recorded with its whole message on one line shows its subject, without the flattened trailer", () => {
    expect(subjectOf("Sale badge, sort, and price rounding Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")).toBe("Sale badge, sort, and price rounding");
    expect(subjectOf("fix the parser")).toBe("fix the parser");
    const t = pushed(1);
    const flat = { ...t, agents: t.agents.map((a) => (a.name === "testy" ? { ...a, push: { commits: 1, log: [{ ...a.push!.log![0]!, message: " Co-Authored-By: Claude" }] } } : a)) };
    expect(gitLog(flat)?.find((l) => l.sha === "0000000")?.message).toBe("push (+1 more)");
  });

  it("G2 no fusion line when nothing was added, no log until the winner merged, and long push logs fold", () => {
    const none = { ...pushed(1), verdict: { ...verdict(), fusion: { tried: [verdict().fusion!.tried[1]!] } } };
    expect(gitLog(none)?.some((l) => l.message?.startsWith("fusion") === true)).toBe(false);
    expect(gitLog({ ...pushed(1), verdict: verdict("conflict") })).toBeUndefined();
    expect(gitLog(task(undefined))).toBeUndefined();
    const long = gitLog(pushed(LOG_PUSHES_MAX + 2)) ?? [];
    expect(long.filter((l) => l.who === "Testy")).toHaveLength(LOG_PUSHES_MAX);
    expect(long.find((l) => l.graph === "| ⋮ ")?.message).toBe("2 earlier pushes");
  });
});

describe("Clef while the judge runs", () => {
  it("P1 the Clef unit works from the last robot's end until the verdict, live and in a replay", () => {
    let p = applyPlatform(emptyPlatform(), { kind: "snapshot", taskId: "t", task: task(undefined) }, 0).state;
    expect(p.working.ai).toBeUndefined();
    p = applyPlatform(p, { kind: "agent-end", taskId: "t", agent: "ponder", outcome: { end: "done" }, status: "running" }, 1).state;
    expect(p.working.ai).toBeUndefined();
    p = applyPlatform(p, { kind: "agent-end", taskId: "t", agent: "testy", outcome: { end: "done" }, status: "finished" }, 2).state;
    expect(p.working).toEqual({ ai: "scoring 3 diffs…" });
    const judged = applyPlatform(p, { kind: "verdict", taskId: "t", verdict: verdict() }, 3);
    expect(judged.state.working).toEqual({});
    expect(judged.hits.some((h) => h.stage === "ai")).toBe(true);
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

describe("who wrote main", () => {
  const blamed = (blame: Record<string, number> | undefined, status = "merged"): WireVerdict => ({ ...verdict(), ship: { status, commit: "33d07d7", ...(blame === undefined ? {} : { blame }) } });

  it("B1 the winner comes first, then robots by lines, then Thunderdome; whole percents add to 100", () => {
    const view = blameView(blamed({ thunderdome: 2, ponder: 30, testy: 120, zippy: 0, snip: 31 }))!;
    expect(view.shares.map((s) => [s.key, s.name, s.lines, s.pct, s.winner])).toEqual([
      ["testy", "Testy", 120, 66, true],
      ["snip", "Snip", 31, 17, false],
      ["ponder", "Ponder", 30, 16, false],
      ["thunderdome", "Thunderdome", 2, 1, false],
    ]);
    expect(view.total).toBe(183);
    expect(view.losers).toBe(61);
    expect(view.shares[0]?.color).toBe("#3e8ed0");
    expect(view.label).toBe("Who wrote main: Testy 66% (120 lines), Snip 17% (31 lines), Ponder 16% (30 lines), Thunderdome 1% (2 lines)");
  });

  it("B2 no bar for older races, unmerged races or an empty blame", () => {
    expect(blameView(blamed(undefined))).toBeUndefined();
    expect(blameView(blamed({ testy: 3 }, "conflict"))).toBeUndefined();
    expect(blameView(blamed({ testy: 0 }))).toBeUndefined();
    expect(blameView(undefined)).toBeUndefined();
  });

  it("B3 wholePercents gives the leftover points to the largest remainders", () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
    expect(wholePercents([5])).toEqual([100]);
  });
});

describe("fusion in the gallery and leaderboard", () => {
  const base: Task = { id: "t-0123abcd", repo: "demo", prompt: "p", status: "finished", createdAt: "2026-10-06T05:00:00.000Z", agents: [] };
  const slots = ["ponder", "zippy", "testy"].map((name) => ({ name, status: "done" })) as unknown as Task["agents"];
  const scored = (): Verdict => {
    const v = verdict() as unknown as Verdict;
    return {
      ...v,
      ship: { status: "merged", winner: "testy", commit: "c", locks: [], blame: { testy: 90, ponder: 12, thunderdome: 1, other: 4 } },
      fusion: { ...v.fusion!, score: { before: { total: 91.92, tests: { passed: 20, total: 20 } }, after: { total: 94.63, tests: { passed: 26, total: 26 } } } },
    };
  };

  it("F15 summaryOf records the losers' shipped lines and the team's lead over the winner", () => {
    const summary = summaryOf({ ...base, agents: slots, verdict: scored() }, []);
    expect(summary.losing).toEqual({ ponder: 12 });
    expect(summary.team).toBe(2.7);
    const old = summaryOf({ ...base, agents: slots, verdict: verdict() as unknown as Verdict }, []);
    expect(Object.hasOwn(old, "losing") || Object.hasOwn(old, "team")).toBe(false);
    const { commit: _c, ...unpushed } = scored().fusion!;
    expect(Object.hasOwn(summaryOf({ ...base, agents: slots, verdict: { ...scored(), fusion: unpushed } }, []), "team")).toBe(false);
  });

  it("F16 the leaderboard adds up lines shipped while losing and the races the team beat the winner", () => {
    const races: RaceRow[] = [
      { id: "a", agents: ["ponder", "zippy", "testy"], winner: "testy", fused: ["ponder"], losing: { ponder: 12 }, team: 2.7 },
      { id: "b", agents: ["ponder", "zippy", "testy"], winner: "ponder", losing: { zippy: 5, ponder: 99 }, team: 0 },
      { id: "c", agents: ["ponder", "zippy", "testy"], winner: "zippy" },
      { id: "d", agents: ["ponder", "zippy", "testy"], losing: { zippy: 50 }, team: 9 }, // not judged: ignored
    ];
    expect(Object.fromEntries(standings(races).map((s) => [s.agent, s.losingLines]))).toEqual({ ponder: 12, zippy: 5, testy: 0 });
    expect(raceStats(races)).toMatchObject({ losingLines: 17, teamBeat: 1, scoredFusions: 2 });
    expect([teamPill(2.7), teamPill(0), teamPill(-1.25), teamPill(undefined), teamPill(Number.NaN)]).toEqual(["team +2.7", "team ±0.0", "team −1.3", undefined, undefined]);
  });
});
