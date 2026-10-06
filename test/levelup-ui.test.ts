import { describe, expect, it } from "vitest";

import type { WireTask } from "../src/ui/board";
import { DIFF_CELLS_MAX, DIFF_CONTEXT, fileDiff, parseDiff } from "../src/ui/diffview";
import { gitGraph, mergeOf, pushDots } from "../src/ui/gitgraph";
import { raceStats, standings, type RaceRow } from "../src/ui/leaderboard";

const T0 = Date.parse("2026-10-05T05:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function task(): WireTask {
  return {
    id: "t-0123abcd",
    prompt: "Fix it",
    status: "finished",
    createdAt: iso(0),
    startedAt: iso(0),
    agents: [
      {
        name: "ponder",
        status: "done",
        startedAt: iso(0),
        endedAt: iso(80),
        push: {
          commits: 3,
          pushes: 2,
          lastPushAt: iso(60),
          head: "c2",
          log: [
            { at: iso(20), commit: "c1aaaaaaaa", commits: 1, message: "first" },
            { at: iso(60), commit: "c2bbbbbbbb", commits: 2 },
          ],
        },
      },
      { name: "zippy", status: "done", startedAt: iso(0), endedAt: iso(50), push: { commits: 4, pushes: 2, lastPushAt: iso(40), head: "f2" } },
    ],
    verdict: { winner: "ponder", why: "", judgedAt: iso(100), ship: { status: "merged", commit: "abcdef1234567" } },
  };
}

describe("git graph", () => {
  it("U15 pushDots uses the push log, and estimates older tasks from the count", () => {
    const dots = pushDots(task());
    expect(dots.filter((d) => d.agent === "ponder")).toEqual([
      { agent: "ponder", at: T0 + 20_000, commits: 1, commit: "c1aaaaaaaa", message: "first" },
      { agent: "ponder", at: T0 + 60_000, commits: 2, commit: "c2bbbbbbbb" },
    ]);
    const zippy = dots.filter((d) => d.agent === "zippy");
    expect(zippy.map((d) => d.at)).toEqual([T0 + 20_000, T0 + 40_000]);
    expect(zippy.map((d) => d.commits)).toEqual([2, 2]);
    expect(zippy.map((d) => d.approx)).toEqual([true, undefined]);
    expect(zippy[1]?.commit).toBe("f2");
  });

  it("U16 gitGraph places dots and lanes by time and merges the winner only once judged", () => {
    const t = task();
    const input = { agents: ["ponder", "zippy"], start: T0, ends: { ponder: T0 + 80_000, zippy: T0 + 50_000 }, dots: pushDots(t), merge: mergeOf(t), domainEnd: T0 + 100_000 };
    const mid = gitGraph({ ...input, t: T0 + 45_000 });
    expect(mid.merge).toBeUndefined();
    expect(mid.nowX).toBeCloseTo(0.45);
    expect(mid.lanes[0]?.dots.map((d) => d.x)).toEqual([0.2]);
    expect(mid.lanes[0]?.dots[0]?.label).toBe("c1aaaaa · first · 1 commit");
    expect(mid.lanes[0]?.ended).toBe(false);
    expect(mid.lanes[0]?.endX).toBeCloseTo(0.45);
    expect(mid.lanes[1]?.dots).toHaveLength(2);
    const done = gitGraph({ ...input, t: T0 + 100_000 });
    expect(done.merge).toEqual({ agent: "ponder", x: 1, commit: "abcdef1" });
    expect(done.lanes.map((l) => [l.ended, l.won, l.endX])).toEqual([
      [true, true, 0.8],
      [true, false, 0.5],
    ]);
    expect(mergeOf({ ...t, verdict: { winner: null, why: "" } })).toBeUndefined();
  });
});

describe("leaderboard", () => {
  const races: RaceRow[] = [
    { id: "t-00000001", agents: ["ponder", "zippy", "testy"], winner: "zippy", clash: true, decidedBy: "claims", scores: [{ agent: "zippy", total: 90 }, { agent: "ponder", total: 91 }, { agent: "testy", total: 70 }], startedAt: iso(0), finishedAt: iso(100) },
    { id: "t-00000002", agents: ["ponder", "zippy", "testy"], winner: "ponder", decidedBy: "code", scores: [{ agent: "ponder", total: 95 }, { agent: "zippy", total: 80 }, { agent: "testy", total: 60 }], startedAt: iso(0), finishedAt: iso(200) },
    { id: "t-00000003", agents: ["ponder", "zippy", "testy"], winner: "zippy", clash: true },
    { id: "t-00000004", agents: ["ponder", "zippy", "testy"] }, // still running
  ];

  it("U17 standings rank by wins and average only the races with scores", () => {
    const rows = standings(races);
    expect(rows.map((r) => [r.agent, r.name, r.races, r.wins])).toEqual([
      ["zippy", "Zippy", 3, 2],
      ["ponder", "Ponder", 3, 1],
      ["testy", "Testy", 3, 0],
    ]);
    expect(rows[0]?.avgScore).toBe(85);
    expect(rows[1]?.avgScore).toBe(93);
    expect(rows[0]?.winRate).toBeCloseTo(2 / 3);
    expect(standings([])).toEqual([]);
  });

  it("U18 raceStats counts judged races, clashes, what decided them and the average time", () => {
    expect(raceStats(races)).toEqual({ judged: 3, clashRate: 2 / 3, decided: { code: 1, claims: 1, close: 0, same: 0 }, fusedRate: 0, avgSeconds: 150 });
    expect(raceStats([])).toEqual({ judged: 0, clashRate: 0, decided: { code: 0, claims: 0, close: 0, same: 0 }, fusedRate: 0 });
  });
});

describe("diff view", () => {
  it("U19 parseDiff splits files and types each line", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/b.md b/b.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["src/a.ts", 1, 1],
      ["b.md", 1, 0],
    ]);
    expect(files[0]?.lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "meta"]);
    expect(files[1]?.lines[0]).toEqual({ kind: "meta", text: "new file" });
    expect(parseDiff("")).toEqual([]);
  });
});

describe("fileDiff", () => {
  it("a new file is all added, a deleted one all removed", () => {
    expect(fileDiff("a", undefined, "x\ny\n")).toEqual({ path: "a", added: 2, removed: 0, lines: [{ kind: "add", text: "x" }, { kind: "add", text: "y" }] });
    expect(fileDiff("a", "x\n", undefined)).toEqual({ path: "a", added: 0, removed: 1, lines: [{ kind: "del", text: "x" }] });
  });

  it("an edit is a line diff with DIFF_CONTEXT lines around it, and long unchanged runs fold", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i === 10 ? "changed" : l));
    after.splice(15, 0, "inserted");
    const diff = fileDiff("a", `${before.join("\n")}\n`, `${after.join("\n")}\n`);
    expect([diff.added, diff.removed]).toEqual([2, 1]);
    expect(diff.lines[0]).toEqual({ kind: "hunk", text: `⋯ ${10 - DIFF_CONTEXT} unchanged lines` });
    expect(diff.lines.filter((l) => l.kind !== "ctx" && l.kind !== "hunk")).toEqual([
      { kind: "del", text: "line 10" },
      { kind: "add", text: "changed" },
      { kind: "add", text: "inserted" },
    ]);
    expect(diff.lines.at(-1)).toEqual({ kind: "hunk", text: `⋯ ${5 - DIFF_CONTEXT} unchanged lines` });
  });

  it("past DIFF_CELLS_MAX the old lines are all removed and the new all added", () => {
    const n = Math.ceil(Math.sqrt(DIFF_CELLS_MAX)) + 2;
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join("\n");
    const diff = fileDiff("a", a, b);
    expect([diff.added, diff.removed]).toEqual([n, n]);
  });
});
