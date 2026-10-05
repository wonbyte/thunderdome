# Harness graph — git graph data, fork diffs, leaderboard data, run your own race

Status: **approved 2026-10-05**. The user said "all 4". Runner: `node --env-file=.env harness/run.ts levelup`, on branch `harness/levelup`. This graph builds only the server side. The page parts (git graph, diff viewer, leaderboard, play form) are page code, built directly on a UI branch.

## Task

Four page features need server data:

1. **Git graph:** each fork's pushes, with times, in order.
2. **Fork diffs:** the diff the judge scored for each fork, readable without auth.
3. **Leaderboard:** each finished race's scores and what decided it, in the race list.
4. **Run your own race:** a public `POST /play` that starts a 3-agent race on a demo template. A daily quota guards it, and an invite code too when one is set.

Facts the plan must respect:

- **Push log (`src/room/task.ts`):**
  - `PushState` gains `log?: PushLogEntry[]`, where `PushLogEntry = { at: string; commit: string; commits: number; message?: string }`. The list is oldest first and capped at `MAX_SEEN_PUSHES`, keeping the newest.
  - `applyPush` appends one entry per recorded push: `at` = now, `commit` = push.after, `commits` = the counted commits, and `message` only when the push has one.
  - It is optional because tasks stored before it have none. A missing log counts as empty.
  - A duplicate push (already seen) still changes nothing.
- **Verdict scores (`src/room/task.ts`, `src/judge/why.ts`):**
  - `Verdict` gains optional `scores?: VerdictScore[]`, where `VerdictScore = { agent; total; eligible; parts: { tests; taskFit; clarity; claim } }`, in ranked order.
  - It also gains optional `decidedBy?: DecidedBy`, where `DecidedBy = "code" | "claims" | "close"`.
  - `why.ts` exports `decidedBy(result: ScoreResult): DecidedBy | undefined`, which follows `headline`'s cases exactly:
    - "code" when headline says "Decided by code",
    - "claims" for both claims cases,
    - "close" for the close margin,
    - undefined when headline is undefined.
  - `headline` and `buildWhy` output stay byte-for-byte the same.
- **Race summary (`src/room/races.ts`):** `RaceSummary` gains optional `scores?: { agent: string; total: number }[]` (ranked order) and `decidedBy?: DecidedBy`. Both are copied from the verdict only when it has them.
- **Diff clipping (new pure `src/judge/diffs.ts`):**
  - `MAX_SAVED_DIFF = 200_000` (characters).
  - `clipDiff(diff: string, max = MAX_SAVED_DIFF): SavedDiff`, where `SavedDiff = { diff: string; clipped: boolean }`.
  - When the diff is too long, it is cut at the last newline at or before max (or at max when there is no newline), and clipped is true.
- **Play input and quota (new pure `src/play/play.ts`, no cloudflare:workers import):**
  - `PLAY_TEMPLATES = ["thunderdome-bugs", "thunderdome-ui", "thunderdome-clash"]`, `PLAY_PROMPT_MIN = 10`, `PLAY_PROMPT_MAX = 600`, `PLAY_AGENTS = 3`, `PLAY_PER_IP = 2`.
  - `parsePlay(body: unknown, invite: string): { template: string; prompt: string } | { error: string; status: 400 | 403 }`:
    - the body must be an object with template in PLAY_TEMPLATES and a prompt string whose trimmed length is within min..max (400 otherwise),
    - when invite is non-empty, `body.invite` must equal it (403 otherwise),
    - the returned prompt is trimmed.
  - `QuotaState = { day: string; used: number; byIp: Record<string, number> }`.
  - `takeQuota(state: QuotaState | undefined, day: string, ip: string, daily: number, perIp = PLAY_PER_IP)` returns `{ ok: true; state; remaining } | { ok: false; reason: "daily" | "ip"; state }`:
    - a state from another day (or undefined) starts fresh: `{ day, used: 0, byIp: {} }`,
    - the daily limit is checked before the IP limit,
    - on ok, used and byIp[ip] go up by 1 and remaining = daily − used,
    - the input state is never mutated.
  - `quotaView(state, day, daily) = { day, used, limit: daily, remaining }`, with used 0 for another day. remaining is never below 0.
  - `utcDay(now: Date): string` returns "YYYY-MM-DD".
  - `playDailyLimit(value: string | undefined): number`: a positive integer string becomes that number, anything else 10.
- **Access (`src/routes/access.ts`):**
  - `GET /tasks/:id/forks/:agent/diff` is public when the id is valid and agent is a non-empty name of `[a-z]+`.
  - `POST /play` and `GET /play/quota` are public.
  - `GET /play` is page, and `pageAsset("/play")` is `"/play.html"`.
  - Every other method/path rule stays as it is.
- **Saving diffs (wiring):**
  - TaskRoom gains `saveDiff(agent: string, saved: SavedDiff): Promise<boolean>`. It stores the diff in `ctx.storage.kv` under `diff:<agent>`, only for an agent of the task; it returns false otherwise.
  - TaskRoom also gains `forkDiff(agent): Promise<SavedDiff | null>`.
  - In `JudgeWorkflow`'s `sandboxDeps`, getDiff saves `clipDiff(diff)` for the fork's agent through `env.TASK_ROOM.getByName(taskId).saveDiff`. This is best effort: a failure is only logged with `console.error({ event: "judge.diff_save_failed", ... })`, and the judge goes on.
  - The verdict saved by the "save verdict" step adds `scores` (from `result.scores.ranked`) and `decidedBy: decidedBy(result.scores)`. Omit decidedBy when it is undefined.
- **Diff route:** `GET /tasks/:id/forks/:agent/diff` returns `{ agent, diff, clipped }`, or 404 `{ error: "not found" }` when there is no saved diff.
- **Play:**
  - New Durable Object class `PlayQuota` (binding `PLAY_QUOTA`, one instance named `"daily"`, sqlite in `exports` like `RaceIndex`). It has:
    - `take(day, ip, daily)`, which applies takeQuota to kv key `"quota"` and saves the new state only on ok,
    - `view(day, daily)`.
  - wrangler vars gain `PLAY_DAILY_LIMIT: "10"` and `PLAY_INVITE: ""` (empty means no invite code; set it at deploy with `--var`).
  - New `src/routes/play.ts`:
    - `POST /play` runs parsePlay with env.PLAY_INVITE, then takes the quota (ip = `CF-Connecting-IP` header, or `"unknown"`); when the quota is used up it returns 429 `{ error, reason }`.
    - It then creates the task (`{ id: newTaskId(), template, prompt, agents: PLAY_AGENTS }` on its TaskRoom) and runs it.
    - It returns 202 `{ id, page: "/race/<id>", remaining }`.
    - A failed create or run returns that result's status and error. The quota stays used.
    - The fork write tokens are never returned.
  - `GET /play/quota` returns `quotaView` plus `invite: boolean` (true when an invite code is set).
  - `src/index.ts` adds ROUTES entries for `POST /play`, `GET /play/quota`, `GET /play` and `GET /tasks/:id/forks/:agent/diff`, and routes them.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/levelup`.
2. Every required test (X1–X9) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- X1 `task`: applyPush appends a timed log entry per new push (with message only when given), caps it at MAX_SEEN_PUSHES, and ignores a duplicate
- X2 `why`: decidedBy gives code, claims (both cases), close and undefined in step with headline
- X3 `races`: summaryOf copies scores (agent and total, ranked order) and decidedBy only when the verdict has them
- X4 `diffs`: clipDiff keeps a short diff, cuts a long one at the last newline at or before max, and cuts at max with no newline
- X5 `play`: parsePlay accepts a demo template and trims the prompt; rejects other templates, short/long prompts and non-objects with 400; and a wrong or missing invite with 403 only when an invite is set
- X6 `play`: takeQuota counts per day and per IP, resets on a new day, says daily before ip, and never mutates its input; quotaView and playDailyLimit
- X7 `access`: the diff route, POST /play and GET /play/quota are public; GET /play is page with pageAsset "/play.html"; POST to other paths is still admin; a bad agent name in the diff path is admin
- X8 `tasks route`: GET /tasks/:id/forks/:agent/diff returns the saved diff and 404 without one
- X9 `play route`: POST /play creates and runs a 3-agent task and returns 202 without tokens; 429 when the quota is used up; 400/403 from parsePlay; GET /play/quota returns the view and the invite flag

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/levelup`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | X1–X9 assigned | 3 attempts |
| N2 | Pure core | push log, decidedBy, summary fields, diffs.ts, play.ts, access rules + tests | X1–X7; typecheck | 4 attempts |
| N3 | Wiring | TaskRoom diff store, JudgeWorkflow save, diff route, PlayQuota DO, play routes, index.ts, wrangler, types, README | X8–X9; full suite | 4 attempts |
| N7 | Review | Opus reviews the diff; F5 filters; F3 code rule; F4 sees the step brief | Max 2 rounds | Open findings in the report |
| N8 | Done check | The 4 checks above | All pass | 2 trips back, then stop |

## Fork questions

- F1 threshold: 3/3
- F2 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

## Gates (code waits for you)

| Gate | Before |
|---|---|
| G1 | Pushing `harness/levelup` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying and the live check: a new race shows push log entries, its forks' diffs load, the race list carries scores and decidedBy, and `POST /play` starts a race until the quota says 429 |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20 (the limits in `harness/llm.ts`).
