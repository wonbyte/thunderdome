# Harness graph — the why says what decided the race

Status: **approved 2026-10-05**. The user said "do 1 and 2"; item 2 is: make the why say it outright when the fixes are equal and claims decide ("fixes equal; X claimed first"). Runner: `node --env-file=.env harness/run.ts tiewhy`, on branch `harness/tiewhy`.

## Task

In two live clash races under Clef (`t-1e518af0`, `t-3dc38627`), the three fixes were nearly the same. Task fit spread 0.3–1.1 points, and claim order (10 vs 8 claim points) picked the winner. In `t-3dc38627` the winner had the lowest task fit and clarity. The why lists part margins, but it never says plainly what decided the race. Add one headline paragraph to the why, right after the scores table, that names the decider.

Facts the plan must respect:
- **Code points** are tests + task fit + clarity (`ForkScore.parts`). Claim points are `parts.claim`. The runner-up is the highest-ranked eligible fork other than the winner. `CODE_TIE = 1` point (export it).
- **Headline (one line, plain text, no markdown).** Exactly one of these applies, checked in this order:
  1. No winner, or no eligible runner-up: no headline.
  2. code gap (winner minus runner-up) >= CODE_TIE: `Decided by code: <winner>'s fix scored <gap> more points on tests, task fit and clarity than <runner-up>'s.`
  3. |code gap| < CODE_TIE and claim gap > 0: `Decided by claims: the fixes were within <|gap|> points on code; <winner> <claimed the files first | kept its file claim> (<w claim> vs <r claim> claim points).` Use "claimed the files first" when the runner-up holds shared files (`shared.length > 0`) and the winner holds none; otherwise "kept its file claim". When the code gap is below 0, add ` even though its code scored <|gap|> lower` before the final period.
  4. code gap <= -CODE_TIE (the winner made it up on claims): `Decided by claims: <winner>'s code scored <|gap|> points lower than <runner-up>'s, but its claim points made up for it (<w> vs <r>).`
  5. Otherwise (|code gap| < CODE_TIE and no claim gap): `Decided by a close margin: the fixes were within <|gap|> points on code.`
  All numbers are rounded to 2 decimals, without trailing zeros (like the table: 0.55, 1, 18.8).
- **Placement:** in `buildWhy`, after the table and before `Why <winner> won:`, as `""`, `<headline>`. Everything else in the why stays exactly the same: line 1, the table, the 3 reasons and Others. Existing tests (R5 and the rest) must pass unchanged.
- Export `headline(result: ScoreResult): string | undefined` so the page can show it.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/tiewhy`.
2. Every required test (W1–W4) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- W1 `why`: a clear code lead gives the "Decided by code" headline with the gap
- W2 `why`: equal code with a claim lead gives "Decided by claims … claimed the files first (10 vs 8 claim points)"; a winner whose code is up to 1 point lower gets the "even though" clause
- W3 `why`: a winner more than 1 point behind on code that wins on claims gets the "made up for it" headline; a close race with no claim gap gets "Decided by a close margin"
- W4 `why`: there is no headline with no winner or a lone fork; the headline sits between the table and "Why <winner> won:", and the rest of the why is unchanged

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/tiewhy`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | W1–W4 assigned | 3 attempts |
| N2 | Headline | `why.ts` `headline` and `CODE_TIE`, placed in `buildWhy`; tests | W1–W4; full suite | 4 attempts |
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
| G1 | Pushing `harness/tiewhy` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying and the live check: a race whose why has the right "Decided by" line |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20 (the limits in `harness/llm.ts`).
