// Push events + Workers Previews (PLAN.md Day 5). Graph: harness/tasks/push.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "preview API policy",
    owns: ["src/sandbox/policy.ts", "src/sandbox/outbound.ts", "test/policy.test.ts"],
    tests: ["test/policy.test.ts"],
    required: ["R1", "R2"],
    maxAttempts: 4,
    brief:
      "Preview sandboxes run `wrangler preview`, which calls api.cloudflare.com. Add an optional preview-API grant to OutboundProps: the account id and the preview Worker name. " +
      "In decideOutbound: for host api.cloudflare.com, allow only when the props carry the grant, the method is GET or POST, and the URL path is exactly under `/client/v4/accounts/<account>/workers/workers/<worker>/previews` (the prefix itself, or the prefix followed by `/`). Then set `authorization: Bearer <preview token>`. Everything else to that host is refused, including agent sandboxes. " +
      "The preview token comes from the Worker env (CLOUDFLARE_PREVIEW_TOKEN), passed in by outbound.ts the same way the model API key is today; decideOutbound must see the request method, so pass it in. Trim the token like the model key. " +
      "Keep all existing behavior and tests for git and the model API unchanged. Tests cover traversal attempts (`..`, encoded `%2e%2e`, double slashes), another account, another Worker, and PUT/DELETE.",
  },
  {
    id: "N3",
    title: "push core",
    owns: ["src/push/push.ts", "test/push.test.ts"],
    tests: ["test/push.test.ts"],
    required: ["R3", "R4", "R5"],
    maxAttempts: 4,
    brief:
      "Write src/push/push.ts, pure (no cloudflare:workers import). " +
      "`parsePushEvent(event)`: from the Artifacts event envelope (type cf.artifacts.repo.pushed; source.namespace, source.repoName; payload.ref, before, after, commits[], totalCommitsCount), return the task id, agent, ref, after, commit count and the newest commit message, or undefined when the repo is not a task fork (use the inverse of forkName in src/artifacts/repo.ts and isAgentName in src/agents/prompt.ts), the namespace is not the expected one, or the ref is not refs/heads/main. Validate the shape; never throw on bad input. " +
      "`previewName(taskId, agent)`: DNS-safe, stable, and short enough that `<name>-<worker>` fits in one 63-character DNS label for the preview Worker name. " +
      "`previewConfig(worker, compatibilityDate)`: the JSON text of Thunderdome's wrangler config for previews (name, main `repo/src/index.ts` relative to the config file in /workspace, compatibility_date, `previews: {}`). " +
      "`previewUrl(stdout)`: the first URL in `.preview.urls` of wrangler's --json output, only an https URL; undefined for anything else.",
  },
  {
    id: "N4",
    title: "push Workflow",
    owns: ["src/room/task.ts", "src/push/PushWorkflow.ts", "src/index.ts", "wrangler.jsonc", "Dockerfile", "test/task.test.ts"],
    tests: ["test/task.test.ts"],
    required: ["R6", "R7"],
    maxAttempts: 5,
    regenTypes: true,
    brief:
      "In src/room/task.ts (pure, unit tested): each agent slot gets push state: commit count, last push time, newest head commit, its message, and the preview URL with the commit it was built from. " +
      "`applyPush` records a push once per `after` commit (event retries repeat it) and keeps the newest head by push order; `applyPreview` saves a URL only when its commit is the slot's newest head, so an older preview never replaces a newer one. " +
      "Write src/push/PushWorkflow.ts: a WorkflowEntrypoint (cloudflare:workers) whose payload is the Artifacts event. Steps: parse it with src/push/push.ts (not a task fork → end); record the push in the TaskRoom; if that commit is still the agent's newest head, build the preview in a sandbox: clone the fork with a short-lived read token (see JudgeWorkflow for the pattern), write /workspace/preview.jsonc from previewConfig, run `wrangler preview -c /workspace/preview.jsonc --name <previewName> --json` with CLOUDFLARE_API_TOKEN set to a placeholder (the outbound proxy sets the real header) and CLOUDFLARE_ACCOUNT_ID, with outbound props carrying the preview-API grant from src/sandbox/policy.ts; then save the URL in the TaskRoom; stop the sandbox. Add the TaskRoom methods it calls (record push, save preview) as thin wrappers over task.ts. " +
      "Export PushWorkflow from src/index.ts. In wrangler.jsonc: a `triggers.events` entry for cf.artifacts.repo.pushed, filter namespace `thunderdome`, targeting Workflow `thunderdome-push` (follow docs/api-notes.md; note in a comment that the docs disagree on the syntax); a `workflows` binding PUSH for class PushWorkflow; PushWorkflow in `exports` like JudgeWorkflow; vars PREVIEW_WORKER = \"thunderdome-sample\" and CF_ACCOUNT_ID = \"bc1c0551f58de19c91a2d34f1a75e97c\"; CLOUDFLARE_PREVIEW_TOKEN in secrets.required. " +
      "In the Dockerfile, install wrangler globally, pinned to the version in package.json. Code regenerates worker-configuration.d.ts after you write wrangler.jsonc.",
  },
  {
    id: "N5",
    title: "live WebSocket + mid-race push",
    owns: ["src/room/TaskRoom.ts", "src/routes/tasks.ts", "src/agents/prompt.ts", "test/agents.test.ts", "test/tasks-route.test.ts", "README.md"],
    tests: ["test"],
    required: ["R8"],
    maxAttempts: 4,
    brief:
      "TaskRoom accepts WebSockets with the hibernation API (ctx.acceptWebSocket) and sends every change to all of them as one JSON message: agent steps, claims, pushes, previews, agent ends, and the verdict, each with a kind and the task id. Sending must never break the change itself (a dead socket is dropped). " +
      "Add route `GET /tasks/:id/live` (WebSocket upgrade, same auth as the other task routes) that hands the request to the TaskRoom; a request without `Upgrade: websocket` gets 426. " +
      "In src/agents/prompt.ts, tell agents to commit and push after each working step (`git push origin HEAD:refs/heads/main`), because every push builds a live preview; the runner still commits and pushes what is left at the end. " +
      "Update the README run steps: how to watch a race live (a WebSocket client on /tasks/:id/live) and where the preview URLs appear in GET /tasks/:id. The check for this step is the full test suite.",
  },
];

export const task: TaskGraph = {
  branch: "harness/push",
  nodes,
  planTask:
    "Plan Thunderdome's push events and Workers Previews (PLAN.md Day 5), with agents pushing mid-race. " +
    "Read PLAN.md, docs/api-notes.md (especially \"Workers Previews\"), harness/tasks/push.md, src/sandbox/policy.ts, src/sandbox/outbound.ts, src/sandbox/ThunderdomeSandbox.ts, src/artifacts/repo.ts, src/agents/prompt.ts, " +
    "src/room/task.ts, src/room/TaskRoom.ts, src/judge/JudgeWorkflow.ts, src/routes/tasks.ts, src/index.ts, wrangler.jsonc, Dockerfile, test/policy.test.ts and test/task.test.ts, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts"],
};
