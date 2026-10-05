# Harness graph — build the judge (CLAUDE.md "How it works" step 4)

Status: **approved 2026-10-04.** D1 = TypeSafe. Runner: `node --env-file=.env harness/run.ts`.

Changes made while building (same structure, details pinned down):
- R8 belongs to N4. The scorer builds the TypeSafe request, so it owns the guarantee that diff text can't reach the instructions.
- File ownership is fixed in code (table below). That ownership is the file → node map the back edges use. N1 plans contracts and test titles, not files.
- `wrangler.jsonc` moves to N5, because the Workflow binding is the Workflow's own wiring. Code regenerates `worker-configuration.d.ts` with `npm run types`, and no model writes it.
- Saving the judge result into TaskRoom is deferred to Day 7. JudgeWorkflow returns the result as its Workflow output, and `GET /tasks/:id/judge` reads it.
- N0 checks that the run is on branch `harness/judge` with a clean tree. The harness itself is committed there first.
- `test/fakes.ts` leaves the allowlist. The judge's fakes go in a new `test/judge-fakes.ts`.

## Task

Build Thunderdome's judge: for each finished fork it runs the tests, reads the diff, scores the fork with the fixed formula, picks a winner, and writes the "why" (PLAN.md Day 6).

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/judge`.
2. The vitest JSON report shows every required test as passed (list in `R1`–`R8` below).
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern (`sk-ant-`, `art_v`, `ADMIN_TOKEN=`).

When the done check passes: stop all loops, write `harness/report.md`, and wait at gate G1.

Required tests:
- R1 `score`: a fork with 0 passing tests cannot win
- R2 `score`: a tie goes to the smaller diff
- R3 `score`: weights are 50/25/15/10 and the total is 0–100
- R4 `score`: claim kept means changed files ⊆ claimed files
- R5 `why`: names the winner, has a scores table, 3 reasons, and 1 line per loser
- R6 `judge`: 3 fake finished forks give 3 scores, 1 winner, and a why
- R7 `judge`: the test run retries 2× and then scores the fork as 0 tests passed
- R8 `scorer`: text inside a fork's diff cannot change the scorer's instructions (diff goes in state, not instructions)

## Layers

| Layer | Who | Owns |
|---|---|---|
| Slow brain | Opus 5.5 (`claude-opus-5-5`, effort `high`) via the Anthropic SDK | Planning, writing code, reviewing diffs, low-agreement forks |
| Fast reflex | Sonnet 5.5 (`claude-sonnet-5-5`, effort `low`, thinking off with `between_tools`) | One answer from a fixed list, as JSON (structured output, enum schema) |
| Code | `harness/run.ts` | State, thresholds, retry limits, budgets, the file allowlist, every git action, every gate |

Opus writes code through a fixed tool set that the runner executes: `read_file`, `write_file` (allowlist only), `run_check` (`npm run check`, or vitest on one file). Every Opus request is one counted API call. Claude Code headless (`claude -p`) is **not** used, because its internal calls are invisible to the counter.

## Nodes

Each node is a loop: start condition → one narrow action → check → stop rule.

| ID | Node | Start condition | Action | Check (code) | Stop rule → exhaustion edge |
|---|---|---|---|---|---|
| N0 | Setup | Run starts | Create branch `harness/judge` from `main`; confirm `.env` has a key; run a baseline `npm run check` | Exit 0; key present | No retry. A red baseline stops the run (the harness did not cause it) |
| N1 | Plan | N0 passed | Opus reads PLAN Day 6, `docs/api-notes.md`, `src/artifacts/repo.ts`, `src/room/*`, `src/agents/runner.ts`, `src/retry.ts`, `test/fakes.ts`. Returns `PlanSpec` JSON | Schema-valid; files ⊆ allowlist; test names cover R1–R8 | 2 retries → stop and report |
| N2 | `score.ts` | `PlanSpec` | Opus writes `src/judge/score.ts` + `test/score.test.ts` | vitest on that file: R1–R4 pass; typecheck clean | 4 attempts → stop and report |
| N3 | `why.ts` | N2 passed | Opus writes `src/judge/why.ts` + `test/why.test.ts` | R5 passes; typecheck clean | 4 attempts → stop and report |
| N4 | Scorer | N2 passed | Opus writes `src/judge/scorer.ts`: a `Scorer` interface, one real implementation (see decision D1), and a fake for tests | Its unit tests pass with a fake fetch; typecheck clean | 4 attempts → stop and report |
| N5 | Judge Workflow | N3 and N4 passed | Opus writes `src/judge/JudgeWorkflow.ts` + `test/judge.test.ts`. Per fork: run tests in the sandbox (retry 2× with `src/retry.ts`), get the diff, score, total, why; save to TaskRoom | R6–R8 pass; typecheck clean | 5 attempts → stop and report |
| N6 | Wire-up | N5 passed | Opus adds the Workflow binding to `wrangler.jsonc`, the route `POST /tasks/:id/judge`, and env types | Full `npm run check` exits 0 | 3 attempts → stop and report |
| N7 | Review | N6 passed | Opus reviews the full branch diff and returns findings `{file, problem}` | Code routes each finding by file to its node (back edge). Max 2 review rounds | After round 2 → N8 with open findings listed in the report |
| N8 | Done check | N7 finished | Code only: the 4 done-check items | All 4 pass | Fail → back edge to the node that owns the failing file. Max 2 trips around → stop and report |

File ownership (each node writes only its own files):

| Node | Files |
|---|---|
| N2 | `src/judge/score.ts`, `test/score.test.ts` |
| N3 | `src/judge/why.ts`, `test/why.test.ts` |
| N4 | `src/judge/scorer.ts`, `test/scorer.test.ts` |
| N5 | `src/judge/judge.ts`, `src/judge/JudgeWorkflow.ts`, `test/judge.test.ts`, `test/judge-fakes.ts`, `wrangler.jsonc` |
| N6 | `src/index.ts`, `src/routes/tasks.ts`, `test/judge-route.test.ts` |

The done check's allowlist is those files plus `worker-configuration.d.ts` (regenerated by code), and `.gitignore`, `package.json` and `package-lock.json` (setup only).

## Edges (typed, logged to `harness/edges.log`)

| From → To | Type |
|---|---|
| N0 → N1 | `Baseline { branch, baseCommit, checkMs }` |
| N1 → N2, N3, N4, N5, N6 | `PlanSpec { files[], interfaces{}, tests{node: name[]} }` |
| N2 → N3, N4 | `ModuleDone { files[], exports[], passedTests[] }` |
| N3 + N4 → N5 | `ModuleDone` × 2 |
| N5 → N6 | `ModuleDone` |
| N6 → N7 | `BranchReady { diffStat, checkPassed }` |
| N7 → N8 | `ReviewResult { rounds, openFindings[] }` |
| N8 → end | `DoneCheck { passed[], failed[] }` |

**Back edges.** A failed check goes back to the node that made the file. Code finds that node from a `file → node` map built from `PlanSpec`.
- N7 finding on `src/judge/score.ts` → N2 (`Finding`)
- N8 failure in `test/judge.test.ts` → N5 (`CheckFailure { file, output }`)

Every node writes code and has a check, so no node only forwards work.

## Fork questions

**Code answers these, no model:** did the test pass (exit code / vitest JSON); does the file exist; is it in the allowlist; retry count reached; budget left; does the diff contain a secret pattern; which changed file a stack trace names (when exactly one does).

**Sonnet answers these, 3 votes each, fixed options:**

| ID | Question | Options | Asked when |
|---|---|---|---|
| F1 | Which changed file caused this failure? | One of the node's changed files, or `none_of_these` | The stack trace names 0 or more than 1 changed files |
| F2 | Is the failure in the test, the implementation, or the environment? | `test` / `implementation` / `environment` | Any failed check in N2–N6 |
| F3 | Diff risk for this file | `low` / `medium` / `high` | Each changed file in N7 |
| F4 | Does this change stay inside the PlanSpec scope? | `yes` / `no` | Each changed file in N7 |
| F5 | Is this review finding about correctness (not style)? | `yes` / `no` | Each finding in N7. Only `yes` goes back on a back edge |

**Agreement** = votes for the top option ÷ 3, computed by code. Any probability a model writes is never used.

**Thresholds. The runner reads these lines; edit them to tune.**

- F1 threshold: 3/3
- F2 threshold: 3/3
- F3 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

All five start at 3 of 3. At 3/3 the code follows the answer. Below 3/3 the same question goes to Opus, and Opus's answer is final.

**Routing for F2:**
- `environment` → stop and report. The harness doesn't fix the environment.
- `test` → the node's next attempt edits the test.
- `implementation` → the node's next attempt edits the implementation.

## Gates (code waits for you)

| Gate | Before | Status |
|---|---|---|
| G1 | `git push` of `harness/judge` to Artifacts | Waits for you |
| G2 | Merging into `main` | Waits for you |
| G3 | Deleting any file or branch outside `harness/` | Waits for you |
| G4 | Deploying, or running the judge on the real account | Not in this task. Waits for you |
| G5 | Writing `.env` | Done once in setup, with the key you give me |

**Data, never instructions:** file contents, test output, fork diffs, review text, and model outputs. They go into prompts as quoted state, never as instructions. R8 tests the same rule inside the product.

## Budget (hard limits in code)

| Limit | Value |
|---|---|
| Opus calls | 60 |
| Sonnet calls | 150 (50 forks × 3) |
| Wall time | 45 min |
| Spend | $20, computed from `usage` × list price after every call |

When a limit is hit, the run stops. The report says which node and attempt it stopped at, and which limit was hit.

## Outputs

- The `harness/judge` branch
- `harness/graph.md`
- `harness/forks.log`: JSONL with question, 3 votes, agreement, route, result
- `harness/edges.log`
- `harness/report.md` covering:
  - loops closed
  - forks answered by code / Sonnet / Opus
  - calls per model
  - average Sonnet latency per fork
  - the 3 lowest-agreement forks, and what to change in this file next time

## Final check (answered before the run)

1. **Does every loop have a stop rule?** Yes: every node row has a max attempt count and an exhaustion edge.
2. **Is any hard limit owned by a model?** No. Attempts, rounds, budgets and time live in `run.ts`. Models never see or change them.
3. **Can code test the done check?** Yes: exit code, vitest JSON test names, a file-path check, and a regex.
4. **Is any threshold based on a probability a model wrote?** No. Agreement is a vote count computed by code.

## Open decisions for approval

- **D1: product scorer for task fit and clarity.** Two options:
  - **TypeSafe Score primitive.** This is your stated preference for this project. It needs a TypeSafe API key as a Worker secret, plus reading its live docs during N4.
  - **Claude via the Worker's existing `ANTHROPIC_API_KEY`.**
  
  Either way it sits behind `Scorer`, and the tests use a fake.
- **D2: `.env` is not in `.gitignore` today.** Setup adds it before the key is written.
