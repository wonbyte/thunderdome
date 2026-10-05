// Ship the winner (PLAN.md Day 7). Graph: harness/tasks/ship.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "per-repo git tokens",
    owns: ["src/sandbox/policy.ts", "test/policy.test.ts"],
    tests: ["test/policy.test.ts"],
    required: ["R1"],
    maxAttempts: 4,
    brief:
      "A sandbox's outbound proxy holds one git token (OutboundProps.gitToken), but merging needs two repos on the same git host: read the winner fork, push to the source repo. " +
      "Add optional per-repo tokens to OutboundProps (keyed by the repo path on the git host, e.g. the `<namespace>/<repo>` part of `/git/<namespace>/<repo>.git/...`). " +
      "In decideOutbound, a request to the git host uses the token for its own repo when one is given, otherwise gitToken. A repo-path token must never be sent for a different repo, and a path that is not a repo path gets only gitToken. " +
      "Keep existing behavior and tests unchanged for props without per-repo tokens. Keep the Thunderdome API path check (isThunderdomeApi) as it is.",
  },
  {
    id: "N3",
    title: "ship core",
    owns: ["src/ship/ship.ts", "test/ship.test.ts"],
    tests: ["test/ship.test.ts"],
    required: ["R2", "R3", "R4", "R5"],
    maxAttempts: 4,
    brief:
      "Write src/ship/ship.ts, pure with injected deps (no cloudflare:workers import): `shipTask(deps, input)`. Input: task id, task prompt, the source repo (name, remote, default branch), every fork (agent, name, remote, default branch), the judge's winner (agent or null) and why. " +
      "Deps: run a git argv in a sandbox clone of the source repo (returns exit code, stdout, stderr), and revoke a repo's write tokens (returns the count). " +
      "With a winner: fetch the winner fork's default branch, merge it with --no-ff into the source's default branch with the merge message, and push. A merge that fails is aborted (git merge --abort), nothing is pushed, and the result says \"conflict\" with the git output. " +
      "Without a winner: no git at all. In every case, after the merge attempt, revoke the write tokens of every fork, the winner's too, so all forks stay as read-only records; one failed revoke must not stop the others, and is reported. " +
      "Export `mergeMessage(taskId, prompt, winner, why)`: a title line like `Thunderdome: ship <agent>'s fork for task <id>`, a blank line, then the why exactly. " +
      "Return a ShipResult: status (\"merged\" | \"conflict\" | \"no-winner\" | \"error\"), the merge commit hash when merged, and per-fork revoke counts or errors. It must be JSON-serializable.",
  },
  {
    id: "N4",
    title: "verdict + auto-judge",
    owns: ["src/room/task.ts", "src/room/TaskRoom.ts", "src/judge/JudgeWorkflow.ts", "src/sandbox/ThunderdomeSandbox.ts", "test/task.test.ts"],
    tests: ["test/task.test.ts"],
    required: ["R6", "R7"],
    maxAttempts: 5,
    brief:
      "Save the outcome in the task and remove the manual steps. In src/room/task.ts (pure, unit tested): add an optional verdict to Task (winner, why, judgedAt, and the ShipResult from src/ship/ship.ts), a pure function that saves a verdict once and refuses a second one, " +
      "and a pure way to tell that a task has just become finished so the room starts exactly one judge run (applyOutcome and applyStarts are where a task finishes). " +
      "In TaskRoom: when a task becomes finished, create the JUDGE Workflow instance with the same id and params the manual route uses (judgeInstanceId and judgeInput; judgeInput is in src/routes/tasks.ts today, so import it or move it into src/room/task.ts if that avoids a cycle, and keep its export where tests import it from); a JUDGE create that fails because the instance exists is fine. Add a method that saves the verdict. " +
      "In JudgeWorkflow: after decide, a `ship` step runs shipTask with real deps: an ThunderdomeSandbox clone of the source repo whose outbound props carry a short-lived write token for the source and a read token for the winner fork (per-repo tokens from src/sandbox/policy.ts), and revokeWriteTokens from src/artifacts/repo.ts. Then a step saves the verdict in the TaskRoom. The Workflow output stays the judge result plus the ship result. " +
      "Add a small ThunderdomeSandbox method only if the existing clone/exec/stop are not enough. Stop the sandbox when done.",
  },
  {
    id: "N5",
    title: "routes + docs",
    owns: ["src/routes/tasks.ts", "src/index.ts", "test/tasks-route.test.ts", "test/judge-route.test.ts", "README.md"],
    tests: ["test"],
    required: [],
    maxAttempts: 3,
    brief:
      "GET /tasks/:id returns the verdict once it exists. POST /tasks/:id/judge still works for a finished task whose judge has not started, and still answers 409 when one exists (the room now starts it automatically). " +
      "Update the route list in src/index.ts. In README.md, update the run steps: after `POST /tasks/:id/run`, the judge and the merge happen on their own; show how to read the verdict and the merged commit. The check for this step is the full test suite.",
  },
];

export const task: TaskGraph = {
  branch: "harness/ship",
  nodes,
  planTask:
    "Plan Thunderdome's ship step (PLAN.md Day 7): judge automatically, merge the winner into the source repo with the why as the commit body, and lock every fork. " +
    "Read PLAN.md, docs/api-notes.md, harness/tasks/ship.md, src/artifacts/repo.ts, src/sandbox/policy.ts, src/sandbox/outbound.ts, src/sandbox/ThunderdomeSandbox.ts, src/room/task.ts, src/room/TaskRoom.ts, " +
    "src/judge/judge.ts, src/judge/JudgeWorkflow.ts, src/routes/tasks.ts, src/index.ts, test/fakes.ts, test/policy.test.ts and test/task.test.ts, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts"],
};
