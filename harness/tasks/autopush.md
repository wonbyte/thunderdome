# Harness graph — runner auto-push (PLAN.md Day 9)

Status: **approved 2026-10-04** (user: "yes" to building the runner auto-push through the harness). Runner: `node --env-file=.env harness/run.ts autopush`, on branch `harness/autopush`.

## Task

Agents ignore "push after each working step": in the first demo races (`t-38f84f21`, `t-c12d702d`, `t-5f106cfd`) every agent pushed once, at the end, so previews never changed mid-race. Make the runner push for them: a Claude Code `PostToolUse` hook in the sandbox commits and pushes the agent's work as it goes. Then each race shows several pushes and previews per agent.

Facts the plan must respect:
- Agents run as `claude --print ...` in the sandbox (`src/agents/runner.ts` builds the command, `src/sandbox/ThunderdomeSandbox.ts` runs it in `/workspace/repo`). Claude Code takes extra settings as a JSON string with `--settings '<json>'`; a hook is `{"hooks":{"PostToolUse":[{"matcher":"Bash|Edit|Write|MultiEdit","hooks":[{"type":"command","command":"/usr/local/bin/autopush"}]}]}}`. The hook gets JSON on stdin with `tool_name` and `tool_input` (`tool_input.command` for Bash) and runs in the repo directory.
- The agent's env already carries its git identity (`gitIdentity`), and git push to the fork already works in the sandbox (the outbound proxy adds the token). The hook uses the same `git push origin HEAD:refs/heads/main`.
- The hook runs in the agent's turn, so it must be quick and must never fail or block the tool: every error ends with exit 0 and no output on stdout. A failed push is fine; the next one or the runner's end-of-run push catches up.
- Every push builds a preview (~25 s) and a push event, so pushes are rate-limited: push after a test run (`npm test`, `npm run test`, `node --test`, `vitest`) whenever there are changes; after any other tool only when there are changes and at least `AUTOPUSH_MIN_INTERVAL_S` (20 s) passed since the last auto-push. The last push time lives in a state file outside the repo (default `/workspace/run/autopush.json`, path overridable by env for tests).
- The commit message names the agent and the changed files: `Thunderdome <agent>: work in progress (src/a.ts, src/b.ts)`, clipped to 120 characters. The agent name comes from `GIT_AUTHOR_NAME` (`Thunderdome <agent>`).
- Agents may still commit and push themselves; the hook commits only what is uncommitted, and also pushes commits that are not on the remote yet.
- `image/claim.mjs` is the model for an image CLI: plain Node ESM, no dependencies, copied in by the Dockerfile.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/autopush`.
2. Every required test (P1–P6) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- P1 `autopush`: after a test-run Bash command with uncommitted changes, the hook commits and pushes them to the remote's main
- P2 `autopush`: after an edit, the hook pushes only when at least the minimum interval passed since the last auto-push
- P3 `autopush`: with nothing new (clean tree, nothing unpushed) the hook makes no commit and no push
- P4 `autopush`: the commit message names the agent and the changed files and is at most 120 characters
- P5 `autopush`: bad stdin, a repo without a remote, or a failing push all exit 0 with nothing on stdout
- P6 `agents`: the agent command installs the autopush hook with `--settings`, and the prompt tells agents the runner pushes their work as they go

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/autopush`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | P1–P6 assigned to their nodes | 3 attempts |
| N2 | Autopush hook | `image/autopush.mjs` (decide, message, git steps, main), its tests in temp git repos with a bare remote, Dockerfile installs it | P1–P5; typecheck | 5 attempts |
| N3 | Runner wiring | `agentCommand` passes the hook settings; the prompt says the runner pushes as they go; README note | P6; full suite | 4 attempts |
| N7 | Review | Opus reviews the diff; F5 filters; F3 code rule; F4 sees the step brief | Max 2 rounds | Open findings in the report |
| N8 | Done check | The 4 checks above | All pass | 2 trips back, then stop |

File ownership:

| Node | Files |
|---|---|
| N2 | `image/autopush.mjs`, `image/autopush.d.mts`, `test/autopush.test.ts`, `Dockerfile` |
| N3 | `src/agents/runner.ts`, `src/agents/prompt.ts`, `test/agents.test.ts`, `README.md` |

## Fork questions

- F1 threshold: 3/3
- F2 threshold: 3/3
- F4 threshold: 3/3
- F5 threshold: 3/3

F3 (diff risk) is the code rule in `run.ts`.

## Gates (code waits for you)

| Gate | Before |
|---|---|
| G1 | Pushing `harness/autopush` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying (new image) and the live check: a demo race where each agent pushes more than once and previews change mid-race |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20.
