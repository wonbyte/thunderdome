// The public play routes: POST /play starts a 3-agent race on a demo template, GET /play/quota
// shows today's quota. No admin auth; a daily quota (and an invite code when set) guards them.
import { PLAY_AGENTS, parsePlay, playDailyLimit, utcDay } from "../play/play";
import type { PlayQuota } from "../play/PlayQuota";
import { newTaskId } from "../room/task";

// The one PlayQuota instance.
export const PLAY_QUOTA_NAME = "daily";

export type PlayEnv = Pick<Env, "TASK_ROOM"> & {
  PLAY_QUOTA: DurableObjectNamespace<PlayQuota>;
  PLAY_INVITE?: string;
  PLAY_DAILY_LIMIT?: string;
};

export function isPlayPath(pathname: string): boolean {
  return pathname === "/play" || pathname === "/play/quota";
}

export async function handlePlay(request: Request, env: PlayEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const day = utcDay(new Date());
  const limit = playDailyLimit(env.PLAY_DAILY_LIMIT);
  const invite = env.PLAY_INVITE ?? "";
  if (pathname === "/play/quota") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const view = await env.PLAY_QUOTA.getByName(PLAY_QUOTA_NAME).view(day, limit);
    return Response.json({ ...view, invite: invite !== "" });
  }
  if (request.method !== "POST") return methodNotAllowed("POST");
  return startPlay(request, env, day, limit, invite);
}

// Checks the input, takes the quota, then creates and runs the task. A failed create or run
// does not give the play back. The fork tokens are never read into the response.
async function startPlay(request: Request, env: PlayEnv, day: string, limit: number, invite: string): Promise<Response> {
  const input = parsePlay(await request.json().catch(() => undefined), invite);
  if ("error" in input) return Response.json({ error: input.error }, { status: input.status });
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const taken = await env.PLAY_QUOTA.getByName(PLAY_QUOTA_NAME).take(day, ip, limit);
  if (!taken.ok) {
    const error = taken.reason === "daily" ? "Today's play quota is used up" : "This IP has used its plays for today";
    return Response.json({ error, reason: taken.reason }, { status: 429 });
  }
  const id = newTaskId();
  const room = env.TASK_ROOM.getByName(id);
  const created = await room.create({ id, template: input.template, prompt: input.prompt, agents: PLAY_AGENTS });
  if (!created.ok) return Response.json(created.error, { status: created.status });
  const run = await room.run();
  if (!run.ok) return Response.json(run.error, { status: run.status });
  return Response.json({ id, page: `/race/${id}`, remaining: taken.remaining }, { status: 202 });
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow } });
}
