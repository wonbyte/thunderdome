// The Thunderdome Worker: routes every request, checks who may call it, and exports the
// Durable Objects, Workflows and the Outbound Worker that wrangler.jsonc binds.

import { isArtifactsError, isRepoName } from "./artifacts/repo";
import { accessFor, pageAsset } from "./routes/access";
import { modelCheck } from "./routes/admin";
import { handlePlay, isPlayPath } from "./routes/play";
import { handleJudge, handlePurge, handleRaceBackfill, handleTasks, isTasksPath, judgeTaskId } from "./routes/tasks";
import { CommandError } from "./sandbox/ThunderdomeSandbox";
import { isDemoApp, runDay1, seedSample } from "./spike";

export { ThunderdomeSandbox } from "./sandbox/ThunderdomeSandbox";
export { Outbound } from "./sandbox/outbound";
export { TaskRoom } from "./room/TaskRoom";
export { RaceIndex } from "./room/RaceIndex";
export { PlayQuota } from "./play/PlayQuota";
export { JudgeWorkflow } from "./judge/JudgeWorkflow";
export { PushWorkflow } from "./push/PushWorkflow";

const ROUTES = {
  "POST /spike/seed": "Create a repo and push a demo app (once): { repo?, app? }, default thunderdome-sample with sample-app. Apps are the folders in demo/.",
  "POST /spike/day1": "Seed, fork, push from a sandbox, and read the commit back.",
  "GET /tasks": "The race list, newest first (at most 50). No auth.",
  "POST /tasks": "Create a task: { repo | template, prompt, agents: 3..5 }. A template is forked into a fresh source repo <template>-<id> first. Returns 1 fork and 1 write token per agent.",
  "GET /tasks/:id": "Task state (no tokens). Once judged, verdict holds the winner, the why and the merge result. No auth.",
  "POST /tasks/:id/run": "Start every agent at once, each in its own sandbox on its own fork. When every agent ends, the judge and the merge start on their own.",
  "GET /tasks/:id/steps?after=<seq>": "The agents' step log, oldest first. No auth.",
  "GET /tasks/:id/claims": "The claim board: active claims and history. No auth.",
  "POST /tasks/:id/claims": "Claim files for an agent: { agent, files, shared? }. Files others hold are claimed as shared and listed in clashes.",
  "POST /tasks/:id/release": "Release an agent's files: { agent, files? }.",
  "GET /tasks/:id/live": "WebSocket of live task events: a snapshot, then every change. No auth.",
  "POST /tasks/:id/judge": "Start the judge by hand on a finished task if it did not start on its own. 409 when it exists.",
  "GET /tasks/:id/judge": "The judge's status and, when done, its output: scores, why and the ship result. No auth.",
  "GET /tasks/:id/forks/:agent/diff": "The diff the judge scored for an agent's fork: { agent, diff, clipped }. 404 before the judge saved it. No auth.",
  "POST /play": "Start a 5-agent race on a demo template: { template, prompt, invite? }. Daily quota; 202 { id, page, remaining }. No auth.",
  "GET /play/quota": "Today's play quota: { day, used, limit, remaining, invite }. No auth.",
  "GET /play": "The run-your-own-race page. No auth.",
  "GET /race/:id": "The live race page for a task. No auth; the read routes it uses are public too.",
  "GET /races": "The race gallery page. No auth.",
  "POST /admin/races": "Add races from before the index: { ids }.",
  "POST /admin/purge": "Delete races for good (repos, state, race list entry): { ids } or {} for every listed race. Running races are skipped.",
  "GET /admin/model-check": "Test the Worker's model key against the model API. Shows the key type and length, never the key.",
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const access = accessFor(request.method, url.pathname);
    // A page is a static file; a task id stays in the URL for the page script.
    if (access === "page") {
      const asset = pageAsset(url.pathname);
      if (asset !== undefined) return env.ASSETS.fetch(new URL(asset, request.url));
    }
    // A browser at the root lands on the gallery; API clients still get the route list.
    if (route === "GET /") {
      if (request.headers.get("accept")?.includes("text/html")) return Response.redirect(new URL("/races", request.url).toString(), 302);
      return Response.json({ name: "thunderdome", routes: ROUTES });
    }
    const tasks = isTasksPath(url.pathname);
    const play = isPlayPath(url.pathname);
    if (!tasks && !play && !(route in ROUTES)) return Response.json({ error: "not found" }, { status: 404 });
    if (access === "admin" && !(await authorized(request, env))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    try {
      const judgeId = judgeTaskId(url.pathname);
      if (judgeId !== undefined) return await handleJudge(request, env, judgeId);
      if (tasks) return await handleTasks(request, env);
      if (play) return await handlePlay(request, env);
      if (route === "POST /admin/races") return await handleRaceBackfill(request, env);
      if (route === "POST /admin/purge") return await handlePurge(request, env);
      if (route === "GET /admin/model-check") return await modelCheck(env);
      if (route === "POST /spike/seed") return await seed(request, env);
      if (route === "POST /spike/day1") return Response.json(await runDay1(env));
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (cause) {
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<Env>;

async function seed(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => ({}));
  const { repo, app } = typeof body === "object" && body !== null ? (body as { repo?: unknown; app?: unknown }) : {};
  if (repo !== undefined && (typeof repo !== "string" || !isRepoName(repo))) {
    return Response.json({ error: "repo must be an Artifacts repo name" }, { status: 400 });
  }
  if (app !== undefined && (typeof app !== "string" || !isDemoApp(app))) {
    return Response.json({ error: "app must be a folder in demo/" }, { status: 400 });
  }
  return Response.json(await seedSample(env, repo, app));
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const encoder = new TextEncoder();
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.ADMIN_TOKEN}`)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}

function errorResponse(cause: unknown): Response {
  if (isArtifactsError(cause)) {
    return Response.json({ error: cause.message, code: cause.code }, { status: 502 });
  }
  if (cause instanceof CommandError) {
    return Response.json(
      { error: cause.message, argv: cause.argv, stderr: cause.result.stderr },
      { status: 500 },
    );
  }
  console.error(cause);
  return Response.json({ error: String(cause) }, { status: 500 });
}
