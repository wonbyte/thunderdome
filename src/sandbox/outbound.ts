import { WorkerEntrypoint } from "cloudflare:workers";

import { handleThunderdomeApi } from "./thunderdomeApi";
import { decideOutbound, isThunderdomeApi, type OutboundProps } from "./policy";

export type { OutboundProps } from "./policy";

// The Workers Previews API token. Read through a cast until Env is regenerated with the secret.
function previewToken(env: Env): string | undefined {
  return (env as Env & { CLOUDFLARE_PREVIEW_TOKEN?: string }).CLOUDFLARE_PREVIEW_TOKEN;
}

// All sandbox HTTP and HTTPS goes through here.
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    if (isThunderdomeApi(new URL(request.url), this.ctx.props)) {
      return handleThunderdomeApi(request, this.ctx.props, (taskId) => this.env.TASK_ROOM.getByName(taskId));
    }
    const decision = decideOutbound(
      new URL(request.url),
      this.ctx.props,
      this.env.ANTHROPIC_API_KEY,
      request.method,
      previewToken(this.env),
    );
    if (!decision.allow) return new Response(`${decision.reason}\n`, { status: decision.status });
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(decision.headers)) headers.set(name, value);
    const response = await fetch(new Request(request, { headers }));
    // A refused model call ends the agent with a short message; keep the details in the Worker logs.
    if (response.status === 401 || response.status === 403) {
      const url = new URL(request.url);
      console.error({ event: "outbound.refused", host: url.hostname, path: url.pathname, status: response.status });
    }
    return response;
  }
}
