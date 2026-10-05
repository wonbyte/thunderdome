import { describe, expect, it } from "vitest";

import { claimKept, fixFingerprint, type ForkInput, neededFiles, rankForks, scoreFork, scoreForks, SHARED_COST, WEIGHTS } from "../src/judge/score";

function fork(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    agent: "a",
    testsPassed: 10,
    testsTotal: 10,
    taskFit: 1,
    clarity: 1,
    linesChanged: 10,
    filesChanged: ["src/a.ts"],
    filesClaimed: ["src/a.ts"],
    ...overrides,
  };
}

describe("scoreForks", () => {
  it("R1: a fork with 0 passing tests cannot win, even with the highest total", () => {
    const result = scoreForks([
      // 0 tests but full fit, clarity and claim: total 50.
      fork({ agent: "zero", testsPassed: 0 }),
      // 1/10 tests and nothing else: total 5 + 10 claim = 15.
      fork({ agent: "low", testsPassed: 1, taskFit: 0, clarity: 0 }),
    ]);
    const zero = result.ranked.find((s) => s.agent === "zero");
    const low = result.ranked.find((s) => s.agent === "low");
    expect(zero!.total).toBeGreaterThan(low!.total);
    expect(zero!.eligible).toBe(false);
    expect(result.winner).toBe("low");
    expect(result.ranked.map((s) => s.agent)).toEqual(["low", "zero"]);
  });

  it("R1: no eligible fork means winner is null", () => {
    const result = scoreForks([fork({ agent: "a", testsPassed: 0 }), fork({ agent: "b", testsPassed: 0 })]);
    expect(result.winner).toBeNull();
    expect(result.ranked).toHaveLength(2);
    expect(scoreForks([]).winner).toBeNull();
  });

  it("R2: a tie on total goes to the fork with fewer linesChanged", () => {
    const result = scoreForks([
      fork({ agent: "big", linesChanged: 200 }),
      fork({ agent: "small", linesChanged: 20 }),
      fork({ agent: "small2", linesChanged: 20 }),
    ]);
    expect(result.ranked.map((s) => s.total)).toEqual([100, 100, 100]);
    expect(result.winner).toBe("small");
    // Equal lines keep input order.
    expect(result.ranked.map((s) => s.agent)).toEqual(["small", "small2", "big"]);
  });

  it("R3: weights are 50/25/15/10 and the total is 0–100 (perfect fork = 100, empty fork = 0, partial = expected sum)", () => {
    expect(WEIGHTS).toEqual({ tests: 50, taskFit: 25, clarity: 15, claim: 10 });

    const perfect = scoreFork(fork());
    expect(perfect.parts).toEqual({ tests: 50, taskFit: 25, clarity: 15, claim: 10 });
    expect(perfect.total).toBe(100);

    const empty = scoreFork(
      fork({ testsPassed: 0, testsTotal: 10, taskFit: 0, clarity: 0, filesChanged: ["x.ts"], filesClaimed: [] }),
    );
    expect(empty.parts).toEqual({ tests: 0, taskFit: 0, clarity: 0, claim: 0 });
    expect(empty.total).toBe(0);

    const partial = scoreFork(fork({ testsPassed: 1, testsTotal: 3, taskFit: 0.5, clarity: 0.2 }));
    expect(partial.parts).toEqual({ tests: 16.67, taskFit: 12.5, clarity: 3, claim: 10 });
    expect(partial.total).toBe(42.17);
  });

  it("R3: out-of-range taskFit/clarity are clamped and testsTotal 0 gives 0 test points", () => {
    const high = scoreFork(fork({ taskFit: 3, clarity: 1.5 }));
    expect(high.parts.taskFit).toBe(25);
    expect(high.parts.clarity).toBe(15);

    const low = scoreFork(fork({ taskFit: -1, clarity: Number.NaN }));
    expect(low.parts.taskFit).toBe(0);
    expect(low.parts.clarity).toBe(0);

    const noTests = scoreFork(fork({ testsPassed: 4, testsTotal: 0 }));
    expect(noTests.parts.tests).toBe(0);

    const over = scoreFork(fork({ testsPassed: 12, testsTotal: 10 }));
    expect(over.parts.tests).toBe(50);
    expect(over.total).toBeLessThanOrEqual(100);
  });

  it("R4: claim kept means changed files ⊆ claimed files (10 points), any unclaimed file gives 0 and is listed", () => {
    expect(claimKept(["a.ts"], ["a.ts", "b.ts"])).toBe(true);
    expect(claimKept([], [])).toBe(true);
    expect(claimKept(["a.ts", "c.ts"], ["a.ts"])).toBe(false);

    const kept = scoreFork(fork({ filesChanged: ["a.ts"], filesClaimed: ["a.ts", "b.ts"] }));
    expect(kept.claimKept).toBe(true);
    expect(kept.parts.claim).toBe(10);
    expect(kept.unclaimed).toEqual([]);

    const broken = scoreFork(fork({ filesChanged: ["a.ts", "c.ts", "d.ts"], filesClaimed: ["a.ts"] }));
    expect(broken.claimKept).toBe(false);
    expect(broken.parts.claim).toBe(0);
    expect(broken.unclaimed).toEqual(["c.ts", "d.ts"]);
    expect(broken.total).toBe(90);
  });

  it("R4: changing a file held only as shared costs SHARED_COST (2) claim points and is listed", () => {
    const shared = scoreFork(fork({ filesChanged: ["src/a.ts", "src/b.ts"], filesClaimed: ["src/a.ts", "src/b.ts"], filesShared: ["src/b.ts", "src/c.ts"] }));
    expect(SHARED_COST).toBe(2);
    expect(shared.parts.claim).toBe(WEIGHTS.claim - SHARED_COST);
    expect(shared.shared).toEqual(["src/b.ts"]);
    expect(shared.claimKept).toBe(true);
    // A shared claim on a file it did not change costs nothing; an unclaimed file still gives 0.
    expect(scoreFork(fork({ filesShared: ["src/z.ts"] })).parts.claim).toBe(WEIGHTS.claim);
    expect(scoreFork(fork({ filesChanged: ["src/a.ts", "src/x.ts"], filesShared: ["src/a.ts"] })).parts.claim).toBe(0);
  });

  it("a clash costs nothing when every other eligible fork changed that file too", () => {
    // Every fork had to change src/a.ts; who claimed it first must not decide the race.
    const result = scoreForks([
      fork({ agent: "first", taskFit: 0.96 }),
      fork({ agent: "second", filesShared: ["src/a.ts"] }),
      fork({ agent: "third", filesShared: ["src/a.ts"], filesChanged: ["src/a.ts", "src/b.ts"], filesClaimed: ["src/a.ts", "src/b.ts"] }),
    ]);
    const second = result.ranked.find((s) => s.agent === "second")!;
    expect(second.parts.claim).toBe(WEIGHTS.claim);
    expect(second.shared).toEqual([]);
    expect(second.unavoidable).toEqual(["src/a.ts"]);
    // The better code wins now: second's fix scored 1 point more than first's.
    expect(result.winner).toBe("second");
  });

  it("a clash costs SHARED_COST when another eligible fork did the task without that file", () => {
    const result = scoreForks([
      fork({ agent: "around", filesChanged: ["src/b.ts"], filesClaimed: ["src/b.ts"] }),
      fork({ agent: "clash", filesShared: ["src/a.ts"] }),
    ]);
    const clash = result.ranked.find((s) => s.agent === "clash")!;
    expect(clash.parts.claim).toBe(WEIGHTS.claim - SHARED_COST);
    expect(clash.shared).toEqual(["src/a.ts"]);
    expect(clash.unavoidable).toEqual([]);
    expect(result.winner).toBe("around");
  });

  it("an ineligible fork shows no way around a file", () => {
    const clash = fork({ agent: "clash", filesShared: ["src/a.ts"] });
    // "broken" avoided src/a.ts but passed no tests, so it does not count.
    const broken = fork({ agent: "broken", testsPassed: 0, filesChanged: ["src/b.ts"], filesClaimed: ["src/b.ts"] });
    expect([...neededFiles(clash, [clash, broken])]).toEqual(["src/a.ts"]);
    expect(scoreForks([clash, broken]).ranked[0]?.parts.claim).toBe(WEIGHTS.claim);
    // A file only some of the others changed was avoidable.
    const other = fork({ agent: "other", filesChanged: ["src/a.ts", "src/c.ts"], filesClaimed: ["src/a.ts", "src/c.ts"] });
    const around = fork({ agent: "around", filesChanged: ["src/c.ts"], filesClaimed: ["src/c.ts"] });
    expect([...neededFiles(other, [other, around, clash])]).toEqual([]);
  });

  it("R2: a tie on total and linesChanged goes to the fork that ended first; a missing end sorts last", () => {
    const result = scoreForks([
      fork({ agent: "late", endedAt: "2026-10-04T13:49:30.000Z" }),
      fork({ agent: "none" }),
      fork({ agent: "early", endedAt: "2026-10-04T13:48:10.000Z" }),
    ]);
    expect(result.ranked.map((s) => s.agent)).toEqual(["early", "late", "none"]);
    expect(result.winner).toBe("early");
    // Both ends missing (or unparsable) keeps input order.
    expect(scoreForks([fork({ agent: "x", endedAt: "bad" }), fork({ agent: "y" })]).winner).toBe("x");
  });

  it("rankForks does not mutate its input", () => {
    const scores = [fork({ agent: "a", testsPassed: 0 }), fork({ agent: "b" })].map((f) => scoreFork(f));
    const ranked = rankForks(scores);
    expect(ranked.map((s) => s.agent)).toEqual(["b", "a"]);
    expect(scores.map((s) => s.agent)).toEqual(["a", "b"]);
  });

  it("a fork that changed no files cannot win, even with passing tests and the smallest diff", () => {
    // Review finding: an agent that pushed nothing ran the base suite, kept its (empty) claim, and won ties.
    const result = scoreForks([
      fork({ agent: "idle", testsPassed: 10, filesChanged: [], linesChanged: 0 }),
      fork({ agent: "worker", testsPassed: 8, linesChanged: 40 }),
    ]);
    expect(result.winner).toBe("worker");
    expect(result.ranked.find((s) => s.agent === "idle")!.eligible).toBe(false);
    expect(scoreForks([fork({ agent: "idle", filesChanged: [], linesChanged: 0 })]).winner).toBeNull();
  });
});


describe("fixFingerprint", () => {
  const diff = (body: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n${body}`;

  it("is equal for the same changed lines, whatever the whitespace, line order or context", () => {
    const a = fixFingerprint(diff("-const x = 1;\n+const x = 2;\n+const y = 3;\n context\n"));
    expect(fixFingerprint(diff("+const y=3;\n-const  x = 1;\n other context\n+const x = 2;\n"))).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{14}$/);
  });

  it("ignores blank lines, reads \"---\" and \"+++\" inside a hunk as code, and keeps each line's file", () => {
    const a = fixFingerprint(diff("-const x = 1;\n+const x = 2;\n"));
    expect(fixFingerprint(diff("-const x = 1;\n+\n+const x = 2;\n+   \n"))).toBe(a);
    // A removed SQL comment "-- note" shows as "--- note" in the hunk.
    expect(fixFingerprint(diff("-const x = 1;\n+const x = 2;\n--- note\n"))).not.toBe(a);
    const other = `diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n`;
    expect(fixFingerprint(other)).not.toBe(a);
  });

  it("differs when any changed line differs", () => {
    const a = fixFingerprint(diff("-const x = 1;\n+const x = 2;\n"));
    expect(fixFingerprint(diff("-const x = 1;\n+const x = 3;\n"))).not.toBe(a);
    // A removed line is not the same change as an added one.
    expect(fixFingerprint(diff("+const x = 1;\n-const x = 2;\n"))).not.toBe(a);
  });
});
