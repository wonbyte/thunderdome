// Race index and gallery routes (replay and gallery, server side). Graph: harness/tasks/gallery.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "pure core",
    owns: ["src/room/races.ts", "test/races.test.ts", "src/routes/access.ts", "test/access.test.ts"],
    tests: ["test/races.test.ts", "test/access.test.ts"],
    required: ["L1", "L2", "L3", "L6"],
    maxAttempts: 4,
    brief:
      "New pure src/room/races.ts (no cloudflare:workers import; type-only imports from ./task and ./claims are fine): `RaceSummary` = { id, prompt, template?, status: TaskStatus, createdAt, startedAt?, finishedAt?, agents: string[], winner?: string | null, clash: boolean }. " +
      "`summaryOf(task: Task, history: Claim[]): RaceSummary`: copies the fields that are set (omit undefined optional fields), agents = task.agents names in order, winner = task.verdict.winner only when task.verdict exists, clash = some file in history was claimed by 2+ different agents. " +
      "`upsertRace(list, summary, max = 200)`: a new array with any entry of the same id replaced, sorted by createdAt descending (ties keep the newer entry first), capped at max; the input array and its items are never mutated. Export `RACE_INDEX_MAX = 200` and `RACE_LIST_LIMIT = 50`. " +
      "src/routes/access.ts: accessFor also returns \"public\" for GET /tasks (exactly) and \"page\" for GET /races (exactly); every existing rule stays. Add pure `pageAsset(pathname): string | undefined`: \"/race.html\" for /race/:id with a valid task id, \"/races.html\" for /races, else undefined. " +
      "Tests L1, L2 in test/races.test.ts. L3 and L6 in test/access.test.ts. L6 re-asserts the existing public and admin cases; keep the U1 and U2 tests unchanged.",
  },
  {
    id: "N3",
    title: "index + wiring",
    owns: [
      "src/room/RaceIndex.ts",
      "src/room/TaskRoom.ts",
      "src/index.ts",
      "src/routes/tasks.ts",
      "test/tasks-route.test.ts",
      "wrangler.jsonc",
      "README.md",
    ],
    tests: ["test"],
    required: ["L4", "L5"],
    maxAttempts: 4,
    regenTypes: true,
    brief:
      "New src/room/RaceIndex.ts: `export class RaceIndex extends DurableObject<Env>` with `record(summary: RaceSummary): void` (reads the list from ctx.storage.kv key \"races\", applies upsertRace, writes it back) and `list(limit = RACE_LIST_LIMIT): RaceSummary[]`. Export it from src/index.ts. wrangler.jsonc: add binding `{ \"name\": \"RACE_INDEX\", \"class_name\": \"RaceIndex\" }` to durable_objects.bindings, with a one-line comment (one instance, \"all\": the race list for GET /tasks and the gallery). No migrations block (the repo has none). " +
      "TaskRoom: a private `#index(task)` that does `this.env.RACE_INDEX.getByName(\"all\").record(summaryOf(task, board.history))` (board = this.claimBoard()) inside try/catch that only logs console.error({ event: \"race_index.record_failed\", taskId, error: String(error) }), awaited but never thrown. Call it after create succeeds, after run starts (the task saved as running), when the task becomes finished, and after the verdict is saved. " +
      "src/routes/tasks.ts: handleTasks takes env with TASK_ROOM and RACE_INDEX. GET /tasks returns `{ races: await env.RACE_INDEX.getByName(\"all\").list(RACE_LIST_LIMIT) }`; POST /tasks unchanged; other methods 405 with allow \"GET, POST\". Export `handleRaceBackfill(request, env)`: body `{ ids }` must be an array of 1..50 strings that pass isTaskId, else 400. For each id, read the room's state(); null means missing. Otherwise record summaryOf(state, (await room.claimBoard()).history). Return `{ recorded: string[], missing: string[] }`. " +
      "src/index.ts: use pageAsset (src/routes/access.ts): when accessFor is \"page\", serve `env.ASSETS.fetch(new URL(pageAsset(path), request.url))`. Add ROUTES entries for \"GET /tasks\" (\"The race list, newest first (at most 50). No auth.\"), \"GET /races\" (\"The race gallery page. No auth.\") and \"POST /admin/races\" (\"Add races from before the index: { ids }.\"), and route POST /admin/races to handleRaceBackfill after the admin check. " +
      "test/tasks-route.test.ts: L4 and L5 with a fake RACE_INDEX ({ getByName: () => ({ list, record }) }) and fake rooms. Update the existing tests' env objects for the new binding. " +
      "README: in the API section, add GET /tasks (race list, public), the /races gallery page, and POST /admin/races (backfill).",
  },
];

export const task: TaskGraph = {
  branch: "harness/gallery",
  nodes,
  planTask:
    "Plan Thunderdome's race index: a RaceIndex Durable Object, the public GET /tasks list, the /races page route and a backfill route. " +
    "Read harness/tasks/gallery.md, src/room/task.ts (Task, TaskStatus), src/room/claims.ts (Claim, ClaimBoard), src/room/TaskRoom.ts, src/routes/tasks.ts, src/routes/access.ts, src/index.ts, test/tasks-route.test.ts, test/access.test.ts, wrangler.jsonc and the README API section, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts"],
};
