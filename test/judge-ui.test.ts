import { describe, expect, it } from "vitest";

import { BASE_AUTHOR as SERVER_BASE, decide, judgeFork, type CrossTest } from "../src/judge/judge";
import { JUDGE_TIE as SERVER_TIE } from "../src/judge/score";
import { fakeDeps, fakeFork, fakeInput } from "./judge-fakes";

import { applyEvent, emptyBoard, type WireTask } from "../src/ui/board";
import { BASE_AUTHOR, JUDGE_TIE, judgeSteps, judgeView } from "../src/ui/judgeview";
import { buildTimeline } from "../src/ui/timeline";

const probs = (top: number) => ({ type: "score", score: top, probabilities: Object.fromEntries([0, 1, 2, 3, 4, 5].map((n) => [String(n), n === top ? 0.5 : 0.1])) });

/** A judge body shaped like GET /tasks/:id/judge. */
function body(split?: number) {
  const run = (author: string, file: string, passed: number, total: number) => ({ author, file, passed, total });
  return {
    status: "complete",
    output: {
      ...(split === undefined ? {} : { split }),
      scores: {
        ranked: [
          { agent: "testy", total: 82.8, eligible: true, parts: { tests: 40, taskFit: 14.4, clarity: 8.5, look: 9.5, claim: 10 } },
          { agent: "ponder", total: 82.5, eligible: true, parts: { tests: 40, taskFit: 14.1, clarity: 8.5, look: 9.5, claim: 10 } },
        ],
        tie: { agents: ["testy", "ponder"], by: "compare", gap: 0.3, prefer: { testy: 0.88, ponder: 0.06 } },
      },
      forks: [
        { agent: "testy", crossTests: [run("base", "test/shop.test.ts", 6, 6), run("testy", "test/t.test.ts", 5, 5), run("ponder", "test/p.test.ts", 3, 3)], input: { shared: { passed: 14, total: 14 } }, scorer: { raw: { taskFit: probs(5) } } },
        { agent: "ponder", crossTests: [run("base", "test/shop.test.ts", 6, 6), run("testy", "test/t.test.ts", 2, 5), run("ponder", "test/p.test.ts", 3, 3)], input: { shared: { passed: 11, total: 14 } }, scorer: { raw: { taskFit: probs(3) } } },
      ],
    },
  };
}

describe("judgeView", () => {
  it("V1: reads the tie with each tied robot's Clef points and the side-by-side vote", () => {
    const tie = judgeView(body())?.tie;
    expect(tie).toMatchObject({ agents: ["testy", "ponder"], by: "compare", gap: 0.3, prefer: { testy: 0.88, ponder: 0.06 } });
    expect(tie?.judgment.testy).toBeCloseTo(32.4);
    expect(judgeView({ output: { scores: { ranked: [] }, forks: [] } })?.tie).toBeUndefined();
    expect(judgeView({ status: "running" })).toBeUndefined();
  });

  it("V2: the grid has the repo's files first, then each robot's; a robot's file counts when it passes in full on two forks", () => {
    const cross = judgeView(body())!.cross!;
    expect(cross.columns).toEqual([
      { author: "base", file: "test/shop.test.ts", counted: true },
      { author: "ponder", file: "test/p.test.ts", counted: true },
      { author: "testy", file: "test/t.test.ts", counted: false },
    ]);
    expect(cross.rows[1]).toEqual({ agent: "ponder", cells: [{ passed: 6, total: 6 }, { passed: 3, total: 3 }, { passed: 2, total: 5 }], shared: { passed: 11, total: 14 } });
    expect(cross.split).toBe(false);
  });

  it("V3: on a split task only the repo's files count", () => {
    const cross = judgeView(body(0.97))!.cross!;
    expect(cross.split).toBe(true);
    expect(cross.columns.map((c) => c.counted)).toEqual([true, false, false]);
  });

  it("V4: reads Clef's task-fit probabilities per robot, lowest level first", () => {
    expect(judgeView(body())!.fit.ponder).toEqual([0.1, 0.1, 0.1, 0.5, 0.1, 0.1]);
  });
});

describe("judgeView and the judge agree", () => {
  const run = (author: string, file: string, passed: number, total: number): CrossTest => ({ author, file, passed, total });
  const judged = (agent: string, crossTests?: CrossTest[]) => judgeFork(fakeDeps({ crossTests: async () => crossTests }), fakeInput(), fakeFork(agent));

  it("V7: the grid marks counted exactly the files decide() counted, including a file one fork never ran", async () => {
    const forks = [
      await judged("ponder", [run("base", "test/a.test.ts", 4, 4), run("zippy", "test/z.test.ts", 2, 2), run("ponder", "test/p.test.ts", 3, 3)]),
      await judged("zippy", [run("base", "test/a.test.ts", 4, 4), run("zippy", "test/z.test.ts", 2, 2), run("ponder", "test/p.test.ts", 3, 3)]),
      await judged("snip", [run("base", "test/a.test.ts", 2, 4), run("zippy", "test/z.test.ts", 0, 2)]),
    ];
    const output = decide(fakeInput(), forks);
    expect(output.counted).toEqual([{ author: "base", file: "test/a.test.ts" }, { author: "zippy", file: "test/z.test.ts" }]);
    const counted = judgeView({ output })!.cross!.columns.filter((c) => c.counted).map((c) => `${c.author}:${c.file}`);
    expect(counted).toEqual(["base:test/a.test.ts", "zippy:test/z.test.ts"]);
  });

  it("V8: when no fork has shared results the judge used each fork's own npm test, and the grid counts no file", async () => {
    const forks = [await judged("ponder", undefined), await judged("zippy", undefined)];
    const output = decide(fakeInput(), forks);
    expect(output.counted).toBeUndefined();
    expect(judgeView({ output })!.cross).toBeUndefined();
  });

  it("V10: when a fork's shared run failed, the suite is off and no file shows as counted", async () => {
    const forks = [await judged("ponder", [run("base", "test/a.test.ts", 4, 4)]), await judged("zippy", undefined)];
    const cross = judgeView({ output: decide(fakeInput(), forks) })!.cross!;
    expect(cross.rows.map((r) => r.agent)).toEqual(["ponder"]);
    expect(cross.columns.every((c) => !c.counted)).toBe(true);
  });

  it("V9: the facts the page duplicates match the judge's", () => {
    expect(BASE_AUTHOR).toBe(SERVER_BASE);
    expect(JUDGE_TIE).toBe(SERVER_TIE);
  });
});

describe("judge steps", () => {
  it("V5: forks, fusion and ship wait until they start; look, split and compare show only once they ran", () => {
    const steps = judgeSteps(["ponder", "zippy"], [
      { name: "fork ponder", state: "done", startedAt: "a", endedAt: "b" },
      { name: "fork zippy", state: "running", startedAt: "a" },
      { name: "split", state: "running", startedAt: "c" },
    ]);
    expect(steps.map((s) => [s.name, s.state])).toEqual([
      ["fork ponder", "done"],
      ["fork zippy", "running"],
      ["split", "running"],
      ["fuse", "waiting"],
      ["ship", "waiting"],
    ]);
    expect(steps[0]!.label).toBe("Ponder: tests + Clef");
    expect(steps.map((s) => s.short)).toEqual(["Ponder", "Zippy", "Split?", "Fusion", "Ship"]);
  });

  it("V6: a live judge event updates the task's steps, and a replay plays each step's start and end", () => {
    const task: WireTask = {
      id: "t-1",
      prompt: "p",
      status: "finished",
      createdAt: "2026-10-07T00:00:00.000Z",
      startedAt: "2026-10-07T00:00:01.000Z",
      agents: [{ name: "ponder", status: "done", startedAt: "2026-10-07T00:00:01.000Z", endedAt: "2026-10-07T00:01:00.000Z" }],
      judging: [{ name: "fork ponder", state: "done", startedAt: "2026-10-07T00:01:01.000Z", endedAt: "2026-10-07T00:01:30.000Z" }],
    };
    const board = applyEvent(emptyBoard("t-1"), { kind: "snapshot", taskId: "t-1", task: { ...task, judging: [] } }, 0);
    const next = applyEvent(board, { kind: "judge", taskId: "t-1", step: { name: "fork ponder", state: "running", startedAt: "x" } }, 0);
    expect(next.task?.judging).toEqual([{ name: "fork ponder", state: "running", startedAt: "x" }]);
    const judged = buildTimeline(task, [], { active: [], history: [] }).events.filter((e) => e.event.kind === "judge");
    expect(judged.map((e) => (e.event.kind === "judge" ? e.event.step.state : ""))).toEqual(["running", "done"]);
    const created = buildTimeline(task, [], { active: [], history: [] }).events[0]!.event;
    expect(created.kind === "snapshot" ? created.task?.judging : "x").toBeUndefined();
  });
});
