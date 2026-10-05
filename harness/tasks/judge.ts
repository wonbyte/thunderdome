// The judge build (PLAN.md Day 6). Graph: harness/tasks/judge.md. Built 2026-10-04; kept as a record.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "score.ts",
    owns: ["src/judge/score.ts", "test/score.test.ts"],
    tests: ["test/score.test.ts"],
    required: ["R1", "R2", "R3", "R4"],
    maxAttempts: 4,
    brief:
      "Write src/judge/score.ts: pure scoring, no I/O. Input per fork: agent name, testsPassed, testsTotal, taskFit (0..1), clarity (0..1), linesChanged, filesChanged[], filesClaimed[]. " +
      "Weights (fixed, from PLAN.md): tests 50 (passed/total), task fit 25, clarity 15, claim kept 10 (all changed files are claimed → 10, else 0). Total is 0..100. " +
      "Pick the winner: highest total among forks with testsPassed > 0; a tie goes to fewer linesChanged; no eligible fork means no winner. Return per-fork parts so the why can explain them.",
  },
  {
    id: "N3",
    title: "why.ts",
    owns: ["src/judge/why.ts", "test/why.test.ts"],
    tests: ["test/why.test.ts"],
    required: ["R5"],
    maxAttempts: 4,
    brief:
      "Write src/judge/why.ts: builds the short plain-text 'why' that goes in the merge commit body, from score.ts results. " +
      "Format: the winner on the first line, a scores table (agent, tests, task fit, clarity, claim, total), 3 reasons the winner won (derived from the score parts, not from an LLM), and 1 line per loser. Handle 'no winner'.",
  },
  {
    id: "N4",
    title: "TypeSafe scorer",
    owns: ["src/judge/scorer.ts", "test/scorer.test.ts"],
    tests: ["test/scorer.test.ts"],
    required: ["R8"],
    maxAttempts: 4,
    brief:
      "Write src/judge/scorer.ts: a `Scorer` interface returning taskFit and clarity (0..1, plus the raw TypeSafe answers), and a TypeSafe implementation over its HTTP API with an injected fetch. " +
      "Read harness/context/scorer-notes.md first; it has the decided design and links to the saved TypeSafe docs in harness/context/typesafe/. Also export a fake Scorer for other tests.",
  },
  {
    id: "N5",
    title: "judge + Workflow",
    owns: ["src/judge/judge.ts", "src/judge/JudgeWorkflow.ts", "test/judge.test.ts", "test/judge-fakes.ts", "wrangler.jsonc"],
    tests: ["test/judge.test.ts"],
    required: ["R6", "R7"],
    maxAttempts: 5,
    regenTypes: true,
    brief:
      "Write src/judge/judge.ts: a pure `judgeTask(deps, input)` with injected deps (runTests, getDiff, scorer). Per fork: run its tests (retry 2× with src/retry.ts; still failing → 0 tests passed), get its diff, score it, total it with score.ts, then build the why with why.ts. " +
      "Write src/judge/JudgeWorkflow.ts: a thin WorkflowEntrypoint (cloudflare:workers) that calls judgeTask with real deps, one step.do per fork, returning the result as the Workflow output. Reuse the existing sandbox and Artifacts code for real deps (read src/agents/runner.ts, src/sandbox/*, src/artifacts/repo.ts). It is not unit-tested; keep it small. " +
      "In wrangler.jsonc: add a `workflows` binding JUDGE (class JudgeWorkflow), add JudgeWorkflow to `exports` in the same style as the others, and add TYPESAFE_API_KEY to secrets.required. Code regenerates worker-configuration.d.ts after you write wrangler.jsonc. " +
      "Tests import judge.ts only, with fakes in test/judge-fakes.ts. Saving into TaskRoom is out of scope.",
  },
  {
    id: "N6",
    title: "route + export",
    owns: ["src/index.ts", "src/routes/tasks.ts", "test/judge-route.test.ts"],
    tests: ["test"],
    required: [],
    maxAttempts: 3,
    brief:
      "Export JudgeWorkflow from src/index.ts. Add `POST /tasks/:id/judge` (starts a JUDGE instance for the task's forks) and `GET /tasks/:id/judge` (returns the instance status and output) in src/routes/tasks.ts, following the existing routes' auth and style. " +
      "Add test/judge-route.test.ts with fakes. The check for this step is the full test suite.",
  },
];

export const task: TaskGraph = {
  branch: "harness/judge",
  nodes,
  planTask:
    "Plan Thunderdome's judge (PLAN.md Day 6). Read PLAN.md, docs/api-notes.md, src/retry.ts, src/artifacts/repo.ts, src/agents/runner.ts, src/routes/tasks.ts, src/index.ts, test/fakes.ts, wrangler.jsonc and harness/context/scorer-notes.md, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts", ".gitignore", "package.json", "package-lock.json"],
};
