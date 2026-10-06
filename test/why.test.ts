import { describe, expect, it } from "vitest";

import { type ForkInput, scoreFork, scoreForks } from "../src/judge/score";
import { buildWhy, CODE_TIE, decidedBy, duration, headline, lesson, loserLine, REASON_COUNT, scoresTable, winnerReasons } from "../src/judge/why";

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

// A winner that did the task without src/a.ts, so a clash on src/a.ts was avoidable.
function avoids(overrides: Partial<ForkInput> = {}): ForkInput {
  return fork({ agent: "w", filesChanged: ["src/b.ts"], filesClaimed: ["src/b.ts"], ...overrides });
}

// Lines under a heading, up to the next blank line.
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.indexOf("");
  return end < 0 ? rest : rest.slice(0, end);
}

describe("buildWhy", () => {
  it("R5: names the winner on the first line, has a scores table, 3 reasons, and 1 line per loser", () => {
    const result = scoreForks([
      fork({ agent: "claude", testsPassed: 9, taskFit: 0.8, clarity: 0.6 }),
      fork({ agent: "codex", testsPassed: 6, taskFit: 0.9, clarity: 0.4, filesChanged: ["src/a.ts", "x.ts"] }),
      fork({ agent: "gemini", testsPassed: 0 }),
    ]);
    expect(result.winner).toBe("claude");
    const why = buildWhy(result);
    const lines = why.split("\n");

    expect(lines[0]).toBe("Winner: claude (84/100)");
    expect(lines[1]).toBe("");

    const header = lines[2]!;
    for (const col of ["agent", "tests", "task fit", "clarity", "claim", "total"]) expect(header).toContain(col);
    expect(lines[3]).toMatch(/^claude\s+9\/10 \(45\)/);
    expect(lines[4]).toMatch(/^codex\s+6\/10 \(30\)/);
    expect(lines[5]).toMatch(/^gemini\s+0\/10 \(0\)/);

    const reasons = section(why, "Why claude won:");
    expect(reasons).toHaveLength(REASON_COUNT);
    for (const r of reasons) expect(r.startsWith("- ")).toBe(true);
    // Biggest margin first: tests (45 vs 30 for the best other fork).
    expect(reasons[0]).toBe("- Tests: 9/10 passed, 45 points vs 30 for the best other fork.");

    const others = section(why, "Others:");
    expect(others).toHaveLength(2);
    expect(others[0]).toMatch(/^- codex \(\d+(\.\d+)?\/100\): lost most on tests/);
    expect(others[1]).toBe("- gemini (50/100): 0 tests passed, cannot win.");

    // Plain text: no markdown markers.
    expect(why).not.toMatch(/[#*`]/);
    expect(why).not.toContain("\r");
  });

  it("no winner: says so on line 1, has no reasons, and lists every fork under Others", () => {
    const result = scoreForks([fork({ agent: "a", testsPassed: 0 }), fork({ agent: "b", testsPassed: 0 })]);
    const why = buildWhy(result);
    expect(why.split("\n")[0]).toBe("No winner: no fork passed any tests.");
    expect(why).not.toContain("won:");
    expect(section(why, "Others:")).toEqual([
      "- a (50/100): 0 tests passed, cannot win.",
      "- b (50/100): 0 tests passed, cannot win.",
    ]);
  });

  it("a lone winner still gets 3 reasons and no Others section", () => {
    const why = buildWhy(scoreForks([fork({ agent: "solo" })]));
    expect(section(why, "Why solo won:")).toHaveLength(3);
    expect(why).not.toContain("Others:");
  });
});

describe("winnerReasons", () => {
  it("includes diff size when the winner won on fewer lines changed", () => {
    const winner = scoreFork(fork({ agent: "small", linesChanged: 20 }));
    const other = scoreFork(fork({ agent: "big", linesChanged: 200 }));
    const reasons = winnerReasons(winner, [other]);
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toBe("Diff size: 20 lines changed vs 200 for the smallest other fork.");
    expect(loserLine(other, winner)).toBe("big (100/100): no lower part, lost on diff size (200 vs 20 lines changed).");
  });

  it("explains a tie broken by finish time, and a loser that finished later", () => {
    const [winner, other] = scoreForks([
      fork({ agent: "testy", endedAt: "2026-10-04T13:49:01.000Z" }),
      fork({ agent: "zippy", endedAt: "2026-10-04T13:48:49.000Z" }),
    ]).ranked;
    expect(winner!.agent).toBe("zippy");
    expect(winnerReasons(winner!, [other!])[0]).toBe("Finish: tied with testy on points and diff size, and finished first, 12 s earlier.");
    expect(loserLine(other!, winner!)).toBe("testy (100/100): tied on points and diff size, finished 12 s after zippy.");
  });

  it("says a full tie was decided by agent order", () => {
    const [winner, other] = scoreForks([fork({ agent: "ponder" }), fork({ agent: "snip" })]).ranked;
    expect(winnerReasons(winner!, [other!])[0]).toBe("Tie: level with snip on points, diff size and finish time; won on agent order.");
    expect(loserLine(other!, winner!)).toBe("snip (100/100): tied on points, diff size and finish time, lost on agent order.");
  });

  it("mentions shared files in the claim reason", () => {
    const winner = scoreFork(fork({ agent: "w", filesShared: ["src/a.ts"], taskFit: 1 }));
    const other = scoreFork(fork({ agent: "o", taskFit: 0.5, filesChanged: ["src/a.ts", "src/x.ts"] }));
    expect(winnerReasons(winner, [other]).join("\n")).toContain("Claim: changed files it held only as shared (src/a.ts), 8 points");
  });

  it("says when shared files cost nothing because every fork changed them", () => {
    const [winner, other] = scoreForks([
      fork({ agent: "w", filesShared: ["src/a.ts"] }),
      fork({ agent: "o", filesChanged: ["src/a.ts", "x.ts"] }),
    ]).ranked;
    expect(winnerReasons(winner!, [other!]).join("\n")).toContain(
      "Claim: kept its file claim, 10 points; its shared files (src/a.ts) cost nothing, since every other fork changed them too",
    );
  });

  it("formats durations", () => {
    expect(duration(12_400)).toBe("12 s");
    expect(duration(120_000)).toBe("2 min");
    expect(duration(125_000)).toBe("2 min 5 s");
  });

  it("orders reasons by margin and mentions unclaimed files", () => {
    const winner = scoreFork(fork({ agent: "w", clarity: 1, taskFit: 0.5, filesChanged: ["a.ts"], filesClaimed: [] }));
    const other = scoreFork(fork({ agent: "o", testsPassed: 5, clarity: 0, taskFit: 0.5 }));
    const reasons = winnerReasons(winner, [other]);
    expect(reasons[0]).toContain("Tests:");
    expect(reasons[1]).toContain("Clarity:");
    expect(reasons.join("\n")).not.toContain("Diff size");
    expect(winnerReasons(winner, [other]).join(" ")).not.toContain("unclaimed");
    const claim = winnerReasons(scoreFork(fork({ filesChanged: ["x.ts"], filesClaimed: [] })), []);
    expect(claim).toHaveLength(3);
    expect(scoresTable([]).split("\n")).toHaveLength(1);
  });

  it("never gives a part the winner trailed on as a reason it won, and ignores ineligible forks", () => {
    // Review finding: gemini (ineligible) had the best task fit, so claude's task fit showed up as a "reason".
    const result = scoreForks([
      fork({ agent: "claude", testsPassed: 9, taskFit: 0.8, clarity: 0.6 }),
      fork({ agent: "codex", testsPassed: 6, taskFit: 0.9, clarity: 0.4, filesChanged: ["src/a.ts", "x.ts"] }),
      fork({ agent: "gemini", testsPassed: 0 }),
    ]);
    const reasons = section(buildWhy(result), "Why claude won:");
    expect(reasons).toEqual([
      "- Tests: 9/10 passed, 45 points vs 30 for the best other fork.",
      "- Claim: kept its file claim, 10 points vs 0 for the best other fork.",
      "- Clarity: 9 points vs 6 for the best other fork.",
    ]);
  });

  it("says level or behind plainly when fewer than 3 parts favor the winner", () => {
    const result = scoreForks([
      fork({ agent: "claude", testsPassed: 10, taskFit: 0.5, clarity: 0.5 }),
      fork({ agent: "codex", testsPassed: 5, taskFit: 1, clarity: 1 }),
    ]);
    expect(result.winner).toBe("claude");
    const reasons = section(buildWhy(result), "Why claude won:");
    expect(reasons).toEqual([
      "- Tests: 10/10 passed, 50 points vs 25 for the best other fork.",
      "- Claim: kept its file claim, 10 points, level with the best other fork.",
      "- Clarity: 7.5 points, behind 15 for the best other fork, made up on other parts.",
    ]);
  });

  it("explains a fork that changed no files as unable to win", () => {
    const result = scoreForks([fork({ agent: "claude" }), fork({ agent: "idle", filesChanged: [], linesChanged: 0 })]);
    const idle = result.ranked.find((s) => s.agent === "idle")!;
    expect(loserLine(idle, result.ranked[0])).toBe(`idle (${idle.total}/100): changed no files, cannot win.`);
  });
});

describe("headline", () => {
  it('W1: why: a clear code lead gives the "Decided by code" headline with the gap', () => {
    const result = scoreForks([fork({ agent: "w" }), fork({ agent: "r", testsPassed: 8 })]);
    expect(headline(result)).toBe("Decided by code: w's fix scored 10 more points on tests, task fit and clarity than r's.");
    // A gap of exactly CODE_TIE (24 vs 25 task fit points) is still decided by code.
    expect(CODE_TIE).toBe(1);
    const edge = scoreForks([fork({ agent: "w" }), fork({ agent: "r", taskFit: 0.96 })]);
    expect(headline(edge)).toBe("Decided by code: w's fix scored 1 more points on tests, task fit and clarity than r's.");
  });

  it('W2: why: equal code with a claim lead gives "Decided by claims … had no clash r could have avoided (10 vs 8 claim points)"; a winner whose code is up to 1 point lower gets the "even though" clause', () => {
    const shared = fork({ agent: "r", filesShared: ["src/a.ts"] });
    expect(headline(scoreForks([avoids(), shared]))).toBe(
      "Decided by claims: the fixes were within 0 points on code; w had no avoidable clash and r did (10 vs 8 claim points).",
    );
    expect(headline(scoreForks([avoids({ taskFit: 0.98 }), shared]))).toBe(
      "Decided by claims: the fixes were within 0.5 points on code; w had no avoidable clash and r did (10 vs 8 claim points) even though its code scored 0.5 lower.",
    );
    const unclaimed = fork({ agent: "r", filesChanged: ["src/a.ts", "x.ts"] });
    expect(headline(scoreForks([avoids(), unclaimed]))).toBe(
      "Decided by claims: the fixes were within 0 points on code; w kept its file claim (10 vs 0 claim points).",
    );
  });

  it('W3: why: a winner more than 1 point behind on code that wins on claims gets the "made up for it" headline; a close race with no claim gap gets "Decided by a close margin"', () => {
    const behind = scoreForks([avoids({ taskFit: 0.94 }), fork({ agent: "r", filesShared: ["src/a.ts"] })]);
    expect(behind.winner).toBe("w");
    expect(headline(behind)).toBe(
      "Decided by claims: w's code scored 1.5 points lower than r's, but its claim points made up for it (10 vs 8).",
    );
    const close = scoreForks([fork({ agent: "w" }), fork({ agent: "r", taskFit: 0.98 })]);
    expect(headline(close)).toBe("Decided by a close margin: the fixes were within 0.5 points on code.");
  });

  it('W4: why: there is no headline with no winner or a lone fork; the headline sits between the table and "Why <winner> won:", and the rest of the why is unchanged', () => {
    const none = [
      scoreForks([fork({ agent: "a", testsPassed: 0 }), fork({ agent: "b", testsPassed: 0 })]),
      scoreForks([fork({ agent: "solo" })]),
      scoreForks([fork({ agent: "w" }), fork({ agent: "b", testsPassed: 0 })]),
    ];
    for (const result of none) {
      expect(headline(result)).toBeUndefined();
      expect(buildWhy(result)).not.toContain("Decided by");
    }

    const result = scoreForks([fork({ agent: "w" }), fork({ agent: "r", testsPassed: 8 })]);
    const head = headline(result)!;
    const why = buildWhy(result);
    const lines = why.split("\n");
    const tableLines = scoresTable(result.ranked).split("\n");
    const after = 2 + tableLines.length;
    expect(lines.slice(2, after)).toEqual(tableLines);
    expect(lines.slice(after, after + 4)).toEqual(["", head, "", "Why w won:"]);

    const winner = result.ranked[0]!;
    const losers = result.ranked.slice(1);
    const expected = [
      `Winner: ${winner.agent} (${winner.total}/100)`,
      "",
      scoresTable(result.ranked),
      "",
      "Why w won:",
      ...winnerReasons(winner, losers).map((r) => `- ${r}`),
      "",
      "Others:",
      ...losers.map((l) => `- ${loserLine(l, winner)}`),
    ].join("\n");
    expect(why.replace(`\n\n${head}`, "")).toBe(expected);
  });
});

describe("same fix", () => {
  it("says the forks wrote the same fix and that finish time decided it", () => {
    const result = scoreForks([
      fork({ agent: "late", fix: "f1", endedAt: "2026-10-05T10:00:30.000Z" }),
      fork({ agent: "early", fix: "f1", endedAt: "2026-10-05T10:00:00.000Z" }),
      fork({ agent: "third", fix: "f1", endedAt: "2026-10-05T10:01:00.000Z" }),
    ]);
    expect(result.winner).toBe("early");
    expect(decidedBy(result)).toBe("same");
    expect(headline(result)).toBe("Decided by finish time: early, late and third wrote the same fix; early finished first, 30 s earlier.");
  });

  it("names only the forks with the winner's fix, and the part that differed on the same code", () => {
    const result = scoreForks([fork({ agent: "w", fix: "f1" }), fork({ agent: "r", fix: "f1", testsPassed: 9 }), fork({ agent: "o", fix: "f2", testsPassed: 8 })]);
    expect(headline(result)).toBe("Decided by score on the same code: w and r wrote the same fix; w scored 5 more points on tests.");
  });

  it("says when diff size, not finish time, separated the same fix", () => {
    const result = scoreForks([
      fork({ agent: "w", fix: "f1", linesChanged: 10, endedAt: "2026-10-05T10:01:00.000Z" }),
      fork({ agent: "r", fix: "f1", linesChanged: 12, endedAt: "2026-10-05T10:00:00.000Z" }),
    ]);
    expect(headline(result)).toBe("Decided by diff size: w and r wrote the same fix; w's diff was 2 lines smaller (blank lines or whitespace).");
  });

  it("falls back to agent order when the same fix finished at the same time", () => {
    expect(headline(scoreForks([fork({ agent: "w", fix: "f1" }), fork({ agent: "r", fix: "f1" })]))).toBe(
      "Decided by agent order: w and r wrote the same fix and finished together.",
    );
  });

  it("is not used when the runner-up wrote a different fix, or the fix is unknown", () => {
    expect(decidedBy(scoreForks([fork({ agent: "w", fix: "f1" }), fork({ agent: "r", fix: "f2" })]))).toBe("close");
    expect(decidedBy(scoreForks([fork({ agent: "w" }), fork({ agent: "r" })]))).toBe("close");
  });
});

describe("decidedBy", () => {
  it("X2: decidedBy gives code, claims (both cases), close and undefined in step with headline", () => {
    const shared = fork({ agent: "r", filesShared: ["src/a.ts"] });
    const cases = [
      { result: scoreForks([avoids(), fork({ agent: "r", testsPassed: 8 })]), by: "code", prefix: "Decided by code:" },
      // Exactly CODE_TIE is still code.
      { result: scoreForks([avoids(), fork({ agent: "r", taskFit: 0.96 })]), by: "code", prefix: "Decided by code:" },
      // Claims within the tie, level and slightly lower on code.
      { result: scoreForks([avoids(), shared]), by: "claims", prefix: "Decided by claims: the fixes were within" },
      { result: scoreForks([avoids({ taskFit: 0.98 }), shared]), by: "claims", prefix: "Decided by claims: the fixes were within" },
      // Claims made up for code more than CODE_TIE lower.
      { result: scoreForks([avoids({ taskFit: 0.94 }), shared]), by: "claims", prefix: "Decided by claims: w's code scored" },
      { result: scoreForks([avoids(), fork({ agent: "r", taskFit: 0.98 })]), by: "close", prefix: "Decided by a close margin:" },
    ] as const;
    for (const { result, by, prefix } of cases) {
      expect(decidedBy(result), prefix).toBe(by);
      expect(headline(result)?.startsWith(prefix), prefix).toBe(true);
    }

    // No winner, a lone fork, or no eligible runner-up: undefined, like headline.
    for (const result of [
      scoreForks([fork({ agent: "a", testsPassed: 0 }), fork({ agent: "b", testsPassed: 0 })]),
      scoreForks([fork({ agent: "solo" })]),
      scoreForks([fork({ agent: "w" }), fork({ agent: "b", testsPassed: 0 })]),
      scoreForks([]),
    ]) {
      expect(headline(result)).toBeUndefined();
      expect(decidedBy(result)).toBeUndefined();
    }
  });
});

describe("lesson", () => {
  it("names the part where the winner led by the most points, in plain words", () => {
    const tests = scoreForks([fork({ agent: "w", testsPassed: 10 }), fork({ agent: "l", testsPassed: 7, filesChanged: ["src/b.ts"], filesClaimed: ["src/b.ts"] })]);
    expect(lesson(tests)).toBe("more of its tests passed (10/10 vs 7/10)");
    const clarity = scoreForks([fork({ agent: "w", clarity: 0.9, taskFit: 0.95 }), fork({ agent: "l", clarity: 0.5, taskFit: 0.9 })]);
    expect(lesson(clarity)).toBe("the judge rated its diff the most focused and easiest to review");
    const fit = scoreForks([fork({ agent: "w", taskFit: 1, clarity: 0.6 }), fork({ agent: "l", taskFit: 0.6, clarity: 0.65 })]);
    expect(lesson(fit)).toBe("the judge rated its change the closest fit to everything the task asked");
    const look = scoreForks([fork({ agent: "w", look: 1 }), fork({ agent: "l", look: 0.4 })]);
    expect(lesson(look)).toBe("its page looked best in the screenshots at desktop and phone width");
    const claim = scoreForks([avoids(), fork({ agent: "l", filesShared: ["src/a.ts"] })]);
    expect(lesson(claim)).toBe("it changed only files it had claimed, with no avoidable clash");
  });

  it("falls back to a smaller diff, then to finishing first, and says nothing when only agent order decided", () => {
    const smaller = scoreForks([fork({ agent: "w", linesChanged: 41 }), fork({ agent: "l", linesChanged: 60 })]);
    expect(lesson(smaller)).toBe("its diff was the smallest (41 lines changed vs 60)");
    const first = scoreForks([fork({ agent: "w", endedAt: "2026-10-05T00:00:00Z" }), fork({ agent: "l", endedAt: "2026-10-05T00:01:00Z" })]);
    expect(lesson(first)).toBe("the fixes tied on points and diff size, and it finished first");
    expect(lesson(scoreForks([fork({ agent: "w" }), fork({ agent: "l" })]))).toBeUndefined();
  });

  it("says when the winner was the only eligible fork, and nothing with no winner", () => {
    expect(lesson(scoreForks([fork({ agent: "w" }), fork({ agent: "l", testsPassed: 0 })]))).toBe("it was the only fork that changed files and passed tests");
    expect(lesson(scoreForks([fork({ agent: "l", testsPassed: 0 })]))).toBeUndefined();
  });
});
