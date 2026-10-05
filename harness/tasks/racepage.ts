// Live robot race page (PLAN.md Day 8). Graph: harness/tasks/racepage.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "public reads + page route",
    owns: ["src/routes/access.ts", "test/access.test.ts", "src/index.ts", "wrangler.jsonc"],
    tests: ["test/access.test.ts"],
    required: ["U1", "U2"],
    maxAttempts: 4,
    regenTypes: true,
    brief:
      "New pure src/routes/access.ts (no cloudflare:workers import): `export type Access = \"public\" | \"page\" | \"admin\"` and `accessFor(method, pathname): Access`. " +
      "\"public\": GET / and, for a task id that passes isTaskId (src/room/task.ts), GET /tasks/:id, /tasks/:id/steps, /tasks/:id/claims, /tasks/:id/live, /tasks/:id/judge (exact paths, no extra segments). " +
      "\"page\": GET /race/:id with a valid task id. Everything else is \"admin\" (every POST, an invalid id, extra segments, /spike/*, /admin/*, unknown paths). " +
      "src/index.ts: compute accessFor first. For \"page\" return `env.ASSETS.fetch(new URL(\"/race.html\", request.url))` with no auth. For \"public\" skip the auth check. For \"admin\" keep today's flow exactly (the 404 for unknown paths, then the Bearer check). Add `GET /race/:id` to ROUTES (\"The live race page for a task. No auth; the read routes it uses are public too.\"), and mark the public GET routes as \"No auth.\" in their ROUTES text. " +
      "wrangler.jsonc: add `\"assets\": { \"directory\": \"./public\", \"binding\": \"ASSETS\" }` with a short comment (the race page; the Worker answers every path that is not a file in public/). Create the public/ folder only if wrangler types needs it; N4 fills it. " +
      "Tests U1, U2 in test/access.test.ts cover every case listed.",
  },
  {
    id: "N3",
    title: "board model",
    owns: ["src/ui/board.ts", "test/board.test.ts"],
    tests: ["test/board.test.ts"],
    required: ["U3", "U4", "U5", "U6", "U7"],
    maxAttempts: 4,
    brief:
      "New pure src/ui/board.ts: no DOM, no Worker globals, no imports outside src/ui. Declare wire types that mirror the server's: WireTask (id, prompt, status, startedAt?, finishedAt?, agents[{ agent, status, startedAt?, endedAt?, push?: { seen: string[]; preview?: { url, commit, at } }, costUsd? }], verdict?: { winner: string | null; why: string }, basePreview?), WireStep (seq, agent, at, kind, text), WireClaimBoard ({ active, history } of { agent, file, shared, at }), and BoardEvent, a union matching every LiveEvent kind in src/room/TaskRoom.ts (snapshot, status, steps, claim, release, push, preview, agent-end, verdict, base-preview). Keep only the fields the board reads; extra fields must still type-check. " +
      "Export `AGENT_COLORS` (careful #d97757, fast #e5484d, tester #3e8ed0, lean #30a46c, tidy #8e4ec6; any other name gets a fallback grey) and `type Action = \"idle\" | \"think\" | \"scan\" | \"hammer\" | \"charge\" | \"work\" | \"flag\" | \"clash\" | \"push\" | \"hurt\" | \"finished\" | \"down\" | \"won\" | \"lost\"`. " +
      "`actionForStep(step)`: tool steps by the first word: Read/Grep/Glob/LS → scan; Edit/Write/MultiEdit/NotebookEdit → hammer; Bash whose command looks like a test run (test, vitest, jest, pytest, `npm t`) → charge; other Bash or tools → work. text → think, claim → flag, error → hurt, init → idle, result → finished. " +
      "`Fighter` = { agent, color, status, action, actionAt, lastStep?: string, commits: number, preview?: { url, commit, at }, files: string[], clashFile?: string, score?: { total, parts, eligible, place } }. " +
      "`Board` = { taskId, task?: WireTask, fighters: Fighter[] in task agent order, grid: { files: string[] sorted; cells: Record<file, Record<agent, \"own\" | \"shared\">>; clashes: string[] }, basePreview?, winner?: string | null, why?: string, ended: boolean, lastSeq: number }. " +
      "`emptyBoard(taskId)`, `initBoard(task, steps, claims, now)` and `applyEvent(board, event, now)` return new objects (never mutate input). snapshot/status replace task and resync fighters from it. steps: newest step text (clipped to 120 chars) and actionForStep. claim: files added to the grid. A clash marks every holder's clashFile and action clash, and adds the file to grid.clashes (a file is a clash when 2+ agents hold it). release: remove the cells. push: commits = count of distinct pushed commits, action push. preview: set preview. agent-end: done → finished, failed/timeout → down. verdict: winner won, the others lost (when the winner is null, everyone gets finished or down by status), ended true. base-preview: set basePreview. " +
      "`applyScores(board, ranked)`: ranked is the judge's ScoreResult.ranked (agent, parts { tests, taskFit, clarity, claim }, total, eligible); place = index + 1. " +
      "Tests U3–U7 in test/board.test.ts. U7 imports `type LiveEvent` from src/room/TaskRoom.ts (type-only, so no runtime import) and builds real LiveEvent values with the server's types, passing them to applyEvent so the test typecheck catches drift. It also checks that initBoard equals replaying snapshot + steps + claim events.",
  },
  {
    id: "N4",
    title: "race page",
    owns: [
      "public/race.html",
      "public/race.css",
      "src/ui/app.ts",
      "src/ui/sprites.ts",
      "scripts/build-ui.mjs",
      "tsconfig.json",
      "tsconfig.ui.json",
      "test/tsconfig.json",
      "package.json",
      ".gitignore",
      "README.md",
    ],
    tests: ["test"],
    required: [],
    maxAttempts: 4,
    brief:
      "Build: scripts/build-ui.mjs bundles src/ui/app.ts with esbuild's JS API (already a devDependency) into public/race.js (esm, minify, target es2022). Add `public/race.js` to .gitignore. package.json: add a `build:ui` script; deploy, typecheck and test run it right after build:sample, and typecheck also runs `tsc --noEmit -p tsconfig.ui.json`. tsconfig.ui.json: lib esnext + dom, types [], strict, includes src/ui only. tsconfig.json and test/tsconfig.json exclude src/ui/app.ts and src/ui/sprites.ts (board.ts stays in both). " +
      "src/ui/sprites.ts: an original chunky pixel robot drawn as an SVG string from a 16x16 grid of rects (shape-rendering crispEdges), colored by the agent color with a darker shade for outlines. Arms, eyes and an antenna are separate groups, so CSS can animate them. Keep all sprite art in this one file so it can be swapped later. It must not copy any brand mascot. " +
      "public/race.html + race.css: dark race page, no external scripts or fonts. Layout: header (task prompt, status, race timer). A stage with a floor and the repo core in the center, and one robot per agent spaced along the floor, each with a name tag in its color, a commit counter and a speech bubble showing lastStep. Under the stage: the claim grid (files x agents, own = filled in the agent color, shared = outline, clash rows red), the previews row (base \"before\" first, then one per agent; an iframe with a link fallback, reloaded when a new preview commit arrives), and the result panel (ranked scoreboard with stacked bars per score part, plus the why). Works from 1280 px down to phone width, with no horizontal page scroll. " +
      "Animations are CSS classes per Action, re-triggered when actionAt changes: think bob, scan eye glow, hammer arm swing toward the core, charge sparkle, work small shake, flag a small flag pops up, clash lunge toward the other clasher with sparks and the file name, push a bolt flies from the robot to the core, hurt a red flash, finished idle stand, down fall over and grey out, won jump with a crown and confetti, lost slump. Respect prefers-reduced-motion (no movement; the color/label changes only). An aria-live log lists the last steps as text. " +
      "src/ui/app.ts: read the task id from the path /race/:id. Fetch GET /tasks/:id, /steps?after=0 (page until next stops changing) and /claims, then initBoard. Open the WebSocket at ws(s)://<host>/tasks/:id/live and applyEvent on each message (skip steps with seq <= board.lastSeq). On close, reconnect with backoff up to 10 s, then refetch and initBoard. On the verdict event (or a snapshot that already has a verdict), fetch GET /tasks/:id/judge and applyScores from output.scores.ranked when it is there. Render with plain DOM updates on each board change (no framework); create a robot's SVG once and only toggle classes after that. Tick the timer each second from task.startedAt to finishedAt or now. A missing or bad task id shows a short message. " +
      "README: a short \"Watch a race\" section: open https://<worker>/race/<taskId> (no token needed; the read routes are public and writes stay behind ADMIN_TOKEN), and what the robots' moves mean. The check for this step is the full test suite plus typecheck.",
  },
];

export const task: TaskGraph = {
  branch: "harness/racepage",
  nodes,
  planTask:
    "Plan Thunderdome's live robot race page (PLAN.md Day 8). " +
    "Read harness/tasks/racepage.md, src/index.ts, src/routes/tasks.ts, src/room/TaskRoom.ts (LiveEvent), src/room/task.ts (Task, LoggedStep, isTaskId), src/room/claims.ts, src/judge/score.ts (ScoreResult), src/agents/prompt.ts (AGENT_NAMES), wrangler.jsonc, package.json, tsconfig.json, test/tsconfig.json and the README, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts"],
};
