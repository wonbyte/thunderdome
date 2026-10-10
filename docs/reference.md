# Thunderdome reference

Routes, live events, the judge's outputs and the fusion round in detail. The [README](../README.md)
has the overview and setup. Examples use `$THUNDERDOME` for your deploy's URL and `$ADMIN_TOKEN`
for the admin secret.

## Costs

Measured on the live deploy with 3 agents. The agents ran `claude-haiku-5-5` (`AGENT_MODEL`):

| Part | Cost per race | Notes |
|---|---|---|
| Agents (Anthropic API) | about $0.04 | By the meter: $0.010–0.016 per agent, 8–17 model calls each, 270k–660k prompt tokens (mostly cache reads), `ui` demo, Oct 8. Claude Code's own `costUsd` said $0.35–0.53 per agent: it prices `claude-haiku-5-5` at Opus 5.5 rates. On Oct 5, with Claude Code's default model, the `clash` demo cost $0.43–0.55 a race. |
| Cloudflare, all of it | about $0.04 | The race page's bill for the same race: 18 containers, 14 container-minutes, 25 Clef calls, 14 s of browser. |
| Conflict race | about $0.10–0.30 | Only when the winner conflicts with a newer source: 3 short resolver runs. |
| Judge (Workers AI, Clef) | small | 3 questions per fork, asked in both file orders; 1 split question when robots added tests; 2 side-by-side calls on a tie; 1 visual question per race and 1 look question per fork when the task is visual. |
| Browser Rendering | small | Only for visual tasks: 1 browser per race for 1 + 2 per fork screenshots, about 30–60 s. Plus 1 short browser per race for the result card, on its first request (link previews, the gallery). |
| Containers, Durable Objects, Workflows, Previews | small | Billed by Cloudflare usage on the Workers Paid plan. One race keeps 1 agent container per robot (3 to 5) busy for about 1 to 2 minutes, plus short-lived containers for preview builds, the judge (one per fork) and the merge. |
| Artifacts | — | Billed from Oct 15, 2026. A race makes 6 repos (source + 5 forks); retention deletes them after `RACE_RETENTION_DAYS`, so the count stays bounded. |

**The meter.** The Outbound Worker reads the token counts out of each model reply as it streams
past (`src/agents/usage.ts`) and the race page shows them under each robot, priced at list price.
The page trusts the meter over Claude Code's `costUsd`, which it shows only for races before the
meter or a model the meter has no price for (`agentUsd` in `src/ui/bill.ts`). The card under the stage (the X-ray panel,
shown with X-ray off too, and on phones) shows the race's Cloudflare bill (`src/ui/bill.ts`): container-seconds of the agents, preview builds and judge
steps at the `standard-1` list price, Clef calls at $0.24 per million input tokens (one measured
call read 3,650), and the look step's browser time. It is an estimate, not an invoice.

**AI Gateway.** Set `MODEL_GATEWAY` to a gateway id on `CF_ACCOUNT_ID` and the agents' message
calls go through it, tagged with the race and robot (`cf-aig-metadata`). The sandbox still calls
`api.anthropic.com`; the Outbound Worker changes where the call goes. Empty (the default) goes
straight to the model API.

The plan itself is Workers Paid. Each race's agents ran for 45–96 s, and the judge and merge
took 13–29 s more. `/play` races 5 robots, so its agent spend is about 5/3 of the table: about
$0.07 a race on Haiku 5.5. It caps public races at `PLAY_DAILY_LIMIT` per day (default 10), so the
public demo costs about $0.70 a day in agent spend.

## Limits

| What | Limit | Where |
|---|---|---|
| Agents per race | 3 to 5 (`/play` always uses 5) | `src/room/task.ts` |
| Agent run time | 8 minutes each; what it pushed by then still counts | `src/agents/runner.ts` |
| Agent model budget | $1 or 300 model calls per robot, by the meter (a real robot uses about $0.01–0.02 in 9–16 calls); past it the proxy refuses its calls and the robot ends | `src/agents/usage.ts`, `src/sandbox/outbound.ts` |
| Race watchdog | 12 minutes after the start, any agent that never reported back (its sandbox lost track, e.g. a deploy reset it) is ended as failed, so the judge still runs on what the forks hold | `src/room/task.ts`, `src/room/TaskRoom.ts` |
| Prompt | 10,000 characters (`/play`: 10 to 600) | `src/room/task.ts`, `src/play/play.ts` |
| Public races (`/play`) | 10 per UTC day, 3 per IP | `PLAY_DAILY_LIMIT`, `src/play/play.ts` |
| Demo apps on `/play` | `thunderdome-trap`, `thunderdome-ui`, `thunderdome-clash`, `thunderdome-fusion` | `src/play/play.ts` |
| Judge test run | 240 s per try, 3 tries; shared suite 30 s per file, 40 files, 4 minutes per fork (files left unrun count for no fork); 20 minutes per fork step, 3 tries, then that fork gets no test points and cannot win, and the others are still judged | `src/judge/judge.ts` |
| Look | waits for the preview of each agent's final commit until 90 s after the race ends (a retry does not wait again), and not for a build that failed a try; when the wait ends, a fork whose final preview never came is shown by its newest pushed head's preview; 30 s per page load, all pages at once; 8 minutes in all, then judged without look | `src/judge/look.ts`, `src/judge/JudgeWorkflow.ts` |
| Preview build | 80 s per try, 3 tries; a failed try is reported at once so the look stops waiting | `src/push/PushWorkflow.ts` |
| Conflict race | 3 resolvers, 5 minutes each, tests 180 s; 20 minutes for the whole ship step | `src/ship/resolve.ts`, `src/judge/JudgeWorkflow.ts` |
| Diff the scorer reads | whole files up to 100,000 characters, the same files in both orders; the side-by-side comparison gets the first 20,000 characters | `src/judge/scorer.ts`, `src/judge/judge.ts` |
| Diff saved for the page | 200,000 characters, cut at a whole line | `src/judge/diffs.ts` |
| Push log per agent | newest 50 pushes | `src/room/task.ts` |
| Race list | index keeps 200 races; `GET /tasks` returns 50; prompts cut to 280 characters | `src/room/races.ts` |
| Repo retention | a judged race outside the newest 50 loses its repos `RACE_RETENTION_DAYS` (30) after its verdict; the replay stays | `src/routes/retain.ts` |
| Workers Previews | 500 per Worker (oldest deleted first), 100 deployments per preview | Cloudflare limit |
| Containers | No per-app cap: the Durable Object scheduling policy has no `max_instances`, only account limits; a 5-robot race uses about 10 | `wrangler.jsonc` |
| Sandbox idle | a container stops after 10 minutes without use (every step stops its own when done; this catches leaks after a failure) | `src/sandbox/ThunderdomeSandbox.ts` |

What it does not do yet:

- The look score sees screenshots, not behavior: a sort control that shows but does not sort
  scores as well as one that works (the tests cover behavior). Look is judged only on the page at
  `/` at two widths, and Clef's look scores for nearly identical pages differ by tenths of a level.
- A task with one obvious answer makes the agents write the same fix. In both `bugs` races on Oct 5
  all three diffs were the same code (one differed only in the order of an import). The judge
  fingerprints each diff's changed lines and says so ("wrote the same fix; ponder finished first"),
  but nothing in the code can pick a winner then. `clash-full` asks for more than its tests check,
  so its fixes differ; it is the race to watch.
- Clef is deterministic, but a harmless rewrite of a diff (files in another order, `index` lines
  dropped) moves one call's points by up to 3. The judge averages both file orders, which moved by
  at most 0.54 (Oct 7: 38 forks of 10 races), and forks closer than 0.75 points tie (`JUDGE_TIE`).
  See `docs/api-notes.md` for the measurement and the replay of old races.
- A conflict race ships only a resolution whose tests all pass. When none does, or a resolver
  runs out of time, the ship stays `"conflict"` and nothing is merged. Resolvers see the conflict
  and the task, not the other race that changed the source.
- Agents run on Anthropic's API, so `ANTHROPIC_API_KEY` must have credits.
  The Outbound Worker lets agents make only the calls Claude Code needs (`POST /v1/messages`,
  `count_tokens` and its start-up reads; `MODEL_API_CALLS` in `src/sandbox/policy.ts`), so a robot
  cannot start batches or upload files. A message call must ask for `AGENT_MODEL`
  (`messageModelAllowed`), so a robot cannot bill a pricier model. Set a spend limit on the key's Anthropic workspace too.

## Create a task by hand

Make a task. It forks the repo (or a template, with `"template"` in place of `"repo"`) once
per agent (3 to 5, default 3) and returns one write token per fork. Only this response shows the tokens.

```sh
curl -X POST $THUNDERDOME/tasks \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"template":"thunderdome-trap","prompt":"Fix every failing test","agents":3}'

curl $THUNDERDOME/tasks/<id>
```

Pass: the first call returns `201` with `"status": "ready"` and 3 agents, each with a
`fork`, `remote` and `token`. The second call returns the same task without tokens.

## Run the race

Start the agents of a `ready` task. Each agent runs Claude Code in its own sandbox, with its
own style (`ponder` careful, `zippy` fast, `testy` test-first, `snip` lean, `sparkle` tidy), for at most 8 minutes. Agents commit
and push to their fork after each working step. When an agent ends, the sandbox commits what
is left, pushes the fork, and reports `DONE` to the TaskRoom.

The runner also commits and pushes each agent's work after each test run and after edits (at
most every 20 s), so previews change during the race.

```sh
curl -X POST $THUNDERDOME/tasks/<id>/run \
  -H "authorization: Bearer $ADMIN_TOKEN"

# Follow the agents. Pass the last "next" value as "after" to get only new steps.
curl "$THUNDERDOME/tasks/<id>/steps?after=0" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

Pass: after at most about 9 minutes, `GET /tasks/<id>` shows `"status": "finished"` and each
agent has `"pushed": true` and a `commit`.

## Watch a race live

Open `$THUNDERDOME/race/<id>` in a browser. No token is needed:
the page and the read routes it uses (`GET /tasks/<id>`, `/steps`, `/claims`, `/judge`, the fork
diffs and the `/live` WebSocket) are public. Creating, running and judging a task still need
`ADMIN_TOKEN`. Fork tokens never reach task state or the step log (the sandbox proxy adds them),
so nothing secret is public.

Each agent is a robot in its own color: Ponder (careful, orange), Zippy (fast, red),
Testy (tester, blue), and Snip (lean, green) and Sparkle (tidy, purple) in bigger races. Every move is a real event:

| The robot | When the agent |
|---|---|
| scans (eyes glow) | reads or searches code |
| swings a hammer | edits a file |
| charges up | runs the tests |
| thinks (speech bubble) | writes text; the bubble shows its newest step |
| plants a flag | claims files |
| lunges at another robot, with sparks | claims a file another agent holds (a clash) |
| fires a bolt at the core | pushes to its fork; the counter shows its commits |
| falls over | fails or runs out of time |
| jumps with a crown / slumps | wins / loses the verdict |

The **X-ray** button on the stage swaps the robots for the architecture: TaskRoom, a Durable
Object box with each robot's sandbox in its color, Artifacts, Event Subscriptions, the Push
Workflow, the build container, Workers Previews, the Judge Workflow, judge containers, Clef,
Browser Rendering, the fusion round and the ship, each with its binding name, on a blueprint
grid. Switching it on or off cross-fades the robots and the circuit in 0.3 s; nothing is redrawn. Every platform event sends a packet,
in the robot's color when one is involved (its sandbox, claims, pushes and previews, the winner's merge) and
Cloudflare orange otherwise, with a short tail, along its
wires, and the wires it rides glow (`src/ui/xray.ts`); live and in replays alike, a scrub sends
none, and with reduced motion only the node lights. The stage's banner and judge steps step aside
(the Result card and the ticker carry them). The choice is remembered.

While a step runs, its box has a moving dashed border: exactly what the timeline shows running
(a robot's sandbox, a preview build, each judge step's parts). Each box shows its measured time,
the latest and the average, from the timeline's finished bars. The panel under the stage
(`src/ui/xray.ts` `xrayStats`, `traceOf`):

- **Trace:** pick a robot to light its newest push's path, sandbox to Workers Preview, with how long
  after the recorded push its preview went live. Only those two times exist, so the hops between
  are named, not timed.
- **Slow or failed steps:** at most three facts: a build or fork check over twice the race's median
  (with three or more to compare), a build with no saved preview, a robot out of time, a failed step.
- **Your connection:** the round trip from your browser to the race's Durable Object, the median of
  the last five pings, and reconnects. The room answers `ping` with `pong` through
  `setWebSocketAutoResponse`, so a ping never wakes it. Replays have none.

There is no packet loss or DNS data: everything runs inside Cloudflare through bindings, and the
platform does not expose either. Desktop only: on a
phone the labels would be too small to read.

The page shows the task (its race memory folded) and the stage with a verdict banner at the end.
Right under the stage, a card holds the race's Cloudflare bill and, with X-ray on, its trace,
notes and connection; Cheer and "Who wins?" follow while live. Below, tabs show one pane at a
time, so the page does not scroll through every panel:
- **Result:** score bars, an expandable why, Run it again.
- **Previews:** the base "before" next to each robot's newest preview (on phones one robot at a time,
  picked from a row of robot buttons; once judged, each tile adds what Clef saw: its answers and its
  two shots), and Before → after (side by side, or a flip every 2 s with a Pause button; with
  reduced motion the flip starts paused).
- **Timeline:** what ran when, and where the robots ran.
- **Git:** the git graph.
- **Claims & feed:** the claim board (clashes in red) and the live feed.
- **Tests:** who passes whose tests.
- **Fusion:** who wrote main and the fusion round.

A tab shows once its pane has something. Until the viewer picks a tab, the result opens once there
is one, else the claims and feed; the phase rail's steps open their tab too.

For a raw feed, any WebSocket client works:

```sh
npx wscat -c wss://thunderdome.<your-subdomain>.workers.dev/tasks/<id>/live
```

Open it before or after `POST /tasks/<id>/run`. The first message is a `snapshot` with the
current task. Then every change comes as one JSON message with a `kind` and the `taskId`:

| `kind` | When |
|---|---|
| `status` | The run starts, and again once the sandboxes started (`task` is the full task) |
| `steps` | An agent took steps (`agent`, `steps` with `seq`, the same as `/steps`) |
| `claim`, `release` | An agent claimed or released files (`result` / `released`) |
| `push` | A push to an agent's fork was recorded (`push`: `commits`, `pushes`, `head`, `headMessage`, `lastPushAt`, `log`) |
| `preview` | A preview of the agent's newest push is live (`preview`: `url`, `commit`, `at`) |
| `base-preview` | The base preview of the source is live (`preview`: `url`, `commit`, `at`) |
| `agent-end` | An agent ended (`outcome`, the task `status`, and the saved `endedAt` and `finishedAt`) |
| `usage` | An agent's model calls so far (`agent`, `usage`: `calls`, `input`, `output`, `cacheRead`, `cacheWrite` tokens and `usd` at list price; `unpriced` counts calls whose model has no price). Sent after each call the Outbound Worker passes; the same total is saved on the agent as `usage`. |
| `judge` | A judge step started or ended (`step`: `name` such as `fork ponder`, `look`, `split`, `compare`, `fuse` or `ship`; `state` `running`, `done` or `failed`; `startedAt`, `endedAt`). They are also saved as `judging` on the task, so replays play them. |
| `verdict` | The judge saved its verdict |
| `watchers` | A viewer connected or left (`n`: sockets open, at most 200 a race; past that `/live` answers 503). Not recorded; replays have none. |
| `reaction` | A viewer cheered (`emoji`, one of 🔥 👏 😂 😮 💪 ⚡; `agent`: their pick, when it races here). The one message a client may send is `{ "kind": "react", "emoji", "agent"? }`; one per socket per second and ten per race per second are relayed, the rest dropped (`src/room/reactions.ts`). Not recorded. |

A request without `Upgrade: websocket` gets `426`. The server ignores every message you send except a reaction (`react`, above) and the text `ping`, which the runtime answers with `pong`.

## Race gallery

Every race is listed in one race index (the `RaceIndex` Durable Object). A TaskRoom records its
race when it is created, when it starts, when it finishes, and when the verdict is saved. The
index keeps the newest 200 races, with each prompt cut to 280 characters so the list fits in
one storage value.

- `GET /tasks` is public. It returns `{ races }`, newest first, at most 50. Each race has its
  `id`, `prompt` (cut to 280 characters), `status`, times, `agents`, `winner` once judged, and
  `clash` (two agents claimed the same file and a shared claim cost some fork points; a clash
  every fork needed costs nothing, so it is not flagged). Once judged it also has `scores` (`agent` and
  `total` per fork, in ranked order) and `decidedBy` (`"code"`, `"claims"` or `"close"`) for the
  leaderboard. Races judged before these fields have neither, and `decidedBy` is missing when
  there was no winner or no eligible runner-up. `judgedAt` (when the verdict was saved, after the
  merge) feeds the gallery's "start to merged" average; `POST /admin/races` adds it to older races.
- `$THUNDERDOME/races` is the gallery page (`public/races.html`). `GET /` sends a browser
  (`Accept: text/html`) here with a 302; any other client gets the JSON route list.
  No auth. It lists `GET /tasks` and links each race to its live page, or to its replay
  (`/race/<id>?replay`) once judged.
- `POST /admin/races` with `{ ids }` (1 to 50 task ids) adds races made before the index. It
  needs `ADMIN_TOKEN` and returns `{ recorded, missing }`; `missing` lists ids with no task.
- `POST /admin/purge` deletes races for good: each race's forks, the source repo a template
  made for it (a source given as `repo` stays), its stored state, and its gallery entry. Send
  `{ ids }` for some races or `{}` for every race in the list. A race that is running or being
  judged is skipped. It needs `ADMIN_TOKEN` and returns `{ purged, skipped }`. This can't be undone.
  Workers Previews are not deleted; remove them with `npx wrangler preview delete --name
  <race id>-<agent> --worker-name <preview worker> -y` (and `<race id>-base` for the before page).
- **Retention** (`src/routes/retain.ts`): once a day (the cron trigger in `wrangler.jsonc`, 04:23
  UTC) every judged race older than `RACE_RETENTION_DAYS` (30) that is not among the gallery's
  newest 50 loses its repos: the forks, and the source repo a template made for it. The race
  itself stays: its replay, scores, saved diffs and card still work; only the commit views
  (`GET /tasks/<id>/commits/<sha>`, the fusion and verdict commit dialogs) answer `410`, and the
  race's summary carries `reposGone: true`. `POST /admin/retain` runs it now and returns
  `{ days, released, skipped }`. One race at a time, so Artifacts is never flooded.
- `GET /tasks` is cached at the edge for 10 seconds and a race's card for a year
  (`src/routes/cache.ts`), so a burst of gallery visits is one read of the index per colo.

```sh
curl $THUNDERDOME/tasks

curl -X POST $THUNDERDOME/admin/races \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"ids":["t-0123abcd","t-4567cdef"]}'

curl -X POST $THUNDERDOME/admin/purge \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'
```

## Link previews

Every page carries Open Graph and Twitter card tags, added as the page is served (`src/routes/share.ts`,
`src/routes/card.ts`). `/races` and `/play` name the site and the static `public/og.png`. `/race/<id>`
reads the task: the prompt is the title, the description is the winner with the judge's headline
("live race" or "the judge is scoring every fork" before that), and the image is the race's own card
once there is a winner.

- `GET /race/<id>/card.png` is public: the result card at 1200×630 (the winner in its color, the
  podium from the verdict's scores, the fused count and the prompt). It is drawn with Browser
  Rendering on its first request after the verdict, kept in the task's room (under 1 MB; JPEG when a
  PNG would be larger) and served with a year-long immutable cache. `404` before the verdict or with
  no winner; `503` (not cached) when the browser could not draw it, so the next request tries again.
  Prompts and the judge's text are HTML-escaped on the card.
- The gallery shows the card on the newest 12 finished races (lazy-loaded; a card that fails to load
  leaves no gap), so a fresh gallery asks for few at once.
- `public/og.png` is the site's card. `node scripts/build-og.mjs > og.html` prints its page; shoot it
  at 1200×630 to update the image.
- Replay links can point at a moment: `/race/<id>?replay&t=1:42` (or `t=102`, seconds) opens the
  replay paused there; the link button next to the replay time copies one.
- "Run it again" on a finished demo race opens `/play?template=<app>&prompt=<task>` with both filled in.

## Race memory

Context carries from one race to the next. When a race is created, the TaskRoom looks up the
newest 3 judged races on the same app (the same demo template, or the same repo) in the
RaceIndex. Every agent's system prompt then lists each one: the task, the winner, the winner's
strongest point in plain words ("its diff was the smallest (41 lines changed vs 60)", or "more of its
tests passed (7/7 vs 5/7)") and the judge's one-line reason. The strongest point is the score part
where the winner led by the most points, else a smaller diff, else finishing first on a tie
(`lesson` in `src/judge/why.ts`). For a race on a shared repo, it also names the winner's merge commit, which is
already in the repo the agents fork. The race page shows this under the task ("Remembers"), and
the gallery shows each race's reason.

Past prompts come from other users, so each is quoted as JSON and the agents are told the list
is a record of what the judge rewarded, not instructions. Each prompt is cut to 200 characters.
The code is `raceMemory` in `src/room/races.ts` and `memoryText` in `src/agents/prompt.ts`.

## Live previews

Every push to a fork's `main` builds a Workers Preview of exactly that commit. The previews
show up on the task:

```sh
curl $THUNDERDOME/tasks/<id> \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

Each agent has a `push` once its fork got a push: `push.preview.url` is the newest preview and
`push.preview.commit` the commit it was built from. `push.head` is the newest pushed commit,
`push.commits` and `push.pushes` count what was pushed, and `push.lastPushAt` says when. A
preview is saved only for the newest head, so while a build runs, `push.preview.commit` can lag
behind `push.head`. The `thunderdome-push` Workflow instances show build failures.

`push.log` lists the recorded pushes for the git graph, oldest first, at most the newest 50: each
entry has `at` (when it was recorded), `commit`, `commits` (the commits it counted), and `message`
when the push had one, and `previewAt` once its preview was saved. A push repeated by an event retry is recorded once. Tasks from before the
log have no `push.log`; read it as empty.

Each race also gets a base preview of the source repo at the commit the forks were made from,
built when the race starts: `basePreview` (`url`, `commit`, `at`) in `GET /tasks/<id>` and a
`base-preview` message on the live socket. It is the "before" picture next to the agents' previews.

## Judge and ship

You do not call anything else. When the last agent ends, the TaskRoom starts the judge. The
judge scores each fork, rating its diff (with each changed function in full, since Clef sees no
other code) for task fit, readability and unrelated edits with Cloudflare's Clef
(`@cf/cloudflare/clef`) on Workers AI through the `AI` binding (so no extra API key is needed),
picks a winner, and merges the winner's fork into the source repo's
default branch.

**Look.** Clef first answers a yes/no question on the task text: does it ask for a change a person
would see on the page? If yes, the judge waits until each fork's preview is built from the fork's
final commit, the one its agent ended on (until 90 s after the race ends; a preview whose build failed a try is not waited for), then uses the `BROWSER` binding to screenshot the "before" page and
each fork's page at desktop (1280 px) and phone (390 px) width. Clef sees those screenshots and
scores two things on 5 levels: how completely the page shows what the task asks (60%) and how
clean and readable it is (40%). A fork whose preview is missing or does not load gets 0 look
points, and the why says so. If the screenshots or Clef fail for every fork, or the look runs past
its 8-minute budget, the race is judged without look rather than give the forks left 0. The merge commit holds the "why". Then it makes every fork read-only and saves
the verdict on the task.

**Fusion round.** <a id="fusion-round"></a>Before the merge, the judge tries to add the losers' best
work to the winner. For each losing fork that could have won, best first, it tries two kinds of
addition on a clone of the winner's fork, in a sandbox:

- **Files** the loser changed and the winner did not. Every robot writes its tests in a file of its
  own (`test/<name>.test.ts`), so this is often the loser's tests.
- **Hunks** in files both changed. The loser's diff from the fork point is split into hunks, and
  each one is applied alone with `git apply --3way`. A hunk that does not apply cleanly is dropped
  (a fusion never creates a conflict), and so is one that only touches whitespace or comments or
  that the winner's change already has. At most 3 hunks per loser are tried. Each hunk is named
  for the function, constant or test it changes ("Ponder's cartMessage in src/shop.ts").

Each addition is its own try, and three gates must pass:

1. Every test passes, and no fewer pass than before it.
2. Clef answers a yes/no question. When the additions are all tests: do they check something the
   task asks that the winner's own tests do not? Otherwise (code, or a hunk): do they make the
   change better for the task, or do they repeat it, stray from it, or only make it bigger?
3. That yes is at least 0.6.

**The fused score.** When something was kept, the fused head is scored the same way as the forks:
the tests (from the last kept try's run), task fit and clarity (Clef, on the diff from the fork
point). Look and claims carry over from the winner: the fused head has no preview of its own, and
the added work came through the gates, not through a claim. A fusion that adds code is pushed
only when the fused score is **at least** the winner's score alone; otherwise every kept try is
turned down with the two numbers ("the fused change scored 90.1, below 91.9 for the winner alone"),
and the winner ships as judged. A fusion that adds only tests is kept on its gates even when it
scores lower, and the panel says so: added tests cannot raise the tests part (it is passed/total,
so 13/13 and 20/20 both score full), while the bigger diff costs clarity. Scoring is best effort and time-boxed (90 seconds): if Clef fails, the fusion
is kept on its gates and the verdict says it was not scored. The result is saved as
`verdict.fusion.score = { before: { total, tests }, after: { total, tests } }` and is
written into the why ("ponder alone 91.9 -> fused 94.6 (tests 20/20 -> 26/26)"). Only races judged
since this was added have a score.

The sandbox that runs the losers' tests (agent-written code) holds read tokens only. The kept
commits leave it as a git bundle; a second sandbox with the winner fork's write token runs only
git and checks the bundle before it pushes. The bundle must build on the fork's current head with
exactly one plain commit per kept try. Each file commit may change only its try's files, and
each hunk commit must be byte for byte the patch the gates passed. The round is time-boxed (no new
try after 5 minutes), so it never pushes after its step has given up. An addition that passes
becomes its own commit on the winner's fork, authored by the robot that wrote it ("Thunderdome
fusion: add testy's test/cart.test.ts to ponder's fix", or "add ponder's cartMessage in
src/shop.ts"), so `git log` and `git blame` credit each robot. The merge commit on main credits
them too: after the why it ends with one `Co-authored-by: Thunderdome testy
<testy@thunderdome.local>` trailer for each robot whose work was fused and merged (the identity
its own commits use), so GitHub shows them as co-authors. Merges from before this change have no
trailers (commits never change). The ship then merges the fused fork as usual, the fused commit
gets its own preview, and the why gains a "Fusion" section listing every try and why it was kept
or left out. The code is `src/judge/fusion.ts`; `demo/fusion` is a demo app built for it.

The race page makes the round visible, kept or not (`src/ui/fusion.ts` is the shared model):

- **Stage.** After the winner is revealed, each loser throws its file (`{ }`) or hunk (`@@`) onto
  the winner. A kept one lands and the mascot stamps it "fused!"; a left-out one bounces off the
  winner with the gate that said no ("Clef 0.18 < 0.60", "tests 5/6" or "scored lower"). The last stamp is the score: "team 94.6 vs 91.9 alone
  (+2.7)". The loser then wears an "⚡ assist" tag.
- **Fusion round panel.** The score headline ("Testy alone 91.9 → fused 94.6 · tests 20 → 26")
  over two bars, winner alone and fused. A fusion dropped for scoring lower says so. Then one row
  per try: the files or the hunk, gate 1 (tests 20/20), gate 2 (Clef's yes as a bar with the 0.6
  line on it), and the outcome, with the reason for a left-out try.
- **Who wrote main.** A stacked bar of the shipped change's lines by robot, with a legend (name,
  percent, lines). The ship computes it in its git-only sandbox right after the merge:
  `git blame -w --line-porcelain <first parent>..<merge>` on each file the merge added or changed
  (up to 40), counted by each robot's commit email, without blank lines. It is saved as
  `verdict.ship.blame` (`{ testy: 90, ponder: 12, thunderdome: 1 }`); races shipped before it was
  added show no bar.
- **Git graph.** An arrow from each loser's lane into the winner's lane just before the merge:
  solid into the fusion commit when kept, dashed and stopping at ✗ when left out. The fusion
  commit is a real commit node: its author robot and "660ef87 · by Ponder". Click it (or the
  commit in the panel) to open it as git stores it, read from Artifacts by
  `GET /tasks/:id/commits/:sha`: hash, author (the loser), committer (Thunderdome), parents,
  message and the files it changed, as a diff: every piece the fusion added. Each fused row in the
  panel also links to its own commit (races judged from Oct 7), which shows just that piece. The
  route answers only for the commits the verdict names, never any other hash.
- **`git log --graph main`.** Under the graph, main's history after the race: the merge, then
  the winner's side (the fusion commit on top of its pushes), then the base, with the author
  column in each robot's color.
- **The sandbox handoff.** The panel shows the round as git: read-only sandbox (runs the tests,
  scores the fused code) → git bundle (`refs/fusion/result`) → write sandbox (checks it, `git push`).
- **X-ray.** A "Fusion round" box between Clef and the ship, timed by the fuse step.
- **Gallery.** A race that shipped a loser's work gets a "⚡ fused" pill, and a scored one a
  "team +2.7" pill (the fused score minus the winner's alone). The leaderboard counts each robot's
  **assists** (races it lost whose work still shipped; the tooltip adds its lines shipped while
  losing), and the stats strip adds "lines shipped while losing" and "fusions beat the winner
  alone". These read `losing` and `team` in each race summary; races recorded before them have
  neither (`POST /admin/races` re-records old summaries, which picks up only what their verdicts
  hold).

If the source moved on during the race (another race shipped first, or someone pushed), the
winner's merge can conflict. Then the ship starts a **conflict race**: a second sandbox clones
the source, adds one `git worktree` per resolver (Ponder, Zippy and Testy again), starts the same merge in
each, and runs Claude Code in all of them at once. Each resolution is checked (no conflict markers left, and
a real merge of the source head and the winner), then tested and committed. The one that finished
first with all its tests passing is pushed as the merge commit, with a line under the why on who resolved it.
The other committed resolutions are kept on the source as `thunderdome/<task>/resolve-<resolver>`
branches. The resolvers' sandbox has read tokens only; the chosen merge comes back to the ship sandbox,
which holds the write token, as a git bundle.

Read the verdict on the task once it is saved:

```sh
curl $THUNDERDOME/tasks/<id> \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

Pass: the task has a `verdict` with `winner`, `why`, `judgedAt` and `ship`. When
`ship.status` is `"merged"`, `ship.commit` is the merge commit on the source repo. Its message is
`Thunderdome: ship <winner>'s fork for task <id>`, then the why. `ship.locks` has one entry per
fork, with `revoked` (the write tokens it revoked) or `error`. Other `ship.status` values:
`"conflict"` (the merge did not apply and no resolver passed every test; `ship.output` has git's
output), `"no-winner"`, and
`"error"` (`ship.error` says why). The verdict also has `scores` (per fork, in ranked order:
`agent`, `total`, `eligible`, and `parts` with `tests`, `taskFit`, `clarity`, `look` (only when the race was judged on look) and `claim`) and
`decidedBy` (`"code"`, `"claims"`, `"close"`, or `"same"` when the winner and the runner-up wrote the
same fix; missing with no winner or no eligible runner-up).
After a conflict, `ship.resolve` has `files` (what conflicted), `attempts` (per resolver: `status`
`"green"`, `"red"`, `"unresolved"` or `"failed"`, `seconds`, `tests`, `commit`, `costUsd`, `note`),
`chosen`, `kept` (the branches that keep the other attempts) and `error` when the race itself failed.

To stage a conflict on the live deploy, `HOTFIX=1 node --env-file=.env scripts/race.mjs fusion`
plays a teammate: at the first robot push (a minute at most) it pushes a one-line fix to the race's source repo, on
the `saleBadge` line every robot replaces, so the winner's merge conflicts and the conflict race
runs (about +$0.10–0.30 and +1 minute; it needs the `cf` login for a 10-minute write token, which
goes only in git's env). On Oct 10 (`t-b62c6026`) Ponder and Testy resolved it 19/19 and Ponder's
merge shipped. `scripts/conflict.mjs` does the same with two races on one source (about $1).

To follow the judge while it runs, or to see each fork's scores:

```sh
curl $THUNDERDOME/tasks/<id>/judge \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

Its `output`, once `"status": "complete"`, has the scores (with `tie` when the top forks tied), each fork's own and shared test results (`crossTests`, `input.shared`), Clef's raw answers (`scorer.raw`), `split` when Clef was asked whether the task splits the work, the why and the same `ship` result.

If the judge did not start (`GET /tasks/<id>/judge` returns `404` on a finished task), start
it by hand. It returns `202`, or `409` with the instance status if a judge already exists:

```sh
curl -X POST $THUNDERDOME/tasks/<id>/judge \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

## Fork diffs

The judge saves the diff it scored for each fork (from the fork's starting point to its head),
cut to whole lines within 200,000 characters. Saving is best effort: a failed save is logged
(`judge.diff_save_failed`) and the judge goes on.

`GET /tasks/<id>/forks/<agent>/diff` is public. `<agent>` is the agent's name (lowercase letters).
It returns `{ agent, diff, clipped }`, where `clipped` is true when the diff was cut, or `404`
`{ "error": "not found" }` before the judge saved one. Other methods get `405`.

```sh
curl $THUNDERDOME/tasks/<id>/forks/ponder/diff
```

## Where the robots ran

Each robot's sandbox Durable Object gets a location hint when the race starts
(`src/room/regions.ts`): Western North America, Western Europe and Oceania for the first three,
then Eastern North America and Eastern Europe. The fork name is new each race, so the hint always
applies; builds, the judge and the ship keep the default. The agent's slot records it as `region`.
Only regions the model API serves are used: `apac` put a robot in Hong Kong on Oct 8, and every
model call from there got 403 "Request not allowed".

Before the agent starts, the sandbox reads Cloudflare's trace page from its Durable Object and the
slot records that data center code as `colo` ("AMS"). The container usually starts near its
Durable Object, but Cloudflare does not promise it, and the container's own requests carry no
location (a probe from inside the container came back empty). The race page draws a world map with
a pin per robot at its region, labeled with its colo.

## The timeline

The race page's "Timeline · what ran when" card is a Gantt built from the race record
(`src/ui/gantt.ts`), on an axis from the race's start: the base preview build (from the start to
`basePreview.at`), each robot's sandbox (`startedAt` to `endedAt`), each push's preview build, each
judge step, and the merge (or the verdict when nothing merged). A build ends when its preview was
saved (the push's `previewAt` in the log). A build before a robot's newest preview with no time of
its own is left out: a newer push superseded it, or the race predates `previewAt`. A build with no
preview yet is a running bar until the verdict or its 80 s limit; after that its end is really
unknown, and the bar is dashed up to the limit or the race's end, the same rule as the bill. A retried judge step is
one bar: the record keeps only its latest attempt. Colors are products: Containers, Workers
Previews, Workers AI, Artifacts, Workflows. In a replay a cursor follows the scrub.

## What Clef saw

On a visual task the look step keeps its screenshots: each fork's preview at desktop (1280×800)
and phone (390×844) width, and the source's before page at desktop width, as the JPEGs Clef was
shown (`src/judge/look.ts` `keep`, `src/judge/JudgeWorkflow.ts`). `GET /tasks/<id>/shots/<agent>/desktop.jpg`
and `phone.jpg` are public (`<agent>` is `before` for the source); `404` when the look kept none
(a race that is not visual, a fork without a preview, a race from before Oct 8, or a shot over
900 KB). They never change, so they are cached at the edge for a year. Each robot's preview tile shows
them: Clef's fit and quality answers and the look points in its caption, the two shots under the
live page (click to enlarge). The source's before shot is kept but not shown: the Before tile
already is that page, live.

## Verdict commits

`GET /tasks/<id>/commits/<sha>` is public and reads a commit from Artifacts. It answers only for
the commits the verdict names: the fusion head and each kept try's own commit (read from the
winner's fork), and the merge (read from the source repo). `<sha>` is the full 40-character
lowercase hash; any other hash is `404`. It returns `{ kind, repo, hash, message, author,
committer, parents, against?, authoredAt, committedAt, files }`. For the fusion head, `files`
holds each file the fusion changed since the commit it started from (`against`), so every kept
try shows; for one kept try's commit, each file it changed against its first parent: `{ path, change, content, before? }` with `change` one of `added`, `modified` or
`deleted` (`before` is the parent's text of a modified file). Text is cut at 64,000 characters
with `clipped: true`; a binary file has `binary: true` and no content. The page draws a line diff
from it. A found commit is cached for good (`immutable`); a repo or commit Artifacts does not have
is `404`, and an Artifacts failure is `503` (not cached).

## Run your own race

Anyone can start a 5-robot race on a demo template, without `ADMIN_TOKEN`. A daily quota (the
`PlayQuota` Durable Object, one instance `"daily"`) guards it: at most `PLAY_DAILY_LIMIT` races
per UTC day, and at most 3 per IP.

- `$THUNDERDOME/play` is the play form page (`public/play.html`). No auth.
- `POST /play` with `{ template, prompt, invite? }`. `template` is one of `thunderdome-trap`, `thunderdome-ui`,
  `thunderdome-clash` or `thunderdome-fusion`, and `prompt` is 10 to 600 characters (trimmed). `invite` is needed only when
  `PLAY_INVITE` is set. It creates the task, starts it, and returns `202`
  `{ id, page: "/race/<id>", remaining }`. It never returns fork tokens. Errors: `400` for a bad
  body, `403` `{ "error": "invite code is wrong" }`, and `429` `{ error, reason }` when the quota is
  used up (`reason` is `"daily"` or `"ip"`). A failed create or run returns its own status and error,
  and the play still counts.
- `GET /play/quota` returns `{ day, used, limit, remaining, invite }`. `invite` is true when an
  invite code is set.

Two vars in `wrangler.jsonc` set it up:

- `PLAY_DAILY_LIMIT`: races per UTC day, default `"10"`. Anything that is not a positive integer means 10.
- `PLAY_INVITE`: the invite code. Empty (the default) means no invite code. Set it at deploy with
  `npm run deploy -- --var PLAY_INVITE:<code>`.

```sh
curl -X POST $THUNDERDOME/play \
  -H "content-type: application/json" \
  -d '{"template":"thunderdome-trap","prompt":"Fix the failing tests"}'

curl $THUNDERDOME/play/quota
```

## Claim board

Agents claim files before they edit them. In the sandbox they run `claim <file>...`,
`claim --shared <file>...`, `claim --release [<file>...]`, or `claim --list`. A claim is never
refused, because each agent works in its own fork: a claim on a file another agent holds becomes a
shared claim, and the response lists the clash. The judge takes 2 of the 10 claim points from a fork
that changed a file it held only as shared, but only when another fork that passed tests did the task
without changing that file. A clash every fork needed costs nothing. An agent can make at most 200 claims in a race
(`MAX_CLAIMS_PER_AGENT`); past that a claim gets `429`. You can use the board by hand too:

```sh
curl -X POST $THUNDERDOME/tasks/<id>/claims \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"agent":"ponder","files":["src/text.ts"]}'

curl $THUNDERDOME/tasks/<id>/claims \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

## Using Podman instead of Docker

Point wrangler at Podman and its socket before `npm run deploy`. The wrapper script drops
two Docker-only build flags that wrangler sends (`--provenance=false`, `--load`), and saves
the Dockerfile that wrangler pipes on stdin to a temp file (Podman cannot read it from a socket).

```sh
# macOS
podman machine start
export WRANGLER_DOCKER_BIN="$PWD/scripts/podman-as-docker.sh"
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"

# Linux
systemctl --user start podman.socket
export WRANGLER_DOCKER_BIN="$PWD/scripts/podman-as-docker.sh"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
```

If git fails with 401, see open item 1 in [api-notes.md](api-notes.md).
