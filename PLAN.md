# Thunderdome — Build Plan

Agents compete on one task. The judge picks the best change. The winner ships.

- Deadline: **Oct 14, 2026** (send on Oct 13 if possible).
- Must send: 5–10 min video, open source code (MIT), run steps.
- Needs: Workers Paid plan. Artifacts billing starts Oct 15.

## 1. What we build

1. A user gives one task (text + a source repo).
2. Thunderdome forks the repo N times (N = 3..5). One fork per agent.
3. All agents run at the same time, each in its own sandbox.
4. Before an agent edits, it writes a **claim** (the files it will change) to the claim board.
5. Each push to a fork sends a push event (`cf.artifacts.repo.pushed`) to a Workflow. It updates the scoreboard and makes a Workers Preview URL.
6. When all agents finish (or time runs out), the **judge** scores each fork and writes the "why".
7. The winner merges into the main repo. The "why" goes in the merge commit message. The other forks become read-only, as a record.

## 2. Architecture

```
Browser UI ──HTTP/WebSocket──► api Worker ──► TaskRoom (Durable Object, 1 per task)
                                   │              ├─ claim board
                                   │              ├─ scoreboard
                                   │              └─ live events to UI (WebSocket)
                                   │
                                   ├─ ARTIFACTS binding: fork / token / merge / delete
                                   ├─ Sandbox: 1 container per agent (clone, edit, test, push)
                                   │
push events ──► PushWorkflow (thunderdome-push) ──► TaskRoom.onPush()
                                              └─ Preview URL per fork
all agents done ──► JudgeWorkflow (Workflow, retryable steps)
                     1. run tests per fork   2. read diffs
                     3. score (LLM + tests)  4. write "why"
                     5. merge winner         6. lock losers
```

### Score formula (fixed, so it is fair and easy to show on video)

| Part | Weight | Source |
|---|---|---|
| Tests pass | 50 | test runner: passed / total |
| Task fit | 25 | LLM judge, reads task + diff |
| Diff size / clarity | 15 | LLM judge + lines changed |
| Claim kept | 10 | files changed ⊆ files claimed |

A fork with 0 passing tests cannot win.

## 3. Repo layout

```
thunderdome/
  LICENSE                      MIT
  README.md                    run steps
  PLAN.md                      this file
  package.json                 pnpm workspace
  wrangler.jsonc               bindings: ARTIFACTS, TASK_ROOM, PUSH_FLOW, JUDGE, SANDBOX, AI
  src/
    index.ts                   api Worker: routes
    routes/tasks.ts            POST /tasks, GET /tasks/:id, GET /tasks/:id/ws
    room/TaskRoom.ts           Durable Object: claims, scores, WebSocket fan-out
    room/claims.ts             claim rules (overlap check)
    artifacts/repo.ts          wrapper on ARTIFACTS binding (fork, token, merge, lock)
    agents/runner.ts           start 1 agent in 1 sandbox
    agents/prompt.ts           agent system prompt (claim first, then edit, test, push)
    push/PushWorkflow.ts       push event → TaskRoom + preview
    judge/JudgeWorkflow.ts     the judge Workflow
    judge/score.ts             score formula (pure, unit tested)
    judge/why.ts               "why" text for the merge commit
  ui/                          small static app (Vite + vanilla TS or Preact)
    index.html                 race board, scores, previews, claim board
  demo/
    sample-app/                small Workers app with tests (the repo agents edit)
    tasks/*.md                 3 demo tasks
  test/                        vitest + @cloudflare/vitest-pool-workers
```

## 4. Day by day

Each day has a **done check**. Do not start the next day until the check passes (unless it is blocked; then write the blocker and go on).

### Day 1 — Oct 4: Prove the parts work
- [x] Workers Paid plan on. Artifacts enabled. *(you)*
- [x] Read the API types: Artifacts binding, push events, Sandbox SDK → `docs/api-notes.md`.
- [x] Project setup, MIT `LICENSE`, `README.md`.
- [x] `demo/sample-app` (small Worker, 7 tests, 2 fail on purpose).
- [x] Spike code: `POST /spike/day1` seeds, forks, pushes from a sandbox, reads the commit back.
- [x] Deploy and run `POST /spike/day1` on the real account. *(you)* Passed Oct 4: fork `spike-mutei76f`, commit `7ea60c52`.
- **Done check:** `POST /spike/day1` returns `"ok": true`.

### Day 2 — Oct 5: Task API
- [x] `POST /tasks { repo, prompt, agents: 3..5 }` → makes a TaskRoom, makes N forks, makes 1 write token per fork (scoped to that fork only).
- [x] `GET /tasks/:id` → task state.
- [x] `artifacts/repo.ts` wrapper with unit tests (mock binding).
- [x] Deploy and run the curl check on the real account. *(you)* Passed Oct 4: task `t-cd8a1b8f`, 3 forks, 3 tokens (24 h expiry).
- **Done check:** 1 curl call makes 3 forks and returns 3 tokens.

### Day 3 — Oct 6: The race (minimum)
- [x] `agents/runner.ts`: start 1 sandbox per fork. Run Claude Code (headless) or Agent SDK inside it with the task prompt and fork token.
- [x] Give agents different "styles" so the race is real (e.g. careful / fast / test-first). Same model is fine.
- [x] Time limit per agent (e.g. 8 min). Agent ends by writing `DONE` to TaskRoom.
- [x] Log each agent step into TaskRoom.
- [x] Deploy and run the race on the real account. *(you)* Passed Oct 4: task `t-49d33715`, 3 agents in parallel, all `done`, all pushed (`41a075a3`, `05578917`, `96ce2a2b`). 23–33 s per agent, $0.28 in total.
- Finding: the 2 sample bugs are too easy. All 3 agents made the same fix in about 30 s, so the race shows no real contest. The demo tasks (`demo/tasks/*.md`) need harder, more open work where the styles give different diffs.
- **Done check:** 3 agents run at the same time on 1 task; each fork has a pushed commit.

### Day 4 — Oct 7: Claim board
- [x] `POST /tasks/:id/claims { agent, files[] }`. TaskRoom checks overlap.
- [x] Rule: overlap → `409` + list of who holds what. Agent must pick other files, or wait, or say "shared" (allowed, but costs score).
- [x] Agent prompt: "Claim first. Do not edit files you did not claim."
- [x] `claims.ts` unit tests (overlap, release, re-claim).
- [x] Agents claim from the sandbox with the `claim` CLI (`image/claim.mjs`). It calls `https://<git host>/_thunderdome/...`, which the Outbound Worker answers; the agent name comes from the sandbox, not the request.
- [x] Deploy and run a race; check that the agents claim before they edit. *(you)* Passed Oct 4: task `t-c55620fa`, all 3 agents claimed `src/text.ts` before editing; 2 were refused (`409`), waited, and claimed it after the holder finished.
- **Done check:** test shows agent B gets `409` on a file agent A holds.

### Day 5 — Oct 8: Push events + Previews
- [x] Add `triggers.events` for `cf.artifacts.repo.pushed` (filter: namespace `thunderdome`) → `thunderdome-push` Workflow.
- [x] `PushWorkflow.ts`: on push, update TaskRoom (commit count, last push time, head commit). The event has no changed files.
- [x] Make a Workers Preview per fork push; save the URL in TaskRoom. `wrangler preview` in a sandbox, not Workers Builds (see `docs/api-notes.md`).
- [x] TaskRoom WebSocket: send each change to UI clients (`GET /tasks/:id/live`). Agents now push after each working step.
- [x] Live check passed Oct 4: task `t-852879cc` on `thunderdome-demo`. Push events reached the WebSocket ~1.5 s after each push; all 3 previews served 22–31 s after their push. Built by the harness (`harness/tasks/push.md`).
- **Done check:** push to a fork → a WebSocket client sees the event and a working preview URL within ~30 s.

### Day 6 — Oct 9: Judge
- [x] `JudgeWorkflow` steps: for each fork → run tests in a sandbox (retry 2×) → get diff → LLM score (task fit, clarity) → `score.ts` total.
- [x] `why.ts`: short text: winner, scores table, 3 reasons, 1 line per loser.
- [x] `score.ts` unit tests (0 tests pass cannot win; ties → smaller diff wins).
- [x] Deploy and run the judge on a finished race. *(you)* Passed Oct 4: task `t-c55620fa`, all 3 forks 7/7, winner `fast` 99.19 (tie with `tester`, broken by rank).
- **Done check:** judge runs on 3 finished forks and writes a score and a "why".

### Day 7 — Oct 10: Ship the winner
- [x] Merge the winner fork into the main repo with git in a sandbox (the binding has no merge). "Why" = merge commit body.
- [x] Lock loser forks (revoke write tokens; the binding cannot set read-only after creation). Keep them as a record. All forks are locked, the winner's too.
- [x] Full flow test: `POST /tasks` → race → judge → merge, no hands. Passed Oct 4: task `t-5c67b5b3`, winner `careful` merged into `thunderdome-sample` as `e7aef27` with the why as body, 3 forks locked. Built by the harness (`harness/tasks/ship.md`).
- [x] Demo races need a clean source each run: the merge fixed `thunderdome-sample`, so "Fix the 2 failing tests" had nothing left to fix. Fixed: `POST /tasks { template }` forks the template into a fresh source `<template>-<id>` first; the winner merges there and the template never changes. Passed Oct 4: task `t-31fe17f3` from `thunderdome-template`, merge `827414e` in `thunderdome-template-t-31fe17f3`, template still at `095658f`.
- **Done check:** main repo log shows the merge commit with the "why".

### Day 8 — Oct 11: UI
- [x] Race board: robots in each agent's color (Dillion, Sam, Leo) act out every real step live (scan, hammer, test, claim, clash, push); step feed, commit counts, timer. Page at `/race/:id`, public read routes, live WebSocket.
- [x] Claim board: files × agents grid from the claim history; clashes in red, with a key.
- [x] Scoreboard, previews, the "why" at the end: podium, stacked score bars, a judging reveal, and the judge's "Decided by …" line (`harness/tasks/tiewhy.md`). Judge scorer moved to Cloudflare Clef on Workers AI (`harness/tasks/clef.md`).
- [x] Deployed as static assets on the same Worker (`public/`, `scripts/build-ui.mjs`).
- [x] Extras for the video: Cloudflare pipeline strip, replay with scrubbing and 1–8× speed, race gallery with a leaderboard (`/races`, `harness/tasks/gallery.md`), git graph of the forks, each robot's code (diff), before/after side by side with a flip mode, and "Run your own race" (`/play`, daily quota) (`harness/tasks/levelup.md`). Live Oct 5: `t-188d8b56` started from `/play`, push log, saved diffs, scores and `decidedBy: "code"` all present.
- **Done check:** a full race is easy to follow from the UI only. Passed Oct 5.

### Day 9 — Oct 12: Demo tasks + bug fix
- [x] 3 demo tasks that look good on video (one visible UI change, one bug fix with failing test, one where a claim clash happens). Templates `thunderdome-bugs`, `thunderdome-ui`, `thunderdome-clash` (demo/README.md has the prompts). First runs Oct 4 all clean (`t-38f84f21`, `t-c12d702d`, `t-5f106cfd`), ~1 min and ~$0.35-0.41 each, but every agent pushes once, so previews do not change mid-race.
- [x] Runner auto-push: a Claude Code PostToolUse hook (`image/autopush.mjs`) commits and pushes after each test run and edit (at most every 20 s). Built by the harness (`harness/tasks/autopush.md`). Live Oct 4 `t-2e798ed2`: 2 pushes per agent instead of 1.
- [x] "Before" preview: each race builds a preview of the source at its base commit (`basePreview`, `base-preview` event). Built by the harness (`harness/tasks/basepreview.md`). Live Oct 5 `t-fbecf8bb`: base preview served 10 s after run start (HTTP 500, the broken cart) while all 3 agent previews serve the fixed page; `careful` got 2 previews mid-race.
- [x] Run each task 3×. Fix every bug seen. Oct 5: 9 races (3 per task) plus 2 checks after the deploy, all with `scripts/race.mjs`. Each race takes 70–100 s, agents usually push twice, every agent passes all its tests, and every agent preview returns 200. One bug: `JUDGE.create` failed once with "internal error" (`t-93248e34`), so the task stayed `finished` with no verdict. Fixed in d2956fb: `startWorkflow()` (src/start.ts) retries the create 4× and treats an existing instance as started.
- [x] Cost check: agent cost per race, not counting the judge: bugs $0.29–0.38, ui $0.31–0.46, clash $0.36–0.44. In bugs and ui the fixes differ by ≤0.3, so claim order (10 vs 8 points) picks every winner. In clash, task fit spreads 5–6 points and picks the winner in most races, so clash is the race for the video.
- **Done check:** 3 of 3 demo tasks finish clean, 2 runs in a row.

### Day 10 — Oct 13: Ship the entry
- [x] Live deploy on the `thunderdome` Worker, namespace and `thunderdome-sample` preview Worker (Oct 5). Race `t-db32dd12` passed with all 4 previews.
- [ ] README: what it is, architecture picture, run steps (from clean account to first race), costs, limits. What it is and the run steps are done (Oct 5); the architecture picture, costs and limits are still to do.
- [ ] Record video (script below). Edit to 5–10 min.
- [ ] Make repo public. **Send the entry today.** GitHub `wonbyte/thunderdome` is public; `main` synced Oct 5 (origin is Artifacts, so sync again before sending).
- **Done check:** entry sent.

### Day 11 — Oct 14: Spare day
- Only fixes. No new features.

## 5. Video script (≈8 min)

1. 0:00–1:00 — The problem: many agents, 1 repo. Who does what? Conflicts? Too much to review? Why this change?
2. 1:00–2:00 — The idea: no pull request. A contest. Show the architecture picture.
3. 2:00–6:00 — Live race: 5 agents, claim board clash, previews open, judge scores, merge.
4. 6:00–7:00 — Open the merge commit: the "why". Open a loser fork: the record.
5. 7:00–8:00 — How it uses fork binding, push events, Previews, metrics. Repo link.

## 6. Risks and what we do

| Risk | What we do |
|---|---|
| Artifacts / Sandbox API differs from what we think | Day 1 spike first. Write real names in `docs/api-notes.md`. |
| Previews do not work per fork | Cut Previews (cut order below). Show test output instead. |
| Agents too slow for video | Small sample app, 8 min limit, speed up the video. |
| LLM judge not stable | Tests are 50% + fixed formula; judge temp 0; show the inputs. |
| Cost | Cap at 5 agents, cap tokens per agent, log cost per race. |
| Run out of days | Cut order below. |

**Cut order (first to last):** claim board UI → Previews → metrics → 5 agents (keep 3).
**Never cut:** the race, the judge, the "why" in the commit.

## 7. Day 1 findings

Full notes: `docs/api-notes.md`.

- Artifacts binding: `create`, `get`, `import`, `list`, `delete`; repo: `fork`, `createToken`, `revokeToken`, `info`, `log`, `readFile`, … **No merge.**
- Push events go to a **Workflow** (`triggers.events`), not a Queue.
- Sandbox 1.0: our own Durable Object owns the container. Tokens stay in the Worker (outbound intercept). Claude Code runs headless in it (Cloudflare has an example).
- Bearer auth for Artifacts remotes is confirmed live. Still open: how Workers Previews are made per fork.
