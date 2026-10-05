// Server side of the git graph, fork diffs, leaderboard and run-your-own-race. Graph: harness/tasks/levelup.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "pure core",
    owns: [
      "src/room/task.ts",
      "test/task.test.ts",
      "src/judge/why.ts",
      "test/why.test.ts",
      "src/room/races.ts",
      "test/races.test.ts",
      "src/judge/diffs.ts",
      "test/diffs.test.ts",
      "src/play/play.ts",
      "test/play.test.ts",
      "src/routes/access.ts",
      "test/access.test.ts",
    ],
    tests: ["test"],
    required: ["X1", "X2", "X3", "X4", "X5", "X6", "X7"],
    maxAttempts: 4,
    brief:
      "Follow the facts in harness/tasks/levelup.md exactly; all files here are pure (no cloudflare:workers import). " +
      "task.ts: export PushLogEntry, add optional `log` to PushState, and append in applyPush (capped at MAX_SEEN_PUSHES, newest kept; a duplicate push changes nothing). Export VerdictScore and add optional scores and decidedBy to Verdict. " +
      "why.ts: export `type DecidedBy = \"code\" | \"claims\" | \"close\"` and `decidedBy(result)`. Share the case logic with headline so they cannot drift, and keep headline and buildWhy output byte-for-byte the same. task.ts imports DecidedBy type-only. " +
      "races.ts: optional scores ({ agent, total } in ranked order) and decidedBy on RaceSummary, copied only when the verdict has them. " +
      "New src/judge/diffs.ts (clipDiff, MAX_SAVED_DIFF, SavedDiff) and new src/play/play.ts (PLAY_* constants, parsePlay, QuotaState, takeQuota, quotaView, utcDay, playDailyLimit). " +
      "access.ts: the new public, page and pageAsset rules; every existing rule stays. " +
      "Tests X1 in test/task.test.ts, X2 in test/why.test.ts, X3 in test/races.test.ts, X4 in new test/diffs.test.ts, X5 and X6 in new test/play.test.ts, X7 in test/access.test.ts, as new `it` blocks whose titles start with the id. Keep every existing test unchanged and passing.",
  },
  {
    id: "N3",
    title: "wiring",
    owns: [
      "src/room/TaskRoom.ts",
      "src/judge/JudgeWorkflow.ts",
      "src/routes/tasks.ts",
      "src/routes/play.ts",
      "src/play/PlayQuota.ts",
      "src/index.ts",
      "wrangler.jsonc",
      "test/tasks-route.test.ts",
      "test/play-route.test.ts",
      "test/fakes.ts",
      "README.md",
    ],
    tests: ["test"],
    required: ["X8", "X9"],
    maxAttempts: 4,
    regenTypes: true,
    brief:
      "Follow the facts in harness/tasks/levelup.md exactly. " +
      "TaskRoom: `saveDiff(agent, saved)` (kv key `diff:<agent>`, only for the task's agents) and `forkDiff(agent)`. " +
      "JudgeWorkflow: sandboxDeps takes the task id; getDiff saves clipDiff(diff) best effort (catch, console.error event judge.diff_save_failed, never throw) and returns the diff as before. The save-verdict step adds scores (agent, total, eligible, parts from result.scores.ranked) and decidedBy (omitted when undefined). " +
      "src/routes/tasks.ts: GET /tasks/:id/forks/:agent/diff (agent must match /^[a-z]+$/), 404 when forkDiff is null, other methods 405. Every existing route stays. " +
      "New src/play/PlayQuota.ts: `export class PlayQuota extends DurableObject<Env>` with take and view over kv key \"quota\"; export it from src/index.ts. " +
      "New src/routes/play.ts: `handlePlay(request, env)` for POST /play and GET /play/quota, using src/play/play.ts and env PLAY_QUOTA (instance \"daily\"), TASK_ROOM, PLAY_INVITE, PLAY_DAILY_LIMIT. POST creates then runs the task; never return tokens. " +
      "src/index.ts: ROUTES entries and routing for POST /play, GET /play/quota, GET /play (page, served by pageAsset) and GET /tasks/:id/forks/:agent/diff. " +
      "wrangler.jsonc: PLAY_QUOTA binding with a one-line comment, PlayQuota in exports (durable-object, sqlite), vars PLAY_DAILY_LIMIT \"10\" and PLAY_INVITE \"\" with a comment that it is set at deploy with --var. No migrations block. " +
      "Tests: X8 in test/tasks-route.test.ts, X9 in new test/play-route.test.ts with fake PLAY_QUOTA and TASK_ROOM. Update existing tests' env objects only as the types require. " +
      "README API section: the diff route, POST /play, GET /play/quota and the /play page, plus PLAY_DAILY_LIMIT and PLAY_INVITE.",
  },
];

export const task: TaskGraph = {
  branch: "harness/levelup",
  nodes,
  planTask:
    "Plan the server side of four Thunderdome page features: a timed push log, saved fork diffs, scores in the race list, and a public run-your-own-race route with a daily quota. " +
    "Read harness/tasks/levelup.md, src/room/task.ts, src/judge/why.ts, src/judge/score.ts, src/room/races.ts, src/routes/access.ts, src/routes/tasks.ts, src/room/TaskRoom.ts, src/room/RaceIndex.ts, src/judge/JudgeWorkflow.ts, src/index.ts, wrangler.jsonc, test/tasks-route.test.ts, test/access.test.ts and the README API section, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts"],
};
