# Plan: under the hood, for real (Oct 8–14, 2026)

Six features that make the Cloudflare machinery visible with things nobody can fake: real
numbers, real pictures, real paths. Built in the order below; the cut line is after #3. Two days
stay reserved for the video. Each item: a direct change, `npm run check`, a review, a live race.

| # | Feature | Effort | Day |
|---|---|---|---|
| 1 | What Clef saw: the look screenshots, kept and shown | ½ day | Oct 8 am |
| 2 | Spectators: who's watching, reactions over the socket | 3 h | Oct 8 pm |
| 3 | The meter: tokens and dollars per robot, live; the Cloudflare bill per race; AI Gateway | 1 day | Oct 9 |
| 4 | Robots from different continents: location hints and a map | 1 day | Oct 10 |
| 5 | The timeline: a Gantt of everything that ran, with true durations | 1 day | Oct 11 (if on track) |
| 6 | X-ray mode: the architecture as a circuit lit by the real event stream | 1–2 days | only if 1–4 land by Oct 10 |
| — | Fresh-clone README check, Anthropic spend limit, three clean live races | ½ day | Oct 11 |
| — | Video: script, shot list, record, cut | 2 days | Oct 12–13 |
| — | Submit | | Oct 14 |

Rules that hold for every item: UI code in `src/ui` only (browser code, no imports from `src`);
pure modules with tests for anything that decides something; agent-written and player-written
text never goes in markup unescaped; Workflow step outputs stay small and JSON.

---

## 1. What Clef saw

The look step shoots every fork's preview at phone and desktop width with Browser Rendering,
asks Clef two questions about the pictures, then throws the pictures away. Keep them and show
them: the look score becomes a thing you can see, and Browser Rendering and Workers AI stop being
lines in a log.

**Where it hooks.** `lookAtPreviews` in `src/judge/JudgeWorkflow.ts` already has each shot as a
base64 JPEG (`screenshot()`, quality 70, full page). After `judgeLook` returns, save them:
`room.saveShots(agent, kind, bytes)` for `desktop` and `phone` per fork, plus `before` for the
source. Only visual races have them.

**Storage.** A `shots` table in the TaskRoom next to `card`: `(key TEXT PRIMARY KEY, body BLOB,
at TEXT)`, key `<agent>/<kind>`; cap each at 900 KB (a full-page JPEG is 100–300 KB; a page
taller than ~6 screens is clipped to the first 6 before saving). `purge()` deletes them with the
room.

**Route.** `GET /tasks/:id/shots/:agent/:kind.jpg` — public in `access.ts`, `immutable` and
through `cached()` like the card. 404 before the look ran. `before` is `:agent`.

**Page.** In the result panel, under the score bars, a strip "What Clef saw" when the verdict has
look: per fork, the desktop and phone thumbnails with the fork's look points and Clef's two
answers (fit, quality, from `GET /tasks/:id/judge` → `output.look.forks`); the source's "before" first.
A thumbnail opens full size in the existing dialog shell (`src/ui/dialog.ts`). Replays get it
for free. Hide the strip when no shot exists (older races).

**Tests.** Access rule (`U*`); the pure strip builder from a judge body (`L1..`): forks in rank
order, before first, missing shots skipped; the clip rule.

**Verify.** A live `ui` race: the strip shows three forks × two shots plus before; a shot loads
in under a second the second time (`cf-cache-status: HIT`).

**Risk.** Row size: measure the first race's JPEGs; if any is over the cap, drop to quality 60.

---

## 2. Spectators

The race's hibernating WebSocket already knows who is watching. Show the count, and let viewers
cheer, all through the same Durable Object.

**Server.** `TaskRoom`: on socket open and close, broadcast `{ kind: "watchers", n }` with
`ctx.getWebSockets().length`. `webSocketMessage` (today a no-op) accepts `{ kind: "react",
emoji }` from an allowlist of 6, rate-limited to one per second per socket (a counter in the
socket's attachment), and broadcasts `{ kind: "reaction", emoji, agent? }` to everyone. Nothing
is stored: replays do not need it. A bad message closes nothing; it is ignored.

**Page.** Header: "12 watching" next to the live pill (hidden in replays). Under "Who wins?": a
row of the six emoji; a tap sends one, and it floats up from your pick's nameplate on every
viewer's stage (from the core when there is no pick). Reduced motion: a 1 s fade instead of the
float. Cap 30 floating at once; drop the rest.

**Tests.** The allowlist and the per-socket limiter are pure (`W1..`): a seventh emoji is refused,
two in a second keep one, the count event shape.

**Verify.** Two browser tabs on a live race: the count reads 2, a reaction in one floats in both.

---

## 3. The meter

Every model call a robot makes already passes through the Outbound Worker; that is how the API
key never enters the container. Count what passes, and show the economics live: on each
nameplate, "142k in · 3.1k out · $0.19" climbing as the robot thinks; in the pipeline, the
race's Cloudflare bill.

**Outbound.** In `Outbound.fetch` (`src/sandbox/outbound.ts`), when the decision is a model call
and the response is 200: for `text/event-stream`, pipe `response.body` through a
`TransformStream` that passes bytes untouched and scans complete SSE events for `message_start`
(`usage.input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and
`message_delta` (`usage.output_tokens`); for JSON, read a clone. When the stream ends, call
`TASK_ROOM.getByName(props.taskId).usage(agent, { calls: 1, input, output, cacheRead,
cacheWrite })`. `OutboundProps` already names the task and the agent. A parse failure counts the
call and nothing else, never fails the request.

**Pricing.** `src/agents/usage.ts` (pure): a rate table per model id (input, output, cache read,
cache write per million tokens, from the pricing page, not from memory), `costOf(usage, model)`,
and `addUsage`. The robot's own `costUsd` (reported by Claude Code at the end) stays the final
figure; the live meter is an estimate and says so in its title.

**Room.** `AgentSlot.usage` accumulates; broadcast `{ kind: "usage", agent, usage }` at most
once per second per agent (coalesced with an alarm-free timer: keep the last broadcast time in
the slot). Saved with the task, so replays show the final numbers from the start of judging.

**Cloudflare bill.** `src/ui/bill.ts` (pure): from the task record, container-seconds =
agents (`startedAt`→`endedAt`) + preview builds (each push log entry → its preview's `at`, or 80
s when none) + judge steps (`judging`) + fusion and ship; Clef calls = forks × 6 + split +
compare + look; browser seconds from the look step's duration. One rate table (`standard-1`
per second; neurons per Clef call; browser per second), with a comment that it is list price.
Shown in the pipeline header: "this race: 7 containers · 31 container-min · 42 Clef calls ·
Cloudflare ≈ $0.04 · agents $0.71".

**AI Gateway (optional, same day).** Point `MODEL_API_HOST` at
`gateway.ai.cloudflare.com` and prefix the path with `/v1/<account>/<gateway>/anthropic` in the
policy; set `ANTHROPIC_BASE_URL` for Claude Code (`src/agents/runner.ts`) to the gateway. Add
`cf-aig-metadata: {"task": …, "agent": …}` so the gateway's log filters by race. Claude Code's
start-up reads (`/api/hello`) do not exist on the gateway: answer them in the Outbound Worker.
Keep this behind a var (`MODEL_GATEWAY`), default off, so a gateway problem is one flag away.

**Tests.** The SSE usage scanner (`M1..`): split chunks, both event kinds, a malformed event;
`costOf`; the bill from a recorded task; the coalescing rule.

**Verify.** A live race: the nameplates climb; the final meter is within 10% of each robot's
`costUsd`; the pipeline line shows the bill; with the gateway on, the gateway dashboard shows
15 requests tagged with the race id.

**Risk.** Tapping the stream must not slow the agent: the transform passes chunks through
synchronously and parses only on event boundaries. Measure one race's agent time against the
last Haiku race.

---

## 4. Robots from different continents

Durable Objects take a location hint, and a container runs beside its Durable Object. Give each
robot a different region and show where it actually ran.

**Server.** `TaskRoom.run`: `env.SANDBOX.getByName(slot.fork, { locationHint: REGIONS[i] })`
with `REGIONS = ["wnam", "enam", "weur", "eeur", "apac"]` (`DurableObjectLocationHint`); the
pure pick is `regionFor(index)` in `src/room/regions.ts`. Agent sandboxes only; builds, judge
and ship stay default. A hint applies when the object is first created, and a fork name is new
per race, so it always applies. Save the hint on the slot (`region`).

**Where it really ran.** The sandbox's Thunderdome API (`handleThunderdomeApi`) gets
`GET /api/where`, answering the `cf.colo` of the request the container made; the runner calls
it once at start and the slot records `colo`. Day-one check: if `cf` is empty on those
requests, the page shows the hint ("asked for Western Europe") and the colo column is dropped.

**Page.** A small equirectangular world map (one SVG path, 9 region dots) under the stage, each
robot's pin in its color with the colo code; nameplates get a region tag. Beams in X-ray mode
(#6) start from the pin. Replays read the saved fields.

**Tests.** `regionFor` cycles for 3 and 5 robots (`G1..`); the map projection of the nine hints
lands each inside its continent (a table of expected boxes).

**Verify.** A live race: five pins in five regions; the colo codes differ; agent times still
within the usual 53–83 s (a far region may add seconds to every push; that is a talking point,
not a bug).

**Risk.** Hints are best-effort. If two robots land in the same place, the map still tells the
truth; the demo line becomes "asked for five, got four".

---

## 5. The timeline

A Gantt of everything that ran, from the record: half "under the hood", half "why did this take
2:32".

**Pure.** `src/ui/gantt.ts`: rows from a `WireTask` — each agent (`startedAt`→`endedAt`), each
push's preview build (push log `at` → preview `at`, or the preview's failure), the base preview,
each judge step (`judging`, a retried step as two segments by `attempt`), fusion and ship (judge
steps `fuse`, `ship`), the verdict mark. Each row has a product (Containers, Workflows, Previews,
Workers AI, Artifacts) for its color. The replay cursor is `replay.t`.

**Page.** A card "Timeline · what ran when" under the pipeline, collapsed by default on phones,
with the time axis in `mm:ss` from the start and a hover label with the duration. In a replay the
cursor moves with the scrub. Reduced motion: no transitions.

**Tests.** Rows from the recorded task in `test/timeline.test.ts` (`T1..`): order, segments of a
retried step, a build with no preview, the merge mark.

**Verify.** t-f5bc4f1c's replay: 3 agent rows, 6 builds, 7 judge steps, fusion, ship, merge at
1:43.

---

## 6. X-ray mode

A toggle on the stage that swaps the robots for the architecture, lit by the same event stream.

**Pure.** `src/ui/xray.ts`: the circuit (nodes = products with their binding names, edges =
bindings: Artifacts → Event Subscriptions → Push Workflow → build container → Workers Preview;
TaskRoom ↔ sandboxes; Judge Workflow → judge containers, Clef, Browser Rendering → fusion → ship
→ Artifacts) and `edgeFor(hit)` from `applyPlatform`'s hits to the edge a packet travels. Pure,
tested (`X1..`): every hit kind maps to an edge, unknown hits to none.

**Page.** An SVG drawn once; each robot's container is a node in its color inside a "Durable
Object" box; a hit sends a packet along its edge (the pipeline's packet animation, reused) and
flashes the node. Replays identical. Reduced motion: highlight only. The toggle is remembered in
`localStorage`.

**Verify.** A replay at 8×: packets follow the pushes and the judge steps in order; nothing fires
on a scrub.

**Risk.** The SVG art is the cost; a one-day version with boxes and lines ships before the
pretty one.

**Status (Oct 10).** The boxes-and-lines version is built (X1–X4, axe clean, replay at 8× in
order, nothing on a scrub); desktop only. Live in c83e28d (race t-fdcd263c). Since then: busy boxes,
measured times, a push trace, slow-step notes and the viewer's round trip (X5–X8).

---

## Video shot list (Oct 12–13)

Two races, recorded ahead (5 robots each, `AGENTS=5`):

- **Hero: `fusion`.** Shots 1–10 below: split spotted, fusion kept, Clef's side-by-side close call, look judged.
- **Tests tab: the hero `fusion` race.** No separate trap race: on Oct 10 the `trap` demo never
  spread the scores (4 races, every robot fixed every rule), so show "Who passes whose tests" from the fusion race.
- **Hotfix: `HOTFIX=1 scripts/race.mjs fusion`.** For the conflict race: the teammate's push at
  the first robot push, the merge conflict, three resolvers, the feed line "… won the conflict race".

1. `/play`: pick "Four parts, one fusion", start.
2. The stage with the explainer open; the guess; the rail moving to Race.
3. The meter climbing on a nameplate; the map with five pins (#3, #4).
4. X-ray mode for one push (#6): switch it on (the robots cross-fade into the circuit), trace a robot's push.
5. Judging: the rail at Judge, the steps, Clef's fit histograms.
6. The reveal; the verdict line; what Clef saw on each preview tile (#1); the photo finish if there is one.
7. The fusion round; the git graph with the merge; the fusion commit dialog.
8. The timeline (#5); the Cloudflare bill line.
9. The gallery card; a shared link's preview; a `?t=` moment link.
10. The architecture, 30 seconds, over `docs/reference.md`.
11. Fusion race: the Tests tab, "Who passes whose tests" on the shared suite.
12. Hotfix race: the teammate's commit on the source, the conflict race, the merged resolution.
