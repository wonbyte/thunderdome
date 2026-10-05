// The why says what decided the race. Graph: harness/tasks/tiewhy.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "headline",
    owns: ["src/judge/why.ts", "test/why.test.ts"],
    tests: ["test"],
    required: ["W1", "W2", "W3", "W4"],
    maxAttempts: 4,
    brief:
      "In src/judge/why.ts (pure): export `CODE_TIE = 1` and `headline(result: ScoreResult): string | undefined`, following the five cases in harness/tasks/tiewhy.md exactly (wording, order, the claimed-first rule, the even-though clause, 2-decimal numbers without trailing zeros). " +
      "Code points = parts.tests + parts.taskFit + parts.clarity. The runner-up is the first eligible fork in result.ranked that is not the winner. " +
      "buildWhy: when headline(result) is defined, push \"\" and the headline right after the scores table and before the `Why <winner> won:` section. Change nothing else in the output. " +
      "Tests W1–W4 go in test/why.test.ts as new `it` blocks whose titles start with the id. Build ForkInputs with the file's existing fork() helper and scoreForks. Keep every existing test unchanged and passing.",
  },
];

export const task: TaskGraph = {
  branch: "harness/tiewhy",
  nodes,
  planTask:
    "Plan a one-line headline in the judge's why that names what decided the race. " +
    "Read harness/tasks/tiewhy.md, src/judge/why.ts, src/judge/score.ts (ForkScore, ScoreResult, WEIGHTS) and test/why.test.ts, then call submit_plan.",
  extraAllowed: [],
};
