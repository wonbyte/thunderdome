// What a robot's model calls used and cost, counted as they pass through the Outbound Worker.
// Pure: the Outbound Worker pipes each streamed reply through usageTap and the room adds them up.
// The dollars are at list price. The page trusts them over Claude Code's own costUsd, which prices
// claude-haiku-5-5 at Opus 5.5 rates (src/ui/bill.ts agentUsd).

/** Token counts and estimated dollars for one or more model calls. */
export interface Usage {
  calls: number;
  input: number; // uncached input tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number; // 0 when no call's model had a known price
  unpriced?: number; // calls whose model is not in MODEL_RATES
}

/** List prices in dollars per million tokens. Cache writes are the 5-minute kind Claude Code uses. */
interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number }

/** From the Anthropic pricing table, Oct 6 2026. */
export const MODEL_RATES: Readonly<Record<string, Rates>> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
/** Haiku 5.5 bills a prompt over 100K tokens at 5x, all of the call. */
const HAIKU_LONG_PROMPT = 100_000;
const HAIKU_LONG_FACTOR = 5;

/** The usage fields of an Anthropic Messages reply (message_start, message_delta, or a JSON body). */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** No calls yet. */
export function noUsage(): Usage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
}

/** One call's usage and estimated cost. An unknown model counts its tokens and no dollars. */
/** A token count, or 0 for anything that is not one. */
function n(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function callUsage(model: string | undefined, raw: RawUsage): Usage {
  const u: Usage = { calls: 1, input: n(raw.input_tokens), output: n(raw.output_tokens), cacheRead: n(raw.cache_read_input_tokens), cacheWrite: n(raw.cache_creation_input_tokens), usd: 0 };
  const rates = model === undefined ? undefined : MODEL_RATES[model];
  if (rates === undefined) return { ...u, unpriced: 1 };
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const factor = model === "claude-haiku-5-5" && prompt > HAIKU_LONG_PROMPT ? HAIKU_LONG_FACTOR : 1;
  const usd = (u.input * rates.input + u.output * rates.output + u.cacheRead * rates.cacheRead + u.cacheWrite * rates.cacheWrite) * factor / 1e6;
  return { ...u, usd };
}

/** The sum of two usages. */
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  const base = a ?? noUsage();
  const unpriced = (base.unpriced ?? 0) + (b.unpriced ?? 0);
  return {
    calls: base.calls + b.calls,
    input: base.input + b.input,
    output: base.output + b.output,
    cacheRead: base.cacheRead + b.cacheRead,
    cacheWrite: base.cacheWrite + b.cacheWrite,
    usd: base.usd + b.usd,
    ...(unpriced > 0 ? { unpriced } : {}),
  };
}

/** One call's usage from a JSON Messages reply. */
export function usageOfJson(body: unknown): Usage {
  if (typeof body !== "object" || body === null) return callUsage(undefined, {});
  const { model, usage } = body as { model?: unknown; usage?: unknown };
  return callUsage(typeof model === "string" ? model : undefined, isRaw(usage) ? usage : {});
}

/**
 * A pass-through stream for a streamed Messages reply: the bytes go on untouched, and when the
 * stream ends `done` gets the call's usage. The model and first counts come from message_start,
 * and each message_delta's counts replace them (they are running totals). A reply that cannot be
 * read still counts as one call.
 */
export function usageTap(done: (usage: Usage) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let partial = "";
  let model: string | undefined;
  let raw: RawUsage = {};
  const scan = (line: string): void => {
    if (!line.startsWith("data:")) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const e = event as { type?: unknown; message?: { model?: unknown; usage?: unknown }; usage?: unknown };
    if (e.type === "message_start") {
      if (typeof e.message?.model === "string") model = e.message.model;
      raw = merge(raw, e.message?.usage);
    } else if (e.type === "message_delta") {
      raw = merge(raw, e.usage);
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) scan(line.trimEnd());
    },
    flush() {
      scan((partial + decoder.decode()).trimEnd());
      done(callUsage(model, raw));
    },
  });
}

/** `next`'s numeric counts over `raw`'s; a null or missing count keeps the earlier one. */
function merge(raw: RawUsage, next: unknown): RawUsage {
  if (!isRaw(next)) return raw;
  const out = { ...raw };
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const v = next[key];
    if (typeof v === "number") out[key] = v;
  }
  return out;
}

function isRaw(v: unknown): v is RawUsage {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
