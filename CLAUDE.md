# Thunderdome

Robots (Claude Code agents) race on one task, each in its own fork of the repo. A judge scores
every fork, the winner merges, and the "why" stays in the merge commit. It runs entirely on
Cloudflare: Artifacts (git), Sandbox containers, Durable Objects, Workflows, Workers Previews,
Workers AI (Clef) and Browser Rendering.

- Live: https://thunderdome.git-bc1.workers.dev (`/play` starts a public race, `/races` is the gallery).
- Entry for the Cloudflare contest. Deadline **Oct 14, 2026**: a 5–10 min video, MIT source, run steps.
- `README.md` is the short overview and run steps; keep it short. `docs/reference.md` has every
  route, live event, cost and limit. `PLAN.md` is the original day-by-day plan. `docs/api-notes.md`
  has platform findings, measurements and open items.

## Commands

```sh
npm run check        # build:sample + build:ui + tsc (worker, test, ui) + oxlint + vitest. Run before every commit.
npm test             # build + vitest only
npm run dev          # wrangler dev (containers need Docker or Podman)
```

`public/race.js`, `races.js`, `play.js` and `src/generated/` are build output (`build:ui`,
`build:sample`). Edit `src/ui/*.ts` and `demo/*`, never the generated files.

## Git: two remotes, keep both in sync

- `origin` is Cloudflare Artifacts. It needs a short-lived token on every push; never put a token
  in a URL, the git config or command output:
  ```sh
  cf artifacts namespaces tokens create default --repo thunderdome --scope write --ttl 600 > <scratch>/tok.json   # prints JSON; there is no --json flag
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
    GIT_CONFIG_VALUE_0="Authorization: Bearer $(jq -r .plaintext <scratch>/tok.json)" git push origin main
  rm <scratch>/tok.json
  ```
  A 401 (10000) means the `cf` login expired: ask the user to run `cf auth login --force`
  (plain `cf auth login` wrongly says "already logged in").
- GitHub `wonbyte/thunderdome` is public and is the contest's source link. It has no remote in the
  clone: `git push git@github.com:wonbyte/thunderdome.git main`.

## Deploy

This machine has Podman, not Docker. Use the repo's shim (README, "Using Podman instead of Docker");
it fixes the flags wrangler sends and the digest Podman pushes. Do not write another wrapper.

```sh
systemctl --user start podman.socket
WRANGLER_DOCKER_BIN="$PWD/scripts/podman-as-docker.sh" DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock" npm run deploy
```

Commit, push and deploy only when the user asks. They usually want a review before a commit.

## Code rules

- **Pure modules, injected I/O.** Logic lives in modules with no `cloudflare:workers` import
  (`judge.ts`, `score.ts`, `scorer.ts`, `fusion.ts`, `room/task.ts`, `ship/ship.ts`, ...). Durable
  Objects and Workflows (`TaskRoom.ts`, `JudgeWorkflow.ts`, `PushWorkflow.ts`) only wire bindings
  and sandboxes into them. Unit-test the pure module with fakes (`test/judge-fakes.ts`).
- **`src/ui` is browser code.** It has its own tsconfig (`tsconfig.ui.json`) and never imports from
  the rest of `src`; server code never imports from `src/ui`. Shared facts (robot names, weights)
  are duplicated on purpose; change both sides.
- **Agent output is untrusted.** Diffs, test files and commit messages are agent-written. They go
  only in a Clef request's `state`, never in its questions, and error messages must not echo them
  (see the redaction in `scorer.ts`). Pass agent-written strings to shells as argv, never
  interpolated.
- **Style.** Short plain-English comments that say why, one `/** */` per export. Test names start
  with an id (`R6:`, `J1:`, `S3:`) and state the behavior. Match the density of the file you are in.
- **Steps are durable.** A Workflow step's output must be JSON-serializable and small; anything
  optional is passed as JSON text (see the comments in `JudgeWorkflow.ts`).

## The judge (`src/judge/`)

- Score out of 100: tests 50, task fit 25, clarity 15, claims 10. Visual tasks: tests 45, task fit
  20, clarity 10, look 15, claims 10 (`score.ts`).
- **Tests** use a shared suite (`crosstests.ts`, `sharedSuite` in `judge.ts`): every fork runs the
  repo's test files (from the base commit, so edits to them don't count) plus each robot's added
  test files that fully pass on at least two forks. When Clef says the task gives robots different
  parts (`testscope.ts`), only the repo's tests count: Clef could not tell which robot a test file
  belongs to (measured Oct 7). A fork out of time reports the files it ran, and only files every
  fork ran count; a fork whose run failed scores 0 on them. Only when no fork could run the suite
  (the base's tests are not `node --test`) does every fork fall back to its own `npm test`.
- **Robot code is untrusted at judge time too.** The diff and the judged commit are taken before any
  robot code runs; tests run as the unprivileged `tester` user (`asTester` in `judge.ts`), which
  cannot change the clone or the tools; `npm test` runs the base's script; the ship merges the
  judged commit (or the fusion on it), never a later push.
- **Clef** (`@cf/cloudflare/clef` on Workers AI, System One API; see the TypeSafe docs) answers task
  fit (6 levels, judged against what the task asks of that robot), readability (4 levels) and a
  yes/no on unrelated edits (`scorer.ts`). It gets each changed function in full
  (`git diff --function-context`), because it sees no other code.
- Clef is deterministic, but a harmless rewrite of a diff (files reordered, `index` lines dropped)
  moves one call's points by up to 3. Each fork is asked in both file orders and averaged, which
  moved by at most 0.54 (Oct 7: 38 forks of 10 races). Forks equal on tests and claims and within
  `JUDGE_TIE` (0.75) on Clef's points tie: Clef's side-by-side choice (`compare.ts`), then the
  smaller diff among the forks near its favorite, then the earlier finish. Re-measure before
  changing questions or `JUDGE_TIE` (the replay scripts are described in `docs/api-notes.md`).
- After the winner is picked, the fusion round (`fusion.ts`) tries the losers' files and hunks on
  top of it, and the ship (`ship/`) merges, with a conflict race when the source moved on.

To check real results, the read routes are public: `GET /tasks`, `/tasks/:id/judge` (scores, raw
Clef answers, the why), `/tasks/:id/forks/:agent/diff`. `cf ai run @cf/cloudflare/clef --body @file.json`
replays a Clef request.

## Working method

- Big features (a PLAN day) go through the harness: `harness/tasks/<name>.md` + `.ts`, run with
  `node --env-file=.env harness/run.ts <name>`. Close to the deadline, ask first; the user often
  prefers a direct change plus a review and a live race.
- Verify behavior in a real race, not only in tests: `/play`, or
  `node --env-file=.env scripts/race.mjs <bugs|ui|clash|clash-full|fusion>` (`AGENTS=5` for 5 robots).
  Demo apps are in `demo/`; their prompts are in `demo/README.md` and `src/ui/playpage.ts`.
