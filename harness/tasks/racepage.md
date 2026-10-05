# Harness graph — live robot race page (PLAN.md Day 8)

Status: **approved 2026-10-05**. The user chose a public read-only live view. They want the UI "visual so we can see them operate in real time … the claude bot robot in different colors and fighting it out". Runner: `node --env-file=.env harness/run.ts racepage`, on branch `harness/racepage`.

## Task

Build the race page for the video. It shows one pixel robot per agent, each in its own color, on a stage. Every animation comes from a real live event. Below the stage are the claim grid, the base ("before") preview next to the agents' previews, and at the end the scoreboard and the judge's "why". The page is `GET /race/:id`. It is static assets on the same Worker, and it is fed by the public read routes and the `GET /tasks/:id/live` WebSocket.

Facts the plan must respect:
- **Auth:** browsers cannot set an Authorization header on a WebSocket, so the read routes go public. These need no auth:
  - `GET /tasks/:id`
  - `GET /tasks/:id/steps`
  - `GET /tasks/:id/claims`
  - `GET /tasks/:id/live`
  - `GET /tasks/:id/judge`
  - `GET /race/:id`
  - the static assets

  Everything else keeps Bearer `ADMIN_TOKEN`: `POST /tasks`, run, claims POST, release, judge POST, `/spike/*` and `/admin/*`. Fork tokens are never in task state or steps: the sandbox's outbound proxy adds them. That is why the reads are safe to make public. A pure `accessFor(method, pathname)` decides the access level, so it can be tested without `cloudflare:workers`.
- **Assets:** wrangler `assets` with directory `./public` and binding `ASSETS`. `GET /race/:id` (a valid task id) is answered by the Worker as `env.ASSETS.fetch` of `/race.html`. The bundle `public/race.js` is built from `src/ui/app.ts` by `scripts/build-ui.mjs` (esbuild, already a devDependency). It is generated and git-ignored, like `src/generated`. Deploy, typecheck and test all build it first.
- **Live events:** the `LiveEvent` union is in `src/room/TaskRoom.ts`, which imports `cloudflare:workers`. The UI must not import it at runtime. `src/ui/board.ts` declares its own wire types, which mirror LiveEvent, Task, ClaimBoard, LoggedStep and the judge's `ScoreResult`. It is pure: no DOM, no Worker globals, no imports outside `src/ui`. A test passes real `LiveEvent` values into it, so the test typecheck catches drift.
- **Typecheck:** `src/ui/app.ts` and `src/ui/sprites.ts` use the DOM. They are checked by a new `tsconfig.ui.json` (lib dom, no workers types) and left out of the Worker tsconfig and the test tsconfig. `board.ts` must typecheck under both.
- **Agents:** names are `careful`, `fast`, `tester`, `lean` and `tidy` (`src/agents/prompt.ts`). Steps have kind `init | text | tool | result | error | claim`. A tool step's text is `<ToolName> <main arg>`, for example `Bash npm test` or `Edit src/cart.js`.
- **Scores:** come from `GET /tasks/:id/judge`, at `output.scores.ranked[]` (agent, parts {tests, taskFit, clarity, claim}, total, eligible). The page fetches it after the `verdict` event.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/racepage`.
2. Every required test (U1–U7) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- U1 `access`: the public reads are public for a valid task id: GET task, steps, claims, live, judge, and GET /race/:id
- U2 `access`: writes, spike and admin routes need admin. POST on any task route, GET /tasks/bad-id/... and unknown paths are not public. GET / stays public.
- U3 `board`: a step maps to the robot action: Read/Grep/Glob → scan, Edit/Write/MultiEdit → hammer, Bash with a test command → charge, other Bash → work, text → think, claim → flag, error → hurt
- U4 `board`: events update the fighters: steps (newest step kept, action set), push (commit count), preview (url), agent-end (done → finished, failed/timeout → down), base-preview
- U5 `board`: a claim clash marks both robots as clashing on that file, and the claim grid marks the file red
- U6 `board`: the verdict crowns the winner (won), the rest lose (lost), and scores rank the fighters with their parts. A null winner crowns nobody.
- U7 `board`: init from a snapshot task, steps and claim board equals replaying the same events one by one, and a real `LiveEvent` from TaskRoom type-checks as a board event

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/racepage`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | U1–U7 assigned to their nodes | 3 attempts |
| N2 | Public reads + page route | `src/routes/access.ts` + test; `src/index.ts` uses it and serves `/race/:id` from ASSETS; `wrangler.jsonc` assets; types regenerated | U1–U2; typecheck | 4 attempts |
| N3 | Board model | `src/ui/board.ts` pure reducer + tests | U3–U7; typecheck | 4 attempts |
| N4 | Thunderdome page | `public/race.html`, `public/race.css`, `src/ui/app.ts`, `src/ui/sprites.ts`, `scripts/build-ui.mjs`, tsconfigs, `package.json` scripts, `.gitignore`, README | full suite | 4 attempts |
| N7 | Review | Opus reviews the diff; F5 filters; F3 code rule; F4 sees the step brief | Max 2 rounds | Open findings in the report |
| N8 | Done check | The 4 checks above | All pass | 2 trips back, then stop |

## Fork questions

- F1 threshold: 3/3
- F2 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

F3 (diff risk) is the code rule in `run.ts`.

## Gates (code waits for you)

| Gate | Before |
|---|---|
| G1 | Pushing `harness/racepage` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying and the live check: a `clash` race watched at `/race/:id` in a browser, with no token, from start to verdict. The robots move on real steps, a clash shows, the previews load, and the winner is crowned with the why. |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20 (the limits in `harness/llm.ts`).
