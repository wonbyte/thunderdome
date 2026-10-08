// The Outbound Worker: every request a sandbox makes goes through it, and policy.ts decides what
// goes out and which token it carries.

import { WorkerEntrypoint } from "cloudflare:workers";

import { usageOfJson, usageTap, type Usage } from "../agents/usage";
import { handleThunderdomeApi } from "./thunderdomeApi";
import { decideOutbound, isMessageCall, isThunderdomeApi, messageUpstream, type OutboundProps } from "./policy";

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
    const url = new URL(request.url);
    const message = isMessageCall(url, request.method);
    const upstream = message ? messageUpstream(url, this.env.CF_ACCOUNT_ID, this.env.MODEL_GATEWAY) : url;
    // The gateway's log filters by race and robot.
    if (upstream !== url) headers.set("cf-aig-metadata", JSON.stringify({ task: this.ctx.props.taskId, agent: this.ctx.props.agent }));
    // A redirect goes back to the sandbox, so following it passes the policy again: the token
    // chosen for this host never travels to another one.
    const forward = new Request(request, { headers, redirect: "manual" });
    const response = await fetch(upstream === url ? forward : new Request(upstream.href, forward));
    // A refused model call ends the agent with a short message; keep the details in the Worker logs.
    if (response.status === 401 || response.status === 403) {
      console.error({ event: "outbound.refused", host: url.hostname, path: url.pathname, status: response.status });
    }
    return message && response.ok ? this.#meter(response) : response;
  }

  /** Counts a message call's tokens for the robot's meter, without holding the reply back. */
  #meter(response: Response): Response {
    const { taskId, agent } = this.ctx.props;
    if (taskId === undefined || agent === undefined) return response;
    const report = (usage: Usage): void => {
      // The meter is a nice-to-have: a room that cannot take it never fails the agent's call.
      this.ctx.waitUntil(this.env.TASK_ROOM.getByName(taskId).usage(agent, usage).catch((error: unknown) => console.error({ event: "outbound.usage", error: String(error) })));
    };
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && response.body !== null) return new Response(response.body.pipeThrough(usageTap(report)), response);
    if (type.includes("application/json")) this.ctx.waitUntil(response.clone().json().then(usageOfJson, () => usageOfJson(undefined)).then(report));
    return response;
  }
}
