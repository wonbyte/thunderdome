# Harness graph — race index and gallery routes

Status: **approved 2026-10-05**. The user said "do 1, 2 and 4, then 3". Item 4 is replay plus a race gallery, so judges can watch any past race. Runner: `node --env-file=.env harness/run.ts gallery`, on branch `harness/gallery`. This graph only builds the server side. The `/races` page itself and the replay player are page code, built directly on a UI branch.

## Task

Each race lives in its own TaskRoom Durable Object, and nothing lists them. Add a race index: one `RaceIndex` Durable Object (instance name `all`). It keeps a short summary of every race, newest first. The TaskRoom records the race whenever its state changes in a way that matters. A public `GET /tasks` returns the list. `GET /races` serves the gallery page from assets. An admin route adds older races by id.

Facts the plan must respect:
- **Summary type:** `RaceSummary` is pure and lives in `src/room/races.ts`. Fields: `id`, `prompt`, `template?`, `status`, `createdAt`, `startedAt?`, `finishedAt?`, `agents` (names), `winner?` (`string | null`, only once judged), and `clash` (true when the claim history has a file claimed by 2+ agents; pass the history in). It is built from a `Task` with `summaryOf(task, claimHistory)`. `upsertRace(list, summary, max = 200)` replaces by id, keeps newest `createdAt` first, caps the list, and never mutates its input.
- **Recording:** the TaskRoom records after create succeeds, after run starts, when the last agent ends (finished), and after the verdict is saved. The call is `this.env.RACE_INDEX.getByName("all").record(summary)` inside try/catch that only logs (`console.error` with event `race_index.record_failed`). A failure never fails or delays the task.
- **Routes:**
  - `GET /tasks` returns `{ races: RaceSummary[] }`, newest first, at most 50. It is public.
  - `POST /tasks` is unchanged and still needs admin.
  - `GET /races` is a page: the Worker serves `env.ASSETS.fetch` of `/races.html`.
  - `POST /admin/races` with body `{ ids: string[] }` (1..50 valid task ids) is admin. It reads each TaskRoom's state and claims and records the ones that exist, then returns `{ recorded, missing }`. It backfills races from before the index.
- **Access:** `accessFor` (`src/routes/access.ts`) gains `GET /tasks` as public and `GET /races` as page. A new pure `pageAsset(pathname)` returns `/race.html` for `/race/:id`, `/races.html` for `/races`, and undefined otherwise. `src/index.ts` serves the page with it.
- **Index object:** the RaceIndex stores the list in `ctx.storage.kv` under one key. It is a new class with binding `RACE_INDEX`. This repo uses no `migrations` block (TaskRoom has none), so add only the binding.

**Done check (code tests it, no model involved):**
1. `npm run check` exits 0 on branch `harness/gallery`.
2. Every required test (L1–L6) passes in the vitest JSON report.
3. Every changed file is inside the allowlist.
4. The diff contains no secret pattern.

Required tests:
- L1 `races`: summaryOf copies the task fields, agent names and winner (only when there is a verdict), and sets clash from the claim history
- L2 `races`: upsertRace replaces by id, sorts newest first, caps at max, and leaves its input unchanged
- L3 `access`: GET /tasks is public, POST /tasks is admin, GET /races is page, and pageAsset maps both pages and nothing else
- L4 `tasks route`: GET /tasks returns the index list (at most 50), and POST /tasks still creates a task
- L5 `tasks route`: POST /admin/races records existing races, lists missing ids, and rejects a bad body with 400
- L6 `access`: the existing public and admin rules (U1, U2) still hold

## Nodes

| ID | Node | Action | Check (code) | Stop rule |
|---|---|---|---|---|
| N0 | Setup | Branch `harness/gallery`, clean tree, key present, green baseline | Exit 0 | No retry |
| N1 | Plan | Opus reads the files below and returns `PlanSpec` | L1–L6 assigned | 3 attempts |
| N2 | Pure core | `races.ts` + tests; `access.ts` gains the rules and `pageAsset` + tests | L1–L3, L6; typecheck | 4 attempts |
| N3 | Index + wiring | `RaceIndex` DO, TaskRoom recording, routes, `index.ts`, `wrangler.jsonc` binding, types regenerated, README | L4–L5; full suite | 4 attempts |
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
| G1 | Pushing `harness/gallery` to Artifacts |
| G2 | Merging into `main` |
| G4 | Deploying and the live check: backfill the past races, then `GET /tasks` lists them, `/races` shows the gallery, and a new race appears in the list on its own |

## Budget

Opus 100 calls, Sonnet 150 calls, 45 min, $20 (the limits in `harness/llm.ts`).
