import { fixFingerprint } from "../src/judge/score";
import { describe, expect, it, vi } from "vitest";

import {
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
  testCommand,
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
    expect(result.forks.map((f) => f.agent)).toEqual(["careful", "fast", "lean"]);
    expect(result.scores.ranked).toHaveLength(3);
    expect(result.scores.ranked.map((s) => s.agent)).toEqual(["careful", "fast", "lean"]);
    expect(result.winner).toBe("careful");
    expect(result.scores.winner).toBe("careful");
    expect(result.why.split("\n")[0]).toBe(`Winner: careful (${result.scores.ranked[0]!.total}/100)`);
    expect(result.why).toContain("Why careful won:");

    const careful = result.forks[0]!;
    expect(careful.tests).toEqual({ passed: 10, total: 10 });
    expect(careful.diff).toEqual({ filesChanged: ["src/careful.ts"], linesAdded: 2, linesRemoved: 1 });
    expect(careful.input).toEqual({
      agent: "careful",
      testsPassed: 10,
      testsTotal: 10,
      taskFit: 0.75,
      clarity: 0.5,
      linesChanged: 3,
      filesChanged: ["src/careful.ts"],
      filesClaimed: ["src/careful.ts"],
      filesShared: [],
      fix: fixFingerprint("+// change by careful\n"),
    });

    expect(deps.runTests).toHaveBeenCalledTimes(3);
    expect(deps.getDiff).toHaveBeenCalledTimes(3);
    expect(score).toHaveBeenCalledTimes(3);
    expect(score.mock.calls[0]![0]).toEqual({
      task: input.task,
      diff: "+// change by careful\n",
      filesChanged: ["src/careful.ts"],
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
      if (fork.agent === "fast") throw new Error("npm test printed no test summary");
      return { passed: 6, total: 10 };
    });
    const deps = fakeDeps({ runTests });
    const result = await judgeTask(deps, fakeInput());

    const fastCalls = runTests.mock.calls.filter(([fork]) => fork.agent === "fast");
    expect(fastCalls).toHaveLength(TEST_ATTEMPTS);
    expect(TEST_ATTEMPTS).toBe(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(TEST_RETRY_DELAY_MS);

    const fast = result.forks.find((f) => f.agent === "fast")!;
    expect(fast.tests.passed).toBe(0);
    expect(fast.tests.total).toBe(0);
    expect(fast.tests.error).toContain("no test summary");
    expect(fast.input.testsPassed).toBe(0);
    const score = result.scores.ranked.find((s) => s.agent === "fast")!;
    expect(score.eligible).toBe(false);
    expect(score.parts.tests).toBe(0);
    expect(result.scores.ranked.at(-1)!.agent).toBe("fast");
    expect(result.winner).not.toBe("fast");
    expect(result.why).toContain("- fast (");
    expect(result.why).toContain("0 tests passed, cannot win.");
  });

  it("a test run that fails twice then passes keeps its result", async () => {
    const runTests = vi
      .fn<(fork: JudgeFork) => Promise<{ passed: number; total: number }>>()
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValue({ passed: 3, total: 4 });
    const deps = fakeDeps({ runTests });
    const judged = await judgeFork(deps, fakeInput(["careful"]), fakeFork("careful"));
    expect(runTests).toHaveBeenCalledTimes(3);
    expect(judged.tests).toEqual({ passed: 3, total: 4 });
  });

  it("skips the scorer when the fork changed no files", async () => {
    const scorer = fakeScorer();
    const score = vi.spyOn(scorer, "score");
    const getDiff = vi.fn(async () => ({ diff: "", filesChanged: [], linesAdded: 0, linesRemoved: 0 }));
    const judged = await judgeFork(fakeDeps({ scorer, getDiff }), fakeInput(), fakeFork("careful"));
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
  });
});
