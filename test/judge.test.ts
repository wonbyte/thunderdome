import { CROSS_TEST_BUDGET_MS } from "../src/judge/crosstests";
import { fixFingerprint } from "../src/judge/score";
import { describe, expect, it, vi } from "vitest";

import {
  BASE_AUTHOR,
  CONTEXT_CHARS,
  type CrossTest,
  decide,
  FORK_STEP_TIMEOUT_S,
  forkPoint,
  judgeFork,
  judgeInstanceId,
  judgeTask,
  parseNumstat,
  parseTestSummary,
  TEST_ATTEMPTS,
  TEST_RETRY_DELAY_MS,
  TEST_TIMEOUT_S,
  sharedSuite,
  testCommand,
  type JudgedFork,
  type JudgeFork,
} from "../src/judge/judge";
import { fakeScorer } from "../src/judge/scorer";
import { fakeDeps, fakeFork, fakeInput, TASK_ID } from "./judge-fakes";

describe("judgeTask", () => {
  it("R6: 3 fake finished forks give 3 scores, 1 winner, and a why", async () => {
    const scorer = fakeScorer({ taskFit: 0.75, clarity: 0.5 });
    const score = vi.spyOn(scorer, "score");
    const deps = fakeDeps({ scorer });
    const input = fakeInput();
    const result = await judgeTask(deps, input);

    expect(result.taskId).toBe(TASK_ID);
    expect(result.forks.map((f) => f.agent)).toEqual(["ponder", "zippy", "snip"]);
    expect(result.scores.ranked).toHaveLength(3);
    expect(result.scores.ranked.map((s) => s.agent)).toEqual(["ponder", "zippy", "snip"]);
    expect(result.winner).toBe("ponder");
    expect(result.scores.winner).toBe("ponder");
    expect(result.why.split("\n")[0]).toBe(`Winner: ponder (${result.scores.ranked[0]!.total}/100)`);
    expect(result.why).toContain("Why ponder won:");

    const ponder = result.forks[0]!;
    expect(ponder.tests).toEqual({ passed: 10, total: 10 });
    expect(ponder.diff).toEqual({ filesChanged: ["src/ponder.ts"], linesAdded: 2, linesRemoved: 1 });
    expect(ponder.input).toEqual({
      agent: "ponder",
      testsPassed: 10,
      testsTotal: 10,
      taskFit: 0.75,
      clarity: 0.5,
      linesChanged: 3,
      filesChanged: ["src/ponder.ts"],
      filesClaimed: ["src/ponder.ts"],
      filesShared: [],
      fix: fixFingerprint("+// change by ponder\n"),
    });

    expect(deps.runTests).toHaveBeenCalledTimes(3);
    expect(deps.getDiff).toHaveBeenCalledTimes(3);
    expect(score).toHaveBeenCalledTimes(3);
    expect(score.mock.calls[0]![0]).toEqual({
      task: input.task,
      author: "Ponder",
      diff: "+// change by ponder\n",
      filesChanged: ["src/ponder.ts"],
      linesAdded: 2,
      linesRemoved: 1,
    });

    // JSON-serializable and free of diff text.
    const json = JSON.stringify(result);
    expect(JSON.parse(json)).toEqual(result);
    expect(json).not.toContain("change by");
  });

  it("R7: the test run retries 2× and then scores the fork as 0 tests passed", async () => {
    const runTests = vi.fn(async (fork: JudgeFork) => {
      if (fork.agent === "zippy") throw new Error("npm test printed no test summary");
      return { passed: 6, total: 10 };
    });
    const deps = fakeDeps({ runTests });
    const result = await judgeTask(deps, fakeInput());

    const fastCalls = runTests.mock.calls.filter(([fork]) => fork.agent === "zippy");
    expect(fastCalls).toHaveLength(TEST_ATTEMPTS);
    expect(TEST_ATTEMPTS).toBe(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(TEST_RETRY_DELAY_MS);

    const zippy = result.forks.find((f) => f.agent === "zippy")!;
    expect(zippy.tests.passed).toBe(0);
    expect(zippy.tests.total).toBe(0);
    expect(zippy.tests.error).toContain("no test summary");
    expect(zippy.input.testsPassed).toBe(0);
    const score = result.scores.ranked.find((s) => s.agent === "zippy")!;
    expect(score.eligible).toBe(false);
    expect(score.parts.tests).toBe(0);
    expect(result.scores.ranked.at(-1)!.agent).toBe("zippy");
    expect(result.winner).not.toBe("zippy");
    expect(result.why).toContain("- zippy (");
    expect(result.why).toContain("0 tests passed, cannot win.");
  });

  it("a test run that fails twice then passes keeps its result", async () => {
    const runTests = vi
      .fn<(fork: JudgeFork) => Promise<{ passed: number; total: number }>>()
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValue({ passed: 3, total: 4 });
    const deps = fakeDeps({ runTests });
    const judged = await judgeFork(deps, fakeInput(["ponder"]), fakeFork("ponder"));
    expect(runTests).toHaveBeenCalledTimes(3);
    expect(judged.tests).toEqual({ passed: 3, total: 4 });
  });

  it("skips the scorer when the fork changed no files", async () => {
    const scorer = fakeScorer();
    const score = vi.spyOn(scorer, "score");
    const getDiff = vi.fn(async () => ({ diff: "", filesChanged: [], linesAdded: 0, linesRemoved: 0 }));
    const judged = await judgeFork(fakeDeps({ scorer, getDiff }), fakeInput(), fakeFork("ponder"));
    expect(score).not.toHaveBeenCalled();
    expect(judged.scorer).toBeUndefined();
    expect("scorer" in judged).toBe(false);
    expect(judged.input).toMatchObject({ taskFit: 0, clarity: 0, linesChanged: 0, filesChanged: [] });
  });

  it("lets getDiff and scorer errors propagate", async () => {
    const getDiff = vi.fn(async () => {
      throw new Error("git diff failed");
    });
    await expect(judgeTask(fakeDeps({ getDiff }), fakeInput())).rejects.toThrow("git diff failed");
    const scorer = { score: vi.fn(async () => Promise.reject(new Error("TypeSafe returned 401"))) };
    await expect(judgeTask(fakeDeps({ scorer }), fakeInput())).rejects.toThrow("401");
  });

  it("decide gives no winner when no fork passed a test", async () => {
    const runTests = vi.fn(async () => ({ passed: 0, total: 10 }));
    const input = fakeInput();
    const forks = await Promise.all(input.forks.map((f) => judgeFork(fakeDeps({ runTests }), input, f)));
    const result = decide(input, forks);
    expect(result.winner).toBeNull();
    expect(result.why.split("\n")[0]).toBe("No winner: no fork passed any tests.");
  });
});

describe("helpers", () => {
  it("judgeInstanceId appends -judge", () => {
    expect(judgeInstanceId(TASK_ID)).toBe("t-0123abcd-judge");
  });

  it("parseTestSummary reads TAP and spec summaries", () => {
    expect(parseTestSummary("ok 1 - a\n# tests 7\n# suites 0\n# pass 5\n# fail 2\n")).toEqual({ passed: 5, total: 7 });
    expect(parseTestSummary("✔ a (1ms)\nℹ tests 3\nℹ suites 1\nℹ pass 3\nℹ fail 0\n")).toEqual({ passed: 3, total: 3 });
    expect(parseTestSummary("Error: Cannot find module\n")).toBeUndefined();
    expect(parseTestSummary("# tests 4\n")).toBeUndefined();
  });

  it("parseNumstat sums lines and lists files", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n10\t0\ttest/a.test.ts\n")).toEqual({
      filesChanged: ["src/a.ts", "img.png", "test/a.test.ts"],
      linesAdded: 13,
      linesRemoved: 1,
    });
    expect(parseNumstat("")).toEqual({ filesChanged: [], linesAdded: 0, linesRemoved: 0 });
  });
});

describe("fork diff base", () => {
  it("forkPoint finds where the fork started, even after the source repo moved on", () => {
    // Review finding: diffing against the source's current head breaks once the source gets a new commit.
    const sourceLog = ["s2", "s1", "p", "p1", "p0"]; // newest first; s1, s2 landed after the fork
    expect(forkPoint(["a2", "a1", "p", "p1", "p0"], sourceLog)).toBe("p");
    expect(forkPoint(["p", "p1", "p0"], sourceLog)).toBe("p"); // agent pushed nothing
    expect(forkPoint(["x2", "x1"], sourceLog)).toBeUndefined();
  });
});

describe("test run timeout", () => {
  it("runs npm test under a hard timeout, and every attempt fits inside one Workflow step", () => {
    // Review finding: a hanging suite ran into the step timeout instead of scoring 0 tests passed.
    const argv = testCommand();
    expect(argv[0]).toBe("timeout");
    expect(argv.slice(-2)).toEqual(["npm", "test"]);
    const killAfterS = 10;
    const worstCaseS = TEST_ATTEMPTS * (TEST_TIMEOUT_S + killAfterS) + ((TEST_ATTEMPTS - 1) * TEST_RETRY_DELAY_MS) / 1000;
    // Leave at least a minute of the step for the clone, the diff and the scorer.
    expect(worstCaseS + 60).toBeLessThanOrEqual(FORK_STEP_TIMEOUT_S);
    // Review finding: cross tests after a hung suite pushed the step past its timeout. With the
    // full cross test budget there are still two minutes left (they also stop at the step's deadline).
    expect(worstCaseS + CROSS_TEST_BUDGET_MS / 1000 + 120).toBeLessThanOrEqual(FORK_STEP_TIMEOUT_S);
  });
});

describe("the shared suite", () => {
  const run = (author: string, file: string, passed: number, total: number): CrossTest => ({ author, file, passed, total });
  const judged = async (agent: string, crossTests?: CrossTest[]): Promise<JudgedFork> => {
    const fork = await judgeFork(fakeDeps({ crossTests: async () => crossTests }), fakeInput(), fakeFork(agent));
    return fork;
  };

  it("S1: base files always count; an added file counts only when it passes in full on at least two forks", async () => {
    const forks = [
      await judged("ponder", [run(BASE_AUTHOR, "test/cart.test.ts", 4, 4), run("ponder", "test/p.test.ts", 3, 3), run("zippy", "test/z.test.ts", 2, 2), run("snip", "test/s.test.ts", 0, 5)]),
      await judged("zippy", [run(BASE_AUTHOR, "test/cart.test.ts", 3, 4), run("ponder", "test/p.test.ts", 1, 3), run("zippy", "test/z.test.ts", 2, 2), run("snip", "test/s.test.ts", 0, 1)]),
      await judged("snip", [run(BASE_AUTHOR, "test/cart.test.ts", 4, 4), run("ponder", "test/p.test.ts", 0, 0), run("zippy", "test/z.test.ts", 1, 2), run("snip", "test/s.test.ts", 5, 5)]),
    ];
    // Counted: base (4), ponder's p (passes on ponder only: no), zippy's z (ponder + zippy: yes, size 2), snip's s (snip only: no).
    const suite = sharedSuite(forks)!;
    expect(Object.fromEntries(suite)).toEqual({
      ponder: { passed: 6, total: 6 },
      zippy: { passed: 5, total: 6 },
      snip: { passed: 5, total: 6 },
    });
  });

  it("S2: a fork without cross tests turns the shared suite off for everyone", async () => {
    const forks = [await judged("ponder", [run(BASE_AUTHOR, "test/a.test.ts", 1, 1)]), await judged("zippy", undefined)];
    expect(sharedSuite(forks)).toBeUndefined();
    expect(decide(fakeInput(), forks).forks.every((f) => f.input.shared === undefined)).toBe(true);
  });

  it("S3: decide puts the shared counts on each input, scores tests on them, and drops the context diff", async () => {
    const forks = [
      await judged("ponder", [run(BASE_AUTHOR, "test/a.test.ts", 2, 4)]),
      await judged("zippy", [run(BASE_AUTHOR, "test/a.test.ts", 4, 4)]),
    ];
    expect(forks[0]!.context).toBe("+// change by ponder\n");
    const result = decide(fakeInput(["ponder", "zippy"]), forks);
    expect(result.forks.map((f) => f.input.shared)).toEqual([{ passed: 2, total: 4 }, { passed: 4, total: 4 }]);
    expect(result.scores.ranked.find((s) => s.agent === "ponder")?.parts.tests).toBe(25);
    expect(result.forks.some((f) => f.context !== undefined)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("change by");
  });

  it("S4: Clef scores the function-context diff when there is one, and the kept context is clipped", async () => {
    const long = `+${"x".repeat(CONTEXT_CHARS + 10)}`;
    const score = vi.fn(fakeScorer().score);
    const deps = fakeDeps({ getDiff: async () => ({ diff: "+short\n", context: long, filesChanged: ["src/a.ts"], linesAdded: 1, linesRemoved: 0 }), scorer: { score } });
    const fork = await judgeFork(deps, fakeInput(), fakeFork("zippy"));
    expect(score.mock.calls[0]![0]).toMatchObject({ author: "Zippy", diff: long });
    expect(fork.context?.endsWith(`[diff clipped at ${CONTEXT_CHARS} chars]`)).toBe(true);
  });

  it("S5: a failing cross-test run leaves the fork without cross tests instead of failing the judge", async () => {
    const fork = await judgeFork(fakeDeps({ crossTests: () => Promise.reject(new Error("boom")) }), fakeInput(), fakeFork("ponder"));
    expect(fork.crossTests).toBeUndefined();
  });

  it("S6: when the task splits the work, only the repo's test files count, and the split answer is kept on the result", async () => {
    const forks = [
      await judged("ponder", [run(BASE_AUTHOR, "test/a.test.ts", 4, 4), run("zippy", "test/z.test.ts", 0, 2), run("ponder", "test/p.test.ts", 3, 3)]),
      await judged("zippy", [run(BASE_AUTHOR, "test/a.test.ts", 4, 4), run("zippy", "test/z.test.ts", 2, 2), run("ponder", "test/p.test.ts", 0, 3)]),
      await judged("snip", [run(BASE_AUTHOR, "test/a.test.ts", 3, 4), run("zippy", "test/z.test.ts", 2, 2), run("ponder", "test/p.test.ts", 3, 3)]),
    ];
    expect(sharedSuite(forks, 0.02)!.get("ponder")).toEqual({ passed: 7, total: 9 });
    expect(Object.fromEntries(sharedSuite(forks, 0.97)!)).toEqual({ ponder: { passed: 4, total: 4 }, zippy: { passed: 4, total: 4 }, snip: { passed: 3, total: 4 } });
    expect(decide(fakeInput(), forks, undefined, 0.97).split).toBe(0.97);
    expect(decide(fakeInput(), forks).split).toBeUndefined();
  });
});

