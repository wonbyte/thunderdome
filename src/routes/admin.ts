// GET /admin/model-check: tests the Worker's model key the same way the Outbound Worker sends it.
import { MODEL_API_HOST } from "../agents/runner";
import { decideOutbound } from "../sandbox/policy";

/**
 * What the model key looks like, without the key: its type, its length, and whether it had
 * whitespace around it.
 */
export interface KeyShape {
  /** The key type, e.g. "sk-ant-api" for a Console API key. Never more than that. */
  kind: string;
  length: number;
  trimmed: boolean;
}

/** The shape of the model key, safe to return to the admin. */
export function keyShape(key: string | undefined): KeyShape {
  const raw = key ?? "";
  const clean = raw.trim();
  const kind = /^sk-ant-[a-z]+/.exec(clean)?.[0] ?? (clean === "" ? "missing" : "unknown");
  return { kind, length: clean.length, trimmed: clean !== raw };
}

/**
 * GET /admin/model-check: one model API call with the Worker's key, sent the way the Outbound
 * Worker sends it. Returns the key's shape and the API's answer, never the key.
 */
export async function modelCheck(env: Pick<Env, "ANTHROPIC_API_KEY">, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(`https://${MODEL_API_HOST}/v1/models?limit=1`);
  const shape = keyShape(env.ANTHROPIC_API_KEY);
  const decision = decideOutbound(url, { gitHost: "", gitToken: "", modelApi: true }, env.ANTHROPIC_API_KEY);
  if (!decision.allow) return Response.json({ ok: false, key: shape, error: decision.reason });
  const response = await fetcher(url, { headers: { ...decision.headers, "anthropic-version": "2023-06-01" } });
  const body = response.ok ? undefined : (await response.text()).slice(0, 500);
  return Response.json({ ok: response.ok, status: response.status, key: shape, error: body });
}
