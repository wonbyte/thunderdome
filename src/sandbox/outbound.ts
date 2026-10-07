// The Outbound Worker: every request a sandbox makes goes through it, and policy.ts decides what
// goes out and which token it carries.

import { WorkerEntrypoint } from "cloudflare:workers";

import { handleThunderdomeApi } from "./thunderdomeApi";
import { decideOutbound, isThunderdomeApi, type OutboundProps } from "./policy";

/** What one sandbox may reach; see policy.ts. */
export type { OutboundProps } from "./policy";

/** All sandbox HTTP and HTTPS goes through here. */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  /**
   * Answers Thunderdome API calls itself, and forwards every other request only when the policy
   * allows it, with the token it chose.
   */
  override async fetch(request: Request): Promise<Response> {
    if (isThunderdomeApi(new URL(request.url), this.ctx.props)) {
      return handleThunderdomeApi(request, this.ctx.props, (taskId) => this.env.TASK_ROOM.getByName(taskId));
    }
    const decision = decideOutbound(
      new URL(request.url),
      this.ctx.props,
      this.env.ANTHROPIC_API_KEY,
      request.method,
      this.env.CLOUDFLARE_PREVIEW_TOKEN,
    );
    if (!decision.allow) return new Response(`${decision.reason}\n`, { status: decision.status });
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(decision.headers)) headers.set(name, value);
    // A redirect goes back to the sandbox, so following it passes the policy again: the token
    // chosen for this host never travels to another one.
    const response = await fetch(new Request(request, { headers, redirect: "manual" }));
    const url = new URL(request.url);
    // A refused model call ends the agent with a short message; keep the details in the Worker logs.
    if (response.status === 401 || response.status === 403) {
      console.error({ event: "outbound.refused", host: url.hostname, path: url.pathname, status: response.status });
    }
    return response;
  }
}
