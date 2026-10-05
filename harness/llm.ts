// Model layer. Code owns every limit here; the models never see them.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const LIMITS = { opusCalls: 100, sonnetCalls: 150, minutes: 45, usd: 20 };

// $ per million tokens. A fallback model is priced at the highest rate we might pay.
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  [OPUS]: { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  [SONNET]: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const FALLBACK_PRICE = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };
// Worst case for one more call. A call is refused unless spend + this stays under the cap.
const MAX_CALL_USD: Record<string, number> = { [OPUS]: 2, [SONNET]: 0.1 };

export class BudgetExceeded extends Error {
  limit: string;
  constructor(limit: string, detail: string) {
    super(`${limit} limit hit: ${detail}`);
    this.limit = limit;
  }
}

export class Budget {
  opusCalls = 0;
  sonnetCalls = 0;
  usd = 0;
  started = Date.now();
  abort = new AbortController();

  minutes(): number {
    return (Date.now() - this.started) / 60_000;
  }

  reserve(model: string): void {
    if (this.abort.signal.aborted || this.minutes() >= LIMITS.minutes) {
      throw new BudgetExceeded("minutes", `${this.minutes().toFixed(1)} of ${LIMITS.minutes} min used`);
    }
    if (model === OPUS && this.opusCalls >= LIMITS.opusCalls) {
      throw new BudgetExceeded("opus calls", `${this.opusCalls} of ${LIMITS.opusCalls}`);
    }
    if (model === SONNET && this.sonnetCalls >= LIMITS.sonnetCalls) {
      throw new BudgetExceeded("sonnet calls", `${this.sonnetCalls} of ${LIMITS.sonnetCalls}`);
    }
    if (this.usd + (MAX_CALL_USD[model] ?? 2) > LIMITS.usd) {
      throw new BudgetExceeded("spend", `$${this.usd.toFixed(2)} spent, cap $${LIMITS.usd}`);
    }
    if (model === OPUS) this.opusCalls++;
    else this.sonnetCalls++;
  }

  charge(message: BetaMessage): void {
    const price = PRICES[message.model] ?? FALLBACK_PRICE;
    const u = message.usage;
    this.usd +=
      ((u.input_tokens ?? 0) * price.in +
        (u.output_tokens ?? 0) * price.out +
        (u.cache_read_input_tokens ?? 0) * price.cacheRead +
        (u.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
      1_000_000;
  }
}

// The key comes from .env through `node --env-file=.env`; it is never logged.
const client = new Anthropic({ timeout: 10 * 60_000, maxRetries: 2 });

function answerSchema(options: string[]) {
  return {
    type: "object" as const,
    properties: { answer: { type: "string" as const, enum: options } },
    required: ["answer"],
    additionalProperties: false,
  };
}

function textOf(message: BetaMessage): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

export interface Vote {
  answer: string | null; // null: refused or not one of the options
  ms: number;
}

// One Sonnet vote: one option from a fixed list, returned as JSON.
export async function sonnetVote(budget: Budget, system: string, prompt: string, options: string[]): Promise<Vote> {
  budget.reserve(SONNET);
  const started = performance.now();
  const message = await client.beta.messages.create(
    {
      model: SONNET,
      max_tokens: 2048,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: answerSchema(options) } },
      system,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: budget.abort.signal },
  );
  const ms = performance.now() - started;
  budget.charge(message);
  return { answer: parseAnswer(message, options), ms };
}

// Opus answers the same fixed-option question when the votes disagree. Its answer is final.
export async function opusAnswer(budget: Budget, system: string, prompt: string, options: string[]): Promise<string | null> {
  budget.reserve(OPUS);
  const message = await client.beta.messages
    .stream(
      {
        model: OPUS,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: answerSchema(options) } },
        system,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: budget.abort.signal },
    )
    .finalMessage();
  budget.charge(message);
  return parseAnswer(message, options);
}

function parseAnswer(message: BetaMessage, options: string[]): string | null {
  if (message.stop_reason === "refusal") return null;
  try {
    const answer = (JSON.parse(textOf(message)) as { answer?: unknown }).answer;
    return typeof answer === "string" && options.includes(answer) ? answer : null;
  } catch {
    return null;
  }
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export interface AgentRun {
  stopped: "done" | "call_cap" | "refusal" | "max_tokens";
  calls: number;
  text: string;
}

// One Opus tool loop. The runner executes every tool; maxCalls caps this loop.
export async function opusAgent(
  budget: Budget,
  opts: {
    system: string;
    prompt: string;
    tools: BetaToolUnion[];
    runTool: (name: string, input: unknown) => Promise<ToolResult>;
    maxCalls: number;
    stopTool?: string; // calling this tool ends the loop
  },
): Promise<AgentRun> {
  const messages: BetaMessageParam[] = [{ role: "user", content: opts.prompt }];
  for (let calls = 1; calls <= opts.maxCalls; calls++) {
    budget.reserve(OPUS);
    const message = await client.beta.messages
      .stream(
        {
          model: OPUS,
          max_tokens: 32000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: "high" },
          cache_control: { type: "ephemeral" },
          system: opts.system,
          tools: opts.tools,
          messages,
        },
        { signal: budget.abort.signal },
      )
      .finalMessage();
    budget.charge(message);
    // Append-only history: the response goes back exactly as it came.
    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "refusal") return { stopped: "refusal", calls, text: textOf(message) };
    if (message.stop_reason === "max_tokens") return { stopped: "max_tokens", calls, text: textOf(message) };
    const uses = message.content.filter((b) => b.type === "tool_use");
    if (uses.length === 0) return { stopped: "done", calls, text: textOf(message) };
    const results = [];
    let stop = false;
    for (const use of uses) {
      const result = await opts.runTool(use.name, use.input);
      results.push({ type: "tool_result" as const, tool_use_id: use.id, content: result.content, is_error: result.is_error });
      if (use.name === opts.stopTool && !result.is_error) stop = true;
    }
    messages.push({ role: "user", content: results });
    if (stop) return { stopped: "done", calls, text: textOf(message) };
  }
  return { stopped: "call_cap", calls: opts.maxCalls, text: "" };
}
