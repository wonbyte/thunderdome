# Harness graph — judge scorer on Clef (Workers AI)

Status: **approved 2026-10-05**. The user asked "Can we replace jev with clef?" after the Workers AI changelog of 2026-10-01. Runner: `node --env-file=.env harness/run.ts clef`, on branch `harness/clef`.

## Task

The judge rates each fork's diff for task fit and clarity with Jev, through TypeSafe's HTTP API (`src/judge/scorer.ts`, key `TYPESAFE_API_KEY`). Cloudflare's Clef follows the same System One API and runs on Workers AI. Move the scorer to Clef through the Worker's `AI` binding. That removes the external key and keeps the whole judge on Cloudflare.

Facts the plan must respect (from a live probe on 2026-10-05 with the judge's exact request):
- **Call:** `env.AI.run("@cf/cloudflare/clef", { model: "clef", state, questions })`. The `model` field must match the model id: `clef` for `@cf/cloudflare/clef`, `clef-flash` for `@cf/cloudflare/clef-flash`. A mismatch is a 422 "Unsupported model". Use `@cf/cloudflare/clef`, the 27B model; the judge is not latency-bound.
- **Response:** the same shape as Jev, `{ model: "clef", answers: { task_fit: { type: "score", score, legend, probabilities, confidence }, clarity: {...} } }`. `parseResponse` keeps working. Also accept a `{ result: { answers } }` wrapper, in case the binding wraps it.
- **State and questions:** both are unchanged. `QUESTIONS` stays byte-for-byte the same, and the diff goes only in state.
- **Probe scores (good diff / unrelated diff):** Clef task fit 3.79 / 0.21, Jev 3.99 / 0.00. Clef ranks the same way, with softer confidence (~0.7).
- **Errors:** `AI.run` throws on failure (capacity, rate limit, network). A thrown error is retried (`SCORER_ATTEMPTS`, `SCORER_RETRY_DELAY_MS`). A malformed answer is not retried. Error messages never include the diff.
- **The scorer must stay free of `cloudflare:workers`:** it takes a structural `{ run(model: string, input: unknown): Promise<unknown> }` so tests can fake it.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/clef`.
2. Every required test (C1–C4) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- C1 `scorer`: the Clef request uses model id `@cf/cloudflare/clef` and body model `clef`, with the questions unchanged and the diff only in state (and clipped)
- C2 `scorer`: a Clef answer (plain, or wrapped in `result`) parses to taskFit and clarity on 0..1, and a malformed answer throws without a retry
- C3 `scorer`: a thrown `AI.run` error is retried up to the attempt limit, then surfaces as ScorerError
- C4 `scorer`: no error message or thrown error contains the diff text

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/clef`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | C1–C4 assigned | 3 attempts |
| N2 | Clef scorer + wiring | `scorer.ts` on an injected AI runner; tests; `JudgeWorkflow` uses `clefScorer(env.AI)`; `wrangler.jsonc` AI binding, TYPESAFE_API_KEY dropped from the required secrets; types regenerated (one step, because the typecheck covers the whole project) | C1–C4; typecheck | 4 attempts |
| N3 | Docs | README | full suite | 2 attempts |
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
| G1 | Pushing `harness/clef` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying and the live check: a `clash` race whose judge output has `scorer.raw.taskFit` from Clef for every fork, a verdict, and a merge. Compare its task-fit spread with the Jev races (5–6 points). |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20 (the limits in `harness/llm.ts`).
