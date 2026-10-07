import { describe, expect, it } from "vitest";

import { applyEvent, emptyBoard, type WireTask } from "../src/ui/board";
import { judgeSteps, judgeView } from "../src/ui/judgeview";
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
