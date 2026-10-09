// What one race cost: Cloudflare's part estimated from the race record at list price, and the
// agents' part from their meters. Pure; app.ts shows it in the pipeline header.

import type { WireAgent, WirePreview, WireTask } from "./board";

/** Containers billed per second of a `standard-1` (1/2 vCPU, 4 GiB, 8 GB disk), as if busy throughout. */
const CONTAINER_USD_PER_S = 0.5 * 0.00002 + 4 * 0.0000025 + 8 * 0.00000007;
/** Browser Rendering: $0.09 an hour. */
const BROWSER_USD_PER_S = 0.09 / 3600;
/** Clef: $0.24 per million input tokens, and one call on a demo fork read 3,650 (one sample, Oct 8). */
const CLEF_USD_PER_CALL = (3650 * 0.24) / 1e6;
/** A preview build whose end the record does not show; the build's own time limit. */
const BUILD_S = 80;
/** Clef calls per judged fork: 3 questions, each in both file orders. */
const CLEF_PER_FORK = 6;

/** One race's bill. */
export interface Bill {
  containers: number;
  containerSeconds: number;
  clefCalls: number;
  browserSeconds: number;
  cloudflareUsd: number;
  agentsUsd: number;
}

const seconds = (from: string, to: string | number): number => Math.max(0, ((typeof to === "number" ? to : Date.parse(to)) - Date.parse(from)) / 1000) || 0;

/** Dollars, with a third digit under 10 cents: a Haiku robot's run costs about a cent. */
export function usd(v: number): string {
  return `$${v < 0.1 && v > 0 ? v.toFixed(3) : v.toFixed(2)}`;
}

/** When a push's preview build ended (ms): the preview's time when it shows that commit, else the build's time limit. */
export function buildEnd(at: number, commit: string | undefined, preview: WirePreview | undefined): number {
  return commit !== undefined && preview?.commit === commit ? Date.parse(preview.at) : at + BUILD_S * 1000;
}

/** The bill so far. `now` (ms) ends whatever is still running. */
/**
 * What one agent's model calls cost: the meter's figure when it priced every call, else Claude
 * Code's own (races before the meter, or a model the meter has no price for). Claude Code's figure
 * is not trusted first: it prices claude-haiku-5-5 at Opus 5.5 rates, 32x too high (Oct 8).
 */
export function agentUsd(slot: WireAgent): number | undefined {
  const usage = slot.usage;
  if (usage !== undefined && usage.calls > 0 && (usage.unpriced ?? 0) === 0) return usage.usd;
  return slot.costUsd ?? usage?.usd;
}

export function billOf(task: WireTask, now: number): Bill {
  let containers = 0;
  let containerSeconds = 0;
  let clefCalls = 0;
  let browserSeconds = 0;
  let agentsUsd = 0;
  for (const slot of task.agents) {
    agentsUsd += agentUsd(slot) ?? 0;
    if (slot.startedAt !== undefined) {
      containers++;
      containerSeconds += seconds(slot.startedAt, slot.endedAt ?? now);
    }
    // Each push builds a preview; a build later superseded may have been skipped, so this is an upper bound.
    for (const push of slot.push?.log ?? []) {
      containers++;
      containerSeconds += seconds(push.at, buildEnd(Date.parse(push.at), push.commit, slot.push?.preview));
    }
  }
  if (task.basePreview !== undefined) {
    containers++;
    containerSeconds += BUILD_S;
  }
  for (const step of task.judging ?? []) {
    const took = seconds(step.startedAt, step.endedAt ?? now);
    if (step.name.startsWith("fork ")) {
      containers++;
      containerSeconds += took;
      clefCalls += CLEF_PER_FORK;
    } else if (step.name === "fuse" || step.name === "ship") {
      containers++;
      containerSeconds += took;
    } else if (step.name === "look") {
      browserSeconds += took;
      // "Is it visual?", then one look per fork: an upper bound, as a non-visual task stops at the first.
      clefCalls += 1 + task.agents.length;
    } else if (step.name === "split") {
      clefCalls += 1;
    } else if (step.name === "compare") {
      clefCalls += 2;
    }
  }
  const cloudflareUsd = containerSeconds * CONTAINER_USD_PER_S + browserSeconds * BROWSER_USD_PER_S + clefCalls * CLEF_USD_PER_CALL;
  return { containers, containerSeconds, clefCalls, browserSeconds, cloudflareUsd, agentsUsd };
}

/** "3 containers · 4 container-min · 25 Clef calls · Cloudflare ≈ $0.03 · agents $0.71". */
export function billLine(bill: Bill): string {
  const minutes = Math.max(1, Math.round(bill.containerSeconds / 60));
  return [
    `${bill.containers} container${bill.containers === 1 ? "" : "s"}`,
    `${minutes} container-min`,
    `${bill.clefCalls} Clef call${bill.clefCalls === 1 ? "" : "s"}`,
    `Cloudflare ≈ ${usd(bill.cloudflareUsd)}`,
    `agents ${usd(bill.agentsUsd)}`,
  ].join(" · ");
}
