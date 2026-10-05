# Harness graph — "before" preview at race start (PLAN.md Day 9)

Status: **approved 2026-10-04** (user: "yes" to a base preview of the source repo when a race starts). Runner: `node --env-file=.env harness/run.ts basepreview`, on branch `harness/basepreview`.

## Task

Agents finish in about a minute and push in one burst, so per-agent previews only ever show the end state (race `t-2e798ed2`: 2 pushes each, 4–10 s apart, one preview each). Give every race a "before" picture: when a race starts, build one Workers Preview of the source repo at the commit the forks were made from, save it on the task as `basePreview`, and send it on the live WebSocket. For `thunderdome-bugs` that is the crashing home page next to three fixed ones.

Facts the plan must respect:
- Previews are built by `PushWorkflow` (`src/push/PushWorkflow.ts`): clone a repo with a short-lived read token, checkout the commit, write Thunderdome's preview config, run `wrangler preview --name <name> --json` with the preview-API outbound grant, read the URL. The base preview reuses this code path with a different repo, commit and name; do not copy it.
- `PushWorkflow`'s payload today is the Artifacts push event. The base request is a second payload shape, `{ kind: "base", taskId, repo, commit }`, told apart by a pure parser; the Artifacts event parser must keep ignoring it and vice versa.
- The preview name is `<taskId>-base` (a DNS label, at most `MAX_PREVIEW_NAME_LENGTH` like agent names; `base` is not an agent name, so it never collides).
- The source repo is `task.repo` (for a template task, the fresh `<template>-<id>` repo). The base commit is the source head when the forks are made; the winner's merge lands on the source later, so the commit must be pinned at create time, not read at build time.
- The TaskRoom starts the Workflow when the race starts (`run()`), with instance id `<taskId>-base`; failing to start it must never fail the run (log it). A base preview is saved only for the task's base commit.
- The live WebSocket sends `{ kind: "base-preview", taskId, preview }`; the snapshot already carries the task, so `task.basePreview` shows up there too.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/basepreview`.
2. Every required test (B1–B5) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- B1 `push`: the base preview name is `<taskId>-base`, a DNS label within the length limit, and a bad task id throws
- B2 `push`: the base request parser accepts `{ kind: "base", taskId, repo, commit }` with a valid id, repo name and commit, and rejects anything else; the push event parser ignores a base request and the base parser ignores a push event
- B3 `task`: makeForks returns the source head commit as the base, for a repo task and a template task
- B4 `task`: a base preview is saved only when its commit is the task's base commit
- B5 `task`: the base request for a task carries its id, source repo and base commit, and there is none without a base commit

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/basepreview`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | B1–B5 assigned to their nodes | 3 attempts |
| N2 | Base request core | `push.ts`: base preview name, base request type and parser | B1–B2; typecheck | 4 attempts |
| N3 | Task state | `task.ts`: base commit from makeForks, `basePreview`, `applyBasePreview`, `baseRequest` | B3–B5; typecheck | 4 attempts |
| N4 | Workflow + room | `PushWorkflow` handles both payloads through one build function; `TaskRoom` pins the base at create, starts the base build in `run()`, saves and broadcasts it; README | full suite | 4 attempts |
| N7 | Review | Opus reviews the diff; F5 filters; F3 code rule; F4 sees the step brief | Max 2 rounds | Open findings in the report |
| N8 | Done check | The 4 checks above | All pass | 2 trips back, then stop |

File ownership:

| Node | Files |
|---|---|
| N2 | `src/push/push.ts`, `test/push.test.ts` |
| N3 | `src/room/task.ts`, `test/task.test.ts` |
| N4 | `src/push/PushWorkflow.ts`, `src/room/TaskRoom.ts`, `README.md` |

## Fork questions

- F1 threshold: 3/3
- F2 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

F3 (diff risk) is the code rule in `run.ts`.

## Gates (code waits for you)

| Gate | Before |
|---|---|
| G1 | Pushing `harness/basepreview` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying and the live check: an `thunderdome-bugs` race whose live stream has a `base-preview` event with a URL that serves the broken page, while the agents' previews serve the fixed one |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20.
