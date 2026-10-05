// Runner auto-push (PLAN.md Day 9). Graph: harness/tasks/autopush.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "autopush hook",
    owns: ["image/autopush.mjs", "image/autopush.d.mts", "test/autopush.test.ts", "Dockerfile"],
    tests: ["test/autopush.test.ts"],
    required: ["P1", "P2", "P3", "P4", "P5"],
    maxAttempts: 5,
    brief:
      "Write image/autopush.mjs: plain Node ESM with no dependencies, like image/claim.mjs, installed as /usr/local/bin/autopush. It is a Claude Code PostToolUse hook: it reads the hook JSON from stdin (`tool_name`, `tool_input`, `tool_input.command` for Bash) and runs in the repo directory (process.cwd()). " +
      "Export pure helpers so tests can import them: `isTestRun(command)` (true for `npm test`, `npm run test`, `npm t`, `node --test`, `npx vitest`/`vitest`, also inside `&&` chains), `shouldPush({ toolName, command, now, lastPushAt, minIntervalS })` (a test-run Bash command always may push; any other tool only when at least minIntervalS seconds passed since lastPushAt or there was no earlier push), and `commitMessage(agent, files)` (`Thunderdome <agent>: work in progress (<files joined by \", \">)`, clipped to at most 120 characters with an ellipsis). " +
      "main: parse stdin (bad JSON → exit 0); read the state file (env AUTOPUSH_STATE, default /workspace/run/autopush.json, holding `{ lastPushAt }` in ms); if shouldPush says no, exit 0. Otherwise `git add --all`; if anything is staged, commit with commitMessage (agent from GIT_AUTHOR_NAME `Thunderdome <agent>`, else \"agent\"; files from `git diff --cached --name-only`). Then, if HEAD is not on the remote main (`git rev-parse HEAD` vs `git rev-parse origin/main` after the push, or `git status --porcelain=v2 --branch` ahead count; pick one and keep it simple), run `git push origin HEAD:refs/heads/main` with a timeout of 20 s, and on success write the state file with the current time. Interval from env AUTOPUSH_MIN_INTERVAL_S, default 20. " +
      "Every git call uses execFileSync/spawnSync with argv arrays (no shell strings). Every error is caught: the process always exits 0 and prints nothing on stdout (diagnostics, if any, go to stderr). Run main only when the file is executed directly, not when imported. " +
      "Tests (test/autopush.test.ts, vitest): import the helpers from ../image/autopush.mjs for P2 and P4; the tsconfig has no allowJs, so write image/autopush.d.mts declaring the exported helpers; for P1, P3 and P5 run the script with node as a child process in a temp dir holding a bare remote and a clone (git init --bare, clone, a first commit pushed), with GIT_AUTHOR_*/GIT_COMMITTER_* set, AUTOPUSH_STATE pointing into the temp dir, and hook JSON on stdin; then read the bare remote's log. Clean up temp dirs. " +
      "Dockerfile: copy image/autopush.mjs to /usr/local/bin/autopush and chmod 755, next to the claim CLI lines.",
  },
  {
    id: "N3",
    title: "runner wiring",
    owns: ["src/agents/runner.ts", "src/agents/prompt.ts", "test/agents.test.ts", "README.md"],
    tests: ["test"],
    required: ["P6"],
    maxAttempts: 4,
    brief:
      "In src/agents/runner.ts, export the hook path (`/usr/local/bin/autopush`) and a function that returns the Claude Code settings object: `{ hooks: { PostToolUse: [{ matcher: \"Bash|Edit|Write|MultiEdit\", hooks: [{ type: \"command\", command: <hook path> }] }] } }`. agentCommand passes it as `--settings <JSON string>` before the `--` separator, and adds AUTOPUSH_STATE (`/workspace/run/autopush.json`) to the env; keep every other argument and env entry as it is. " +
      "In src/agents/prompt.ts, add one sentence to the push rule: the runner also commits and pushes your work after each test run and as you edit, so every step shows up in the live preview. Keep the existing sentences that test R8 checks (\"after each working step\", the git push command, \"live preview\", \"commit your work\", \"the runner also commits and pushes whatever is left at the end\"). " +
      "Test P6 in test/agents.test.ts: agentCommand's argv has `--settings` followed by JSON that parses to the hook settings (matcher covers Bash and Edit, command is the hook path), placed before `--`; and every agent's system prompt mentions that the runner pushes as they go. " +
      "README: one short note in the race section that the runner pushes agents' work after each test run and edit (at most every 20 s), so previews change during the race. The check for this step is the full test suite.",
  },
];

export const task: TaskGraph = {
  branch: "harness/autopush",
  nodes,
  planTask:
    "Plan Thunderdome's runner auto-push (PLAN.md Day 9): a Claude Code PostToolUse hook in the sandbox that commits and pushes agents' work as they go. " +
    "Read PLAN.md, harness/tasks/autopush.md, src/agents/runner.ts, src/agents/prompt.ts, src/sandbox/ThunderdomeSandbox.ts, image/claim.mjs, Dockerfile, test/agents.test.ts, test/thunderdome-api.test.ts (how claim.mjs is tested as a child process) and README.md, then call submit_plan.",
  extraAllowed: [],
};
