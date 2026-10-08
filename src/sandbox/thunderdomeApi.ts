// The Thunderdome API that an agent calls from its sandbox (see the claim CLI in image/claim.mjs).
// The agent's identity comes from the Outbound props, never from the request.
import type { ClaimBoard, ClaimResult } from "../room/claims";
import { coloOf, traceColo } from "../room/regions";
import { THUNDERDOME_API_PREFIX, type OutboundProps } from "./policy";

/** The TaskRoom methods this API uses. */
export interface ClaimRoom {
  claim(agent: string, files: unknown, shared: boolean): ClaimResult | Promise<ClaimResult>;
  release(agent: string, files?: unknown): { ok: boolean } | Promise<{ ok: boolean }>;
  claimBoard(): ClaimBoard | Promise<ClaimBoard>;
}

/**
 * Answers an agent's claim, release and board calls, and where its sandbox runs. The agent comes from the Outbound props, never
 * from the request.
 */
export async function handleThunderdomeApi(request: Request, props: OutboundProps, roomFor: (taskId: string) => ClaimRoom): Promise<Response> {
  if (new URL(request.url).protocol !== "https:") return Response.json({ error: "HTTPS only" }, { status: 403 });
  if (props.taskId === undefined || props.agent === undefined) {
    return Response.json({ error: "This sandbox runs no agent" }, { status: 404 });
  }
  const room = roomFor(props.taskId);
  const route = `${request.method} ${new URL(request.url).pathname.slice(THUNDERDOME_API_PREFIX.length)}`;
  if (route === "GET claims") return Response.json(await room.claimBoard());
  if (route === "GET where") return Response.json({ colo: await coloAt(request) ?? null });
  if (route !== "POST claims" && route !== "POST release") return Response.json({ error: "not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (route === "POST release") {
    const result = await room.release(props.agent, body.files);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }
  const result = await room.claim(props.agent, body.files, body.shared === true);
  return Response.json(result, { status: result.ok ? 200 : result.status });
}

/**
 * The data center a sandbox request reached: the request's own `cf.colo` when the runtime sets it
 * on an intercepted request, else where this Worker runs, from Cloudflare's trace page.
 */
async function coloAt(request: Request): Promise<string | undefined> {
  const seen = coloOf((request as { cf?: { colo?: unknown } }).cf?.colo);
  if (seen !== undefined) return seen;
  try {
    return traceColo(await (await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(5_000) })).text());
  } catch {
    return undefined;
  }
}
