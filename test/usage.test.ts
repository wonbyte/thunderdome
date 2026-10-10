import { describe, expect, it } from "vitest";

import { addUsage, callUsage, usageOfJson, usageTap, type Usage } from "../src/agents/usage";
import { isMessageCall, messageUpstream } from "../src/sandbox/policy";
import { agentUsd, billLine, billOf } from "../src/ui/bill";
import { applyEvent, emptyBoard, type WireTask } from "../src/ui/board";

/** Pipes `chunks` through the tap; returns what came out and what the tap reported. */
async function tap(chunks: string[]): Promise<{ out: string; usage: Usage | undefined }> {
  let usage: Usage | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  const out = await new Response(source.pipeThrough(usageTap((u) => (usage = u)))).text();
  return { out, usage };
}

const START = `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":20000,"cache_creation_input_tokens":3000,"output_tokens":1}}}\n\n`;
const DELTA = `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":420,"cache_read_input_tokens":null}}\n\n`;

describe("the meter", () => {
  it("M1: the tap passes bytes untouched and reads usage across split chunks, with deltas as running totals", async () => {
    const text = START + `data: {"type":"content_block_delta"}\n\n` + DELTA;
    const cut = [text.slice(0, 7), text.slice(7, 90), text.slice(90, 200), text.slice(200)];
    const { out, usage } = await tap(cut);
    expect(out).toBe(text);
    expect(usage).toMatchObject({ calls: 1, input: 12, output: 420, cacheRead: 20000, cacheWrite: 3000 });
    // 12 x 0.10 + 420 x 0.50 + 20000 x 0.01 + 3000 x 0.125, per million.
    expect(usage?.usd).toBeCloseTo((1.2 + 210 + 200 + 375) / 1e6, 12);
  });

  it("M2: a reply the tap cannot read still counts one call, priced as unknown", async () => {
    const { out, usage } = await tap(["data: {not json\n\n", "data: [1,2]\n\n"]);
    expect(out).toBe("data: {not json\n\ndata: [1,2]\n\n");
    expect(usage).toEqual({ calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpriced: 1 });
    expect(usageOfJson({ model: "claude-sonnet-5-5", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }).usd).toBeCloseTo(3, 9);
  });

  it("M3: Haiku 5.5 bills a prompt over 100K tokens at 5x; an unknown model counts tokens and no dollars", () => {
    const short = callUsage("claude-haiku-5-5", { input_tokens: 100_000 });
    const long = callUsage("claude-haiku-5-5", { input_tokens: 1, cache_read_input_tokens: 100_000 });
    expect(short.usd).toBeCloseTo(0.01, 9);
    expect(long.usd).toBeCloseTo((0.1 + 100_000 * 0.01) * 5 / 1e6, 12);
    const unknown = callUsage("claude-next-1", { input_tokens: 50, output_tokens: 5 });
    expect(unknown).toMatchObject({ input: 50, output: 5, usd: 0, unpriced: 1 });
    expect(addUsage(addUsage(undefined, short), unknown)).toMatchObject({ calls: 2, input: 100_050, unpriced: 1 });
  });

  it("M4: only a message call is metered, and it goes through AI Gateway only when the gateway is well formed", () => {
    const url = new URL("https://api.anthropic.com/v1/messages?beta=true");
    expect(isMessageCall(url, "POST")).toBe(true);
    expect(isMessageCall(new URL("https://api.anthropic.com/v1/messages/count_tokens"), "POST")).toBe(false);
    expect(isMessageCall(url, "GET")).toBe(false);
    const account = "bc1c0551f58de19c91a2d34f1a75e97c";
    expect(messageUpstream(url, account, "thunderdome").href).toBe(`https://gateway.ai.cloudflare.com/v1/${account}/thunderdome/anthropic/v1/messages?beta=true`);
    for (const gateway of [undefined, "", "Has Space", "../x"]) expect(messageUpstream(url, account, gateway)).toBe(url);
    expect(messageUpstream(url, "nothex", "thunderdome")).toBe(url);
  });

  it("M5: the bill reads containers, Clef calls and browser time from a recorded race", () => {
    // t-eb357c3d, Oct 8, trimmed: two agents, one push each, and the judge's steps.
    const task: WireTask = {
      id: "t-eb357c3d",
      prompt: "x",
      status: "finished",
      startedAt: "2026-10-08T04:27:52.424Z",
      basePreview: { url: "u", commit: "base", at: "2026-10-08T04:28:00.000Z" },
      agents: [
        {
          name: "ponder",
          status: "done",
          startedAt: "2026-10-08T04:27:52.424Z",
          endedAt: "2026-10-08T04:29:07.366Z",
          costUsd: 0.5,
          push: { commits: 1, log: [{ at: "2026-10-08T04:28:55.119Z", commit: "a", commits: 1 }], preview: { url: "u", commit: "a", at: "2026-10-08T04:29:04.297Z" } },
        },
        {
          name: "zippy",
          status: "running",
          startedAt: "2026-10-08T04:27:52.424Z",
          usage: { calls: 3, input: 10, output: 10, cacheRead: 0, cacheWrite: 0, usd: 0.25 },
          push: { commits: 1, log: [{ at: "2026-10-08T04:28:20.451Z", commit: "old", commits: 1 }] },
        },
      ],
      judging: [
        { name: "fork ponder", state: "done", startedAt: "2026-10-08T04:29:30.279Z", endedAt: "2026-10-08T04:29:39.589Z" },
        { name: "look", state: "done", startedAt: "2026-10-08T04:29:30.291Z", endedAt: "2026-10-08T04:29:37.880Z" },
        { name: "split", state: "done", startedAt: "2026-10-08T04:29:39.694Z", endedAt: "2026-10-08T04:29:39.995Z" },
        { name: "ship", state: "running", startedAt: "2026-10-08T04:29:47.866Z" },
      ],
    };
    const now = Date.parse("2026-10-08T04:29:52.424Z");
    const bill = billOf(task, now);
    // 2 agents + 2 builds + the base build + 1 fork + ship.
    expect(bill.containers).toBe(7);
    // ponder 74.942 + zippy 120 (running) + build 9.178 + build 80 + base 80 + fork 9.31 + ship 4.558.
    expect(bill.containerSeconds).toBeCloseTo(74.942 + 120 + 9.178 + 80 + 80 + 9.31 + 4.558, 6);
    // A push whose own preview time is recorded ends there: zippy's build is 10 s, not 80 s.
    task.agents[1]!.push!.log![0]!.previewAt = "2026-10-08T04:28:30.451Z";
    expect(billOf(task, now).containerSeconds).toBeCloseTo(bill.containerSeconds - 70, 6);
    // A build still running 10 s in counts 10 s, not its 80 s limit: a replay's bill never shrinks.
    const building: WireTask = { id: "t", prompt: "x", status: "running", agents: [{ name: "snip", status: "running", push: { commits: 1, log: [{ at: "2026-10-08T04:28:00.000Z", commit: "s", commits: 1 }] } }] };
    expect(billOf(building, Date.parse("2026-10-08T04:28:10.000Z")).containerSeconds).toBeCloseTo(10, 6);
    expect(bill.clefCalls).toBe(6 + 1 + 2 + 1);
    expect(bill.browserSeconds).toBeCloseTo(7.589, 6);
    expect(bill.agentsUsd).toBeCloseTo(0.75, 9);
    expect(billLine(bill)).toMatch(/^7 containers · 6 container-min · 10 Clef calls · Cloudflare ≈ \$0\.0\d\d · agents \$0\.75$/);
  });

  it("M7: an agent's cost is the meter's when it priced every call, else Claude Code's", () => {
    const usage = { calls: 16, input: 32, output: 13001, cacheRead: 615912, cacheWrite: 28770, usd: 0.0163 };
    // t-7dc4f1ff: Claude Code priced this Haiku 5.5 run at Opus 5.5 rates.
    expect(agentUsd({ name: "ponder", status: "done", costUsd: 0.5272, usage })).toBe(0.0163);
    expect(agentUsd({ name: "ponder", status: "done", costUsd: 0.5272, usage: { ...usage, unpriced: 2 } })).toBe(0.5272);
    expect(agentUsd({ name: "ponder", status: "done", costUsd: 0.5272 })).toBe(0.5272);
    expect(agentUsd({ name: "ponder", status: "running", usage: { ...usage, unpriced: 2 } })).toBe(0.0163);
    expect(agentUsd({ name: "ponder", status: "starting" })).toBeUndefined();
  });

  it("M6: a usage event replaces that agent's running total on the board", () => {
    const task: WireTask = { id: "t-0123abcd", prompt: "x", status: "running", agents: [{ name: "ponder", status: "running" }, { name: "zippy", status: "running" }] };
    const board = applyEvent(emptyBoard("t-0123abcd"), { kind: "status", taskId: "t-0123abcd", task }, 1);
    const usage = { calls: 2, input: 5, output: 6, cacheRead: 7, cacheWrite: 8, usd: 0.01 };
    const next = applyEvent(board, { kind: "usage", taskId: "t-0123abcd", agent: "zippy", usage }, 2);
    expect(next.task?.agents.map((a) => a.usage)).toEqual([undefined, usage]);
    expect(applyEvent(next, { kind: "usage", taskId: "t-other", agent: "zippy", usage }, 3)).toBe(next);
    // The agent's end brings Claude Code's own cost, and the meter stays.
    const ended = applyEvent(next, { kind: "agent-end", taskId: "t-0123abcd", agent: "zippy", outcome: { end: "done", costUsd: 0.02 }, status: "running" }, 4);
    expect(ended.task?.agents[1]).toMatchObject({ status: "done", costUsd: 0.02, usage });
  });
});
