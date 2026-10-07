# API notes (checked Oct 4, 2026)

Source: the type files in `@cloudflare/workers-types@5.20261004.1`, `wrangler@4.147.0`, and
`@cloudflare/sandbox@1.0.0`, plus the `cloudflare/sandbox-sdk` examples. The docs site was not
reachable from the build machine, so check the open items below on a real account.

## Artifacts binding

`wrangler.jsonc`:

```jsonc
"artifacts": [{ "binding": "ARTIFACTS", "namespace": "thunderdome" }]
```

Namespace calls (`env.ARTIFACTS`):

| Method | Notes |
|---|---|
| `create(name, { description?, readOnly?, setDefaultBranch? })` | Returns `{ id, name, remote, defaultBranch, token }`. `ALREADY_EXISTS` if taken. |
| `get(name)` | Returns an `ArtifactsRepo` handle (RPC stub; use `using`). Throws `*_IN_PROGRESS` while a create, import or fork runs. |
| `import({ source: { url, branch?, depth? }, target: { name, opts? } })` | HTTPS git remote only. Private remotes give `REMOTE_AUTH_REQUIRED`. |
| `list({ limit?, cursor? })` | 1–200 per page. |
| `delete(name)` | Deletes repo and its tokens. |

Repo calls (`await env.ARTIFACTS.get(name)`):

| Method | Notes |
|---|---|
| `fork(name, { description?, readOnly?, defaultBranchOnly? })` | `defaultBranchOnly` is `true` by default. Returns a write token for the fork. |
| `createToken(scope = "write", ttl = 86400)` | ttl 60 s .. 1 year. Plaintext only at creation. |
| `listTokens()` / `revokeToken(tokenOrId)` | Revoke = lock a fork as a record. |
| `info()` | Includes `remote`, `readOnly`, `source`, `lastPushAt`. |
| `log({ ref?, limit?, offset? })` | First-parent history, newest first. |
| `readCommit(hash)`, `readTree(hash)`, `readBlob(hash)`, `readFile({ ref, path })` | Read-only access. The judge can read diffs' files without a clone. |

Errors are `ArtifactsError` with a string `code`: `ALREADY_EXISTS`, `NOT_FOUND`,
`CREATE_IN_PROGRESS`, `IMPORT_IN_PROGRESS`, `FORK_IN_PROGRESS`, `INVALID_INPUT`,
`INVALID_REPO_NAME`, `INVALID_TTL`, `INVALID_URL`, `REMOTE_AUTH_REQUIRED`,
`UPSTREAM_UNAVAILABLE`, `MEMORY_LIMIT`, `INTERNAL_ERROR`.

**Not in the binding:** merge, diff, compare, set read-only after creation.
So: Thunderdome merges the winner with git in a sandbox, and locks losers by revoking write tokens.

## Artifacts events (push events)

Events go to a **Workflow**, not a Queue. `wrangler.jsonc`:

```jsonc
"triggers": {
  "events": [{
    "type": "cf.artifacts.repo.pushed",
    "filter": { "namespace": "thunderdome" },          // optional; also repo_name
    "targets": [{ "type": "workflow", "workflow_name": "thunderdome-push" }]
  }]
}
```

Event types: `cf.artifacts.repo.created`, `.deleted`, `.forked`, `.imported`, `.pushed`,
`.cloned`, `.fetched`, `.token.created`, `.token.revoked`.

## Sandbox (`@cloudflare/sandbox@1.0.0`)

1.0 is a new shape: **your own Durable Object** owns the container (`this.ctx.container`).
The package gives only `Files`, `S3Mount`, `DirectoryBackup`.

- Config: a `durable_objects` binding + `containers[{ class_name, scheduling_policy: "durable_object", images: { sandbox: { dockerfile } } }]` + `exports[class] = { type: "durable-object", storage: "sqlite" }`. Needs `nodejs_compat`.
- Image must contain `/usr/local/bin/sandbox-shim` (copy from `docker.io/cloudflare/sandbox:1.0.0`).
- `container.start({ image, instance, enableInternet: false, labels })`, then `container.exec(argv, { cwd, env })` → `process.output()`.
- Network control: `container.interceptAllOutboundHttp(fetcher)` and `interceptOutboundHttps("*", fetcher)`. The fetcher is `ctx.exports.Outbound({ props })`, so **tokens stay in the Worker**. Intercepts last for one container run.
- `exec()` does not inherit `start()` env. Pass the CA env (`GIT_SSL_CAINFO` etc. → `/etc/cloudflare/certs/cloudflare-containers-ca.crt`) on every exec that uses HTTPS.
- A running process does not keep the container awake; requests do. Use a DO alarm to poll a long agent run.
- Claude Code in a sandbox: `claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model <m> -- <prompt>` with `IS_SANDBOX=1`, `ANTHROPIC_BASE_URL` = AI Gateway, placeholder API key replaced by the Outbound Worker. See `examples/coding-agents/claude-code` in `cloudflare/sandbox-sdk`.
- `wrangler deploy` (even `--dry-run`) needs Docker to build the image.

## Agent runs (Day 3)

From `examples/coding-agents` in `cloudflare/sandbox-sdk` (read Oct 4):

- Image: `npm install --global @anthropic-ai/claude-code@2.1.280`. Do not skip install scripts.
- Env: `ANTHROPIC_API_KEY` placeholder (the Outbound Worker sets the real `x-api-key`),
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no update check, telemetry, or error reports),
  `IS_SANDBOX=1` (root + `--dangerously-skip-permissions`).
- Outcome: read `is_error` on the last `result` event. A failed model call still has
  `subtype: "success"`. Claude Code retries most failing calls up to 10 times, but the real API's
  `401` carries `x-should-retry: false`, so a bad key fails in seconds with
  "Invalid API key · Fix external API key". Check the Worker's key with `GET /admin/model-check`.
- Run in the background with output to files, then poll from a DO alarm. Thunderdome wraps the agent in
  `setsid --wait`, so a timeout can kill the whole process group (agent + test runs).

## Thunderdome API from the sandbox (Day 4)

The Cloudflare examples intercept only real host names, and we do not know that a made-up name
(like `thunderdome.internal`) resolves in the sandbox. So agents call `https://<git host>/_thunderdome/...`:
the git host resolves (proven on Day 1), and the Outbound Worker answers `/_thunderdome/` itself.
`decideOutbound` refuses that path, so the git token is never sent there. The agent name and task
come from the Outbound props, so an agent cannot claim as another agent.

## Open items (check on a real account)

1. ~~Git auth header for Artifacts remotes.~~ **Resolved:** `Authorization: Bearer <token>` works
   (`src/sandbox/policy.ts`, `gitAuthHeader`). Confirmed live on Oct 4 by the push of `7ea60c52`.
2. ~~Workers Previews: how a preview is made per fork push.~~ **Resolved Oct 4 (spike):** see "Workers Previews" below.
3. How fast a fresh fork accepts a clone. The spike retries the clone 10× with 2 s waits.

## Workers Previews (spike, Oct 4)

Workers Builds is not the way: it connects one repo per Worker in the dashboard only (no API), and it treats
`main` as production, while every fork pushes to its own `main`. Instead Thunderdome runs `wrangler preview` itself:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  wrangler preview -c preview.jsonc --name <task>-<agent> --json   # URL in .preview.urls[0]
wrangler preview delete -c preview.jsonc --name <task>-<agent> --skip-confirmation
```

- Config is Thunderdome's, not the repo's, so agents' forks need no Wrangler file:
  `{ "name": "thunderdome-sample", "main": "repo/src/index.ts", "compatibility_date": "...", "previews": {} }`.
  Without the `previews` block wrangler refuses ("configuration is missing a previews block").
- URL: `https://<name>-thunderdome-sample.git-bc1.workers.dev`. Served 200 at once; the whole command took ~2 s.
- Limits: 500 Previews per Worker on Paid (oldest deleted first), 100 deployments per Preview.
- Token: custom token, Account → Workers Scripts: Edit (`CLOUDFLARE_PREVIEW_TOKEN` in `.env`).
- API calls once the `thunderdome-sample` Worker exists (the first run also made it with `POST .../workers/workers`):
  - `GET  /client/v4/accounts/<acct>/workers/workers/thunderdome-sample/previews/<name>` (404 when new)
  - `POST /client/v4/accounts/<acct>/workers/workers/thunderdome-sample/previews`
  - `POST /client/v4/accounts/<acct>/workers/workers/thunderdome-sample/previews/<id>/deployments`
  So the outbound proxy can allow only GET/POST under `.../workers/workers/thunderdome-sample/previews`.

Push event envelope (Queues "Events & schemas" page): `source.namespace`, `source.repoName`, and
`payload.{ref, before, after, commits[], totalCommitsCount, commitsTruncated}`. No changed files.
The trigger syntax differs between docs: `targets: [{ type, workflow_name }]` with `repo_name` (above) vs
`target: { scriptName, workflowName }` with `repoName` (Artifacts "build and deploy on push" guide). Check on deploy.

## Clef noise and a replay of old races (Oct 7)

Measured with `scripts/clef-replay/` on 38 forks of the last 10 races judged before the shared suite
(`t-ad3ea63d` to `t-a0f9482a`), using the function-context diff of each fork's last own commit:

```sh
D=<scratch>/replay
scripts/clef-replay/build.sh $D
node scripts/clef-replay/collect.mjs $D t-a0f9482a t-40462f22 ...   # needs a cf login: read tokens per fork
node scripts/clef-replay/clef.mjs $D                                 # 6 Clef calls per fork, resumable
node scripts/clef-replay/analyze.mjs $D                              # noise, then each race replayed
```

- **Noise.** Each fork was asked six harmless variants: both file orders, each with `index` lines
  dropped, and each with `files_changed` reversed. One call's judgment points moved by up to 3.00
  (median 0.73, p90 1.23). The judge's two-order average moved by at most 0.54 (median 0.18, p90
  0.34). `JUDGE_TIE` went from 1.5 to 0.75: about 1.4× the largest move.
- **Ties everywhere at 1.5.** All 10 replayed races tied at the top at 1.5; at 0.75, 8 still do.
  Forks that pass the same tests really are within a point of each other on Clef's ratings, so the
  side-by-side comparison decides most races.
- **Diff size picked the comparison's last place.** In `t-32ddd54f` Snip had 2.6% of the
  side-by-side vote but won on the smallest diff, because the vote's top two were within
  `PREFER_MARGIN`. Now only the forks within `PREFER_MARGIN` of the vote's favorite go on to diff size.
- **Winners, old judge vs new questions** (tests and claims as recorded; the shared suite was not
  rerun). At `JUDGE_TIE` 1.5, 6 of 10 changed: `t-4d3802e7` sparkle→snip, `t-7060d8ea` zippy→ponder,
  `t-827f96d6` ponder→testy, `t-a0f9482a` snip→testy, `t-a5f29435` zippy→ponder, `t-ad3ea63d`
  testy→ponder. Most of the change comes from the side-by-side comparison, which the old judge did
  not have.

## Containers: instance limit

`ThunderdomeSandbox` uses `scheduling_policy: "durable_object"`, which has no `max_instances`:
Wrangler rejects the field, and running instances count only toward the account limits (1,500 vCPU,
6 TiB memory). The 20 default applies to the default policy only (Cloudflare Containers docs,
"Scheduling Policies"; checked Oct 7, and `wrangler containers info` shows `max_instances: null`).
One 5-robot race uses up to about 10 at once: 5 agent sandboxes plus a preview build per push.
Judging uses 5 more, after the agents stop. On `t-2003c1f7` a preview build lost its container
("container connection is temporarily unavailable") with about 20 in use; there is no cap at 20, so
the cause is unexplained. A per-app cap would have to be enforced in code.
