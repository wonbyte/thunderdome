# Harness graph — ship the winner (PLAN.md Day 7)

Status: **approved 2026-10-04** (user: "fix the harness and use it for Day 7"). Runner: `node --env-file=.env harness/run.ts ship`, on branch `harness/ship`.

## Task

When a race finishes, Thunderdome judges it, merges the winning fork into the source repo with the "why" as the merge commit body, and locks every fork as a read-only record by revoking its write tokens. No manual steps between `POST /tasks/:id/run` and the merged commit.

Facts the plan must respect (from the code and `docs/api-notes.md`):
- The Artifacts binding has no merge, so the merge runs with git in a sandbox.
- A sandbox's outbound proxy holds one git token today (`OutboundProps.gitToken`). The merge needs two repos on the same host: read the winner fork, push to the source. So N2 adds per-repo tokens first.
- `revokeWriteTokens(artifacts, name)` exists in `src/artifacts/repo.ts`. The binding cannot set read-only after creation, so revoking is the lock.
- The judge's result today lives only in the Workflow output. Day 7 saves it in TaskRoom.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/ship`.
2. The vitest JSON report shows every required test as passed (R1–R7 below).
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- R1 `policy`: a git request gets the token for its own repo path, and never another repo's token
- R2 `ship`: the merge commit message is a title line, a blank line, then the why
- R3 `ship`: a merge conflict aborts the merge, pushes nothing, and reports "conflict"
- R4 `ship`: no winner means no merge, and the forks are still locked
- R5 `ship`: every fork's write tokens are revoked, the winner's too, even when the merge fails
- R6 `task`: a verdict is saved once, and a second save is refused
- R7 `task`: a task that just finished asks for exactly one judge run

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Confirm branch `harness/ship`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | Schema-valid, R1–R7 assigned to their nodes | 3 attempts |
| N2 | Per-repo git tokens | `OutboundProps` gets per-repo tokens; `decideOutbound` picks the token by repo path | R1; typecheck | 4 attempts |
| N3 | Ship core | `src/ship/ship.ts`: pure `shipTask(deps, input)` with injected git and revoke; the merge message | R2–R5; typecheck | 4 attempts |
| N4 | Verdict + auto-judge | Task state saves the verdict (judge result + ship result); a finished task starts the judge once; JudgeWorkflow runs the ship step after deciding and saves the verdict | R6–R7; typecheck | 5 attempts |
| N5 | Routes + docs | `GET /tasks/:id` shows the verdict; manual `POST /tasks/:id/judge` still works and refuses a second run; README run steps | Full suite | 3 attempts |
| N7 | Review | Opus reviews the branch diff; F5 filters to correctness; F3 (code rule) and F4 add findings | Max 2 rounds | Open findings go in the report |
| N8 | Done check | The 4 checks above | All pass | 2 trips back, then stop |

File ownership:

| Node | Files |
|---|---|
| N2 | `src/sandbox/policy.ts`, `test/policy.test.ts` |
| N3 | `src/ship/ship.ts`, `test/ship.test.ts` |
| N4 | `src/room/task.ts`, `src/room/TaskRoom.ts`, `src/judge/JudgeWorkflow.ts`, `src/sandbox/ThunderdomeSandbox.ts`, `test/task.test.ts` |
| N5 | `src/routes/tasks.ts`, `src/index.ts`, `test/tasks-route.test.ts`, `test/judge-route.test.ts`, `README.md` |

Also allowed: `worker-configuration.d.ts`.

## Fork questions

Same as the judge graph, with two changes from the harness fixes:
- **F3 (diff risk) is a code rule now.** `high` when a `src/` diff line mentions tokens, secrets, auth, revoke or command execution; `medium` above 120 changed lines; else `low`. `high` sends a re-read finding to the owning node.
- **F4 (scope) sees the owning step's brief and contract**, not only the interfaces.

- F1 threshold: 3/3
- F2 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

## Gates (code waits for you)

| Gate | Before |
|---|---|
| G1 | Pushing `harness/ship` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying, and the live no-hands run (`POST /tasks` → race → judge → merge) |

## Budget (hard limits in `harness/llm.ts`)

Opus 100 calls, Sonnet 150 calls, 45 min, $20.
