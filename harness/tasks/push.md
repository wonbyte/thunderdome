# Harness graph — push events + Workers Previews (PLAN.md Day 5)

Status: **approved 2026-10-04** (user: "start day 5", "yes" to agents pushing mid-race). Runner: `node --env-file=.env harness/run.ts push`, on branch `harness/push`.

## Task

Every push to an agent's fork shows up live: the TaskRoom records it, a Workers Preview of that commit is built, and WebSocket clients see both within about 30 s. Agents push after each working step, so previews update during the race, not only at the end.

Facts the plan must respect (spike results in `docs/api-notes.md`, "Workers Previews"):
- Push events go to a Workflow: `triggers.events` with type `cf.artifacts.repo.pushed`, filter namespace `thunderdome`. Envelope: `source.namespace`, `source.repoName`, `payload.{ref, before, after, commits[], totalCommitsCount}`. No changed files. The docs disagree on the trigger syntax; use the form in `docs/api-notes.md` and say so in a comment.
- A preview is `wrangler preview -c <thunderdome config> --name <task>-<agent> --json` run in a sandbox clone of the fork; the URL is `.preview.urls[0]`. Thunderdome owns the config (`name` = the preview Worker, `main` = the repo's `src/index.ts`, `compatibility_date`, `previews: {}`), so forks need no Wrangler file.
- Wrangler needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The real token never enters a sandbox: the sandbox gets a placeholder, and the outbound proxy sets the real `authorization` header for `api.cloudflare.com`, only for preview sandboxes, only GET/POST under `/client/v4/accounts/<account>/workers/workers/<preview worker>/previews`.
- The sandbox has no internet besides that, so wrangler must be in the image (pinned, same major as the repo's).
- The judge's merge pushes to the source repo `thunderdome-sample` in namespace `thunderdome`. That push must be ignored (it is not a fork).
- Several pushes from one fork can be in flight. A preview for an older commit must never replace a newer one.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/push`.
2. Every required test (R1–R8) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- R1 `policy`: a preview sandbox gets the preview token on the previews path with GET or POST, and nothing else does
- R2 `policy`: another Worker, another account, another method, or a path that escapes the previews prefix is refused
- R3 `push`: a push event to a task fork names its task and agent; the source repo, other namespaces and other branches are ignored
- R4 `push`: the preview name is DNS-safe, stable for a task and agent, and short enough for the preview hostname
- R5 `push`: the preview URL is read from wrangler's JSON output, and bad output gives none
- R6 `task`: a push is recorded once per commit, counts commits, and keeps the newest head
- R7 `task`: a preview URL is saved only when it is for the agent's newest pushed commit
- R8 `agents`: the agent prompt tells agents to commit and push after each working step

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/push`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | R1–R8 assigned to their nodes | 3 attempts |
| N2 | Preview API policy | Outbound props gain a preview-API grant; `decideOutbound` injects the preview token only under the previews prefix | R1–R2; typecheck | 4 attempts |
| N3 | Push core | `src/push/push.ts`: parse the event to `{taskId, agent, ref, after, commits}`, preview name, preview config text, read the preview URL | R3–R5; typecheck | 4 attempts |
| N4 | Push Workflow | Task state records pushes and previews; `PushWorkflow` (record push → build preview in a sandbox → save URL); `wrangler.jsonc` trigger, binding, vars, secret; wrangler in the image | R6–R7; typecheck | 5 attempts |
| N5 | Live WebSocket + mid-race push | TaskRoom accepts WebSockets and sends each change (step, claim, push, preview, verdict); route `GET /tasks/:id/live`; agent prompt says commit and push after each working step; README | R8; full suite | 4 attempts |
| N7 | Review | Opus reviews the diff; F5 filters; F3 code rule; F4 sees the step brief | Max 2 rounds | Open findings in the report |
| N8 | Done check | The 4 checks above | All pass | 2 trips back, then stop |

File ownership:

| Node | Files |
|---|---|
| N2 | `src/sandbox/policy.ts`, `src/sandbox/outbound.ts`, `test/policy.test.ts` |
| N3 | `src/push/push.ts`, `test/push.test.ts` |
| N4 | `src/room/task.ts`, `src/push/PushWorkflow.ts`, `src/index.ts`, `wrangler.jsonc`, `Dockerfile`, `test/task.test.ts` |
| N5 | `src/room/TaskRoom.ts`, `src/routes/tasks.ts`, `src/agents/prompt.ts`, `test/agents.test.ts`, `test/tasks-route.test.ts`, `README.md` |

Also allowed: `worker-configuration.d.ts`.

## Fork questions

- F1 threshold: 3/3
- F2 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

F3 (diff risk) is the code rule in `run.ts`.

## Gates (code waits for you)

| Gate | Before |
|---|---|
| G1 | Pushing `harness/push` to Artifacts |
| G2 | Merging into `main` |
| G4 | Setting `CLOUDFLARE_PREVIEW_TOKEN` on the Worker, deploying, and the live check (push → WebSocket event + working preview URL within ~30 s) |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20.
