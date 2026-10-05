// Turns Claude Code stream-json output into short steps for the TaskRoom log.

export interface Step {
  kind: "init" | "text" | "tool" | "result" | "error" | "claim";
  text: string;
}

export interface RunResult {
  isError: boolean;
  text: string;
  costUsd?: number;
  turns?: number;
}

const MAX_STEP_TEXT = 500;

// Splits complete lines off the front of a byte buffer. A partial last line stays unread,
// so the next read starts at `consumed`.
export function splitLines(bytes: Uint8Array): { lines: string[]; consumed: number } {
  const end = bytes.lastIndexOf(0x0a);
  if (end < 0) return { lines: [], consumed: 0 };
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  return { lines: text.split("\n").filter((line) => line.trim() !== ""), consumed: end + 1 };
}

export function clip(text: string, max = MAX_STEP_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function parseEvent(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// The final result event. A failed model call still has subtype "success", so read is_error.
export function resultOf(event: unknown): RunResult | undefined {
  if (!isRecord(event) || event.type !== "result") return undefined;
  return {
    isError: event.is_error === true,
    text: typeof event.result === "string" ? event.result : String(event.subtype ?? ""),
    costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
    turns: typeof event.num_turns === "number" ? event.num_turns : undefined,
  };
}

export function stepsOf(event: unknown): Step[] {
  if (!isRecord(event)) return [];
  if (event.type === "system" && event.subtype === "init") {
    return [{ kind: "init", text: clip(`started${typeof event.model === "string" ? ` (${event.model})` : ""}`) }];
  }
  const result = resultOf(event);
  if (result !== undefined) {
    const cost = result.costUsd === undefined ? "" : ` [$${result.costUsd.toFixed(4)}]`;
    return [{ kind: result.isError ? "error" : "result", text: clip(`${result.text}${cost}`) }];
  }
  if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return [];
  const steps: Step[] = [];
  for (const block of event.message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      steps.push({ kind: "text", text: clip(block.text) });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      steps.push({ kind: "tool", text: clip(`${block.name} ${describeInput(block.input)}`) });
    }
  }
  return steps;
}

// The most telling field of a tool call, e.g. the command for Bash or the path for Edit.
function describeInput(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of ["command", "file_path", "path", "pattern", "description"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return JSON.stringify(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
