// The task routes. The caller checks admin auth first.
import { judgeInstanceId } from "../judge/judge";
import { RACE_INDEX_MAX, RACE_INDEX_NAME, RACE_LIST_LIMIT, summaryOf } from "../room/races";
import { isTaskId, judgeInput, newTaskId, parseCreateTask } from "../room/task";
import { isForkAgent, isShotPath } from "./access";
import { commitResponse, isCommitSha } from "./commits";

// The room starts the judge with the same params, so both come from one place.
export { judgeInput } from "../room/task";

const JUDGE_PATH = /^\/tasks\/([^/]+)\/judge$/;
/** The one RaceIndex instance. */
/** Ids one backfill call may record. */
const MAX_BACKFILL_IDS = 50;

type TasksEnv = Pick<Env, "TASK_ROOM" | "RACE_INDEX" | "ARTIFACTS">;

/** True for /tasks and every route under it. */
export function isTasksPath(pathname: string): boolean {
  return pathname === "/tasks" || pathname.startsWith("/tasks/");
}

/** Task id when the path is exactly /tasks/:id/judge with a valid id, else undefined. */
export function judgeTaskId(pathname: string): string | undefined {
  const id = JUDGE_PATH.exec(pathname)?.[1];
  return id !== undefined && isTaskId(id) ? id : undefined;
}

/**
 * The /tasks routes: list and create races, read one, run it, and its forks, diffs, commits,
 * steps and claims. The caller checks admin auth first.
 */
export async function handleTasks(request: Request, env: TasksEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/tasks") {
    // The race list, newest first.
    if (request.method === "GET") return Response.json({ races: await env.RACE_INDEX.getByName(RACE_INDEX_NAME).list(RACE_LIST_LIMIT) });
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    return createTask(request, env);
  }
  const [id = "", action, ...rest] = pathname.slice("/tasks/".length).split("/");
  if (!isTaskId(id)) return notFound();
  // /tasks/:id/forks/:agent/diff
  const [agent = "", leaf] = rest;
  if (action === "forks" && rest.length === 2 && leaf === "diff" && isForkAgent(agent)) return forkDiff(request, env, id, agent);
  // /tasks/:id/commits/:sha
  if (action === "commits" && rest.length === 1 && isCommitSha(agent)) return verdictCommit(request, env, id, agent);
  // /tasks/:id/shots/:agent/<desktop|phone>.jpg
  if (action === "shots" && isShotPath(pathname)) return lookShot(request, env, id, agent, (leaf ?? "").replace(/\.jpg$/, ""));
  if (rest.length > 0) return notFound();
  const room = env.TASK_ROOM.getByName(id);
  if (action === undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    // Carries task.verdict once the judge has saved it.
    const task = await room.state();
    return task === null ? notFound() : Response.json(task);
  }
  if (action === "run") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const result = await room.run();
    return result.ok ? Response.json(result.task, { status: 202 }) : Response.json(result.error, { status: result.status });
  }
  if (action === "live") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return upgradeRequired();
    // The room accepts the socket and sends every change on it.
    return room.fetch(request);
  }
  if (action === "claims") {
    if (request.method === "GET") return Response.json(await room.claimBoard());
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    const body = await jsonObject(request);
    if (body === undefined) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    if (typeof body.agent !== "string") return Response.json({ error: "agent must be a string" }, { status: 400 });
    const result = await room.claim(body.agent, body.files, body.shared === true);
    return Response.json(result, { status: result.ok ? 200 : result.status });
  }
  if (action === "release") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const body = await jsonObject(request);
    if (body === undefined || typeof body.agent !== "string") {
      return Response.json({ error: "Body must be { agent, files? }" }, { status: 400 });
    }
    const result = await room.release(body.agent, body.files);
    return Response.json(result, { status: result.ok ? 200 : result.status });
  }
  if (action === "steps") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const params = new URL(request.url).searchParams;
    const after = toInteger(params.get("after"), 0);
    const steps = await room.steps(after, toInteger(params.get("limit"), 200));
    return Response.json({ steps, next: steps.at(-1)?.seq ?? after });
  }
  return notFound();
}

/** GET /tasks/:id/forks/:agent/diff: the diff the judge scored for the fork, once it saved one. */
async function forkDiff(request: Request, env: TasksEnv, id: string, agent: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const saved = await env.TASK_ROOM.getByName(id).forkDiff(agent);
  return saved === null ? notFound() : Response.json({ agent, diff: saved.diff, clipped: saved.clipped });
}

/** GET /tasks/:id/shots/:agent/:kind.jpg: a screenshot the look step kept. Shots never change, so a found one is cached for good. */
async function lookShot(request: Request, env: TasksEnv, id: string, agent: string, kind: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const body = await env.TASK_ROOM.getByName(id).shot(agent, kind);
  if (body === null) return notFound();
  return new Response(body, { headers: { "content-type": "image/jpeg", "content-length": String(body.byteLength), "cache-control": "public, max-age=31536000, immutable" } });
}

/** GET /tasks/:id/commits/:sha: the fusion commit or the merge the verdict names, read from Artifacts. */
async function verdictCommit(request: Request, env: TasksEnv, id: string, sha: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const task = await env.TASK_ROOM.getByName(id).state();
  return task === null ? notFound() : commitResponse(env.ARTIFACTS, task, sha);
}

/** POST /admin/races: records races made before the index. Unknown ids come back in missing. */
export async function handleRaceBackfill(request: Request, env: TasksEnv): Promise<Response> {
  const ids = backfillIds(await jsonObject(request));
  if (ids === undefined) return Response.json({ error: `Body must be { ids: 1..${MAX_BACKFILL_IDS} task ids }` }, { status: 400 });
  const index = env.RACE_INDEX.getByName(RACE_INDEX_NAME);
  const recorded: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const room = env.TASK_ROOM.getByName(id);
    const state = await room.state();
    if (state === null) {
      missing.push(id);
      continue;
    }
    await index.record(summaryOf(state, (await room.claimBoard()).history));
    recorded.push(id);
  }
  return Response.json({ recorded, missing });
}

/**
 * POST /admin/purge: deletes races for good: their repos, their room state, and their place in
 * the race list. { ids } purges those ids; an empty body purges every race in the list. A race
 * still running or being judged is skipped, as is one whose repos fail to delete.
 */
export async function handlePurge(request: Request, env: TasksEnv): Promise<Response> {
  const body = await jsonObject(request);
  const index = env.RACE_INDEX.getByName(RACE_INDEX_NAME);
  const ids = body === undefined || body.ids === undefined ? (await index.list(RACE_INDEX_MAX)).map((race) => race.id) : backfillIds(body);
  if (ids === undefined) return Response.json({ error: `Body must be {} or { ids: 1..${MAX_BACKFILL_IDS} task ids }` }, { status: 400 });
  const purged: { id: string; deleted: string[] }[] = [];
  const skipped: { id: string; error: string }[] = [];
  // One room at a time, so a big purge does not flood Artifacts with deletes.
  for (const id of ids) {
    const result = await env.TASK_ROOM.getByName(id).purge();
    if (result.ok) purged.push({ id, deleted: result.deleted });
    else skipped.push({ id, error: result.error });
  }
  if (purged.length > 0) await index.remove(purged.map((p) => p.id));
  return Response.json({ purged, skipped });
}

/** The unique ids in first-seen order, or undefined when the body is not { ids: 1..50 task ids }. */
function backfillIds(body: Record<string, unknown> | undefined): string[] | undefined {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BACKFILL_IDS) return undefined;
  if (!ids.every((id): id is string => typeof id === "string" && isTaskId(id))) return undefined;
  return [...new Set(ids)];
}

/** POST starts the judge on a finished task; GET returns its status and output. */
export async function handleJudge(request: Request, env: Pick<Env, "TASK_ROOM" | "JUDGE">, id: string): Promise<Response> {
  if (request.method === "POST") return startJudge(env, id);
  if (request.method !== "GET") return methodNotAllowed("GET, POST");
  const instance = await judgeInstance(env, id);
  if (instance === undefined) return Response.json({ error: "not judged yet" }, { status: 404 });
  return Response.json({ id: instance.id, ...(await instance.status()) });
}

/** The room starts the judge on its own; this is the manual start for when it did not. */
async function startJudge(env: Pick<Env, "TASK_ROOM" | "JUDGE">, id: string): Promise<Response> {
  const room = env.TASK_ROOM.getByName(id);
  const task = await room.state();
  if (task === null) return notFound();
  if (task.status !== "finished") {
    return Response.json({ error: `Task is ${task.status}; only a finished task can be judged` }, { status: 409 });
  }
  const existing = await judgeInstance(env, id);
  if (existing !== undefined) return alreadyJudged(existing);
  const params = judgeInput(task, await room.claimBoard());
  try {
    const instance = await env.JUDGE.create({ id: judgeInstanceId(id), params });
    return Response.json({ id: instance.id, status: "queued" }, { status: 202, headers: { location: `/tasks/${id}/judge` } });
  } catch (cause) {
    // The room may have started it between the lookup and the create.
    const started = await judgeInstance(env, id);
    if (started === undefined) throw cause;
    return alreadyJudged(started);
  }
}

async function alreadyJudged(instance: WorkflowInstance): Promise<Response> {
  const { status } = await instance.status();
  return Response.json({ error: "Task is already judged or being judged", id: instance.id, status }, { status: 409 });
}

/** The task's judge instance, or undefined when none was started. */
async function judgeInstance(env: Pick<Env, "JUDGE">, id: string): Promise<WorkflowInstance | undefined> {
  try {
    return await env.JUDGE.get(judgeInstanceId(id));
  } catch {
    return undefined;
  }
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toInteger(value: string | null, fallback: number): number {
  const parsed = Number(value ?? undefined);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function notFound(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

async function createTask(request: Request, env: Pick<Env, "TASK_ROOM">): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const input = parseCreateTask(body);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  const id = newTaskId();
  const result = await env.TASK_ROOM.getByName(id).create({ id, ...input });
  if (!result.ok) return Response.json(result.error, { status: result.status });
  const { task, tokens } = result;
  // The only response that carries the fork write tokens.
  return Response.json(
    { ...task, agents: task.agents.map((agent) => ({ ...agent, token: tokens[agent.name] })) },
    { status: 201, headers: { location: `/tasks/${id}` } },
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow } });
}

function upgradeRequired(): Response {
  return Response.json({ error: "Expected Upgrade: websocket" }, { status: 426, headers: { upgrade: "websocket" } });
}
