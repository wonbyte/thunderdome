// The Cloudflare side of a race: which product produced each live event, and how long it took.
// Pure, like board.ts. Latencies come from the server's own timestamps where it sends them.
import { displayName } from "./board";
import type { BoardEvent } from "./board";
import { fusionView, type FusionView } from "./fusion";

/** Each stage's Cloudflare product, as the ticker, X-ray and the timeline name it. */
export const STAGE_INFO = {
  fork: "Artifacts",
  containers: "Containers",
  claims: "Durable Objects",
  events: "Event Subscriptions",
  workflows: "Workflows",
  previews: "Workers Previews",
  ai: "Workers AI · Clef",
  fusion: "Containers × 2",
  merge: "Artifacts",
} as const;
/** One stage of a race: a product it uses. */
export type Stage = keyof typeof STAGE_INFO;

/** One thing a stage did: a ticker chip and, in X-ray, a packet. */
export interface PlatformHit {
  stage: Stage;
  text: string; // e.g. "Testy's preview is live"
  ms?: number; // how long it took, when known
  agent?: string;
}

/** What the hits are measured from: when the run started, the judge started and each agent last pushed. */
export interface PlatformState {
  runAt?: number;
  finishedAt?: number;
  pushAt: Record<string, number>;
  forked: boolean;
  agents: number;
}

/** A race with nothing done yet. */
export function emptyPlatform(): PlatformState {
  return { pushAt: {}, forked: false, agents: 0 };
}

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

const since = (from: number | undefined, to: number | undefined): number | undefined =>
  from === undefined || to === undefined || to < from ? undefined : to - from;

function hit(stage: Stage, text: string, extra: { ms?: number | undefined; agent?: string } = {}): PlatformHit {
  return { stage, text, ...(extra.ms === undefined ? {} : { ms: extra.ms }), ...(extra.agent === undefined ? {} : { agent: extra.agent }) };
}

/** The hits one event makes, and the state after it. `at` is when the event happened (ms). */
export function applyPlatform(state: PlatformState, event: BoardEvent, at: number): { state: PlatformState; hits: PlatformHit[] } {
  const hits: PlatformHit[] = [];
  const next: PlatformState = { ...state, pushAt: { ...state.pushAt } };
  switch (event.kind) {
    case "snapshot":
    case "status": {
      const task = event.task;
      if (task === null) break;
      next.agents = task.agents.length;
      if (!next.forked && task.agents.length > 0) {
        next.forked = true;
        // No fork duration: the gap from create to run includes waiting for POST /run.
        hits.push(hit("fork", `forked the repo ${task.agents.length} times`));
      }
      const runAt = ms(task.startedAt);
      if (runAt !== undefined && next.runAt === undefined && task.status !== "ready") {
        next.runAt = runAt;
        hits.push(hit("containers", `starting ${task.agents.length} sandboxes`));
      }
      break;
    }
    case "steps":
      for (const step of event.steps) {
        if (step.kind === "init") hits.push(hit("containers", `${displayName(step.agent)}'s sandbox is up`, { ms: since(next.runAt, ms(step.at) ?? at), agent: step.agent }));
      }
      break;
    case "claim":
      if (event.result.ok) {
        const clash = event.result.clashes[0];
        hits.push(hit("claims", clash === undefined ? `${displayName(event.agent)} claimed ${event.result.claimed.length} file${event.result.claimed.length === 1 ? "" : "s"}` : `clash on ${clash.file}`, { agent: event.agent }));
      }
      break;
    case "release":
      hits.push(hit("claims", `${displayName(event.agent)} released ${event.released.length} file${event.released.length === 1 ? "" : "s"}`, { agent: event.agent }));
      break;
    case "push": {
      const pushAt = ms(event.push.lastPushAt) ?? at;
      next.pushAt[event.agent] = pushAt;
      hits.push(hit("events", `${displayName(event.agent)} pushed`, { agent: event.agent }));
      hits.push(hit("workflows", `building ${displayName(event.agent)}'s preview`, { agent: event.agent }));
      break;
    }
    case "preview":
      hits.push(hit("previews", `${displayName(event.agent)}'s preview is live`, { ms: since(next.pushAt[event.agent], ms(event.preview.at) ?? at), agent: event.agent }));
      break;
    case "base-preview":
      hits.push(hit("previews", `the "before" preview is live`, { ms: since(next.runAt, ms(event.preview.at) ?? at) }));
      break;
    case "agent-end":
      if (event.status === "finished" && next.finishedAt === undefined) {
        next.finishedAt = at;
        hits.push(hit("workflows", "judge started: tests in every fork"));
      }
      break;
    case "verdict": {
      const judgedAt = ms(event.verdict.judgedAt) ?? at;
      hits.push(hit("ai", `Clef scored ${next.agents || "every"} diffs`, { ms: since(next.finishedAt, judgedAt) }));
      const fusion = fusionView(event.verdict);
      if (fusion !== undefined) hits.push(hit("fusion", fusionLine(fusion), fusion.shipped ? { agent: fusion.winner } : {}));
      const ship = event.verdict.ship;
      if (ship?.status === "merged" && event.verdict.winner !== null) {
        const commit = ship.commit === undefined ? "" : ` (${ship.commit.slice(0, 7)})`;
        const chosen = ship.resolve?.chosen;
        const raced = chosen === undefined ? "" : `; ${displayName(chosen)} won the conflict race`;
        hits.push(hit("merge", `merged ${displayName(event.verdict.winner)}'s fork${commit}${raced}`, { agent: event.verdict.winner }));
      }
      break;
    }
    case "usage":
    case "watchers":
    case "reaction":
      // Spectators touch no product.
      break;
    case "judge": {
      // The judge Workflow's steps, as they start and end.
      const { name, state: stepState } = event.step;
      const agent = name.startsWith("fork ") ? name.slice(5) : undefined;
      if (agent !== undefined && stepState === "running") hits.push(hit("containers", `judge sandbox: ${displayName(agent)}'s tests + the shared suite`, { agent }));
      if (agent !== undefined && stepState === "done") hits.push(hit("ai", `Clef scored ${displayName(agent)}'s diff, in both file orders`, { agent }));
      if (name === "look" && stepState === "running") hits.push(hit("ai", "screenshots from Browser Rendering for Clef's look score"));
      if (name === "split" && stepState === "done") hits.push(hit("ai", "Clef: does the task split the work?"));
      if (name === "compare" && stepState === "done") hits.push(hit("ai", "Clef compared the tied diffs side by side"));
      if (name === "fuse" && stepState === "running") hits.push(hit("fusion", "fusion round: trying the losers' work on the winner"));
      break;
    }
    default:
      break;
  }
  return { state: next, hits };
}

/** A test file by path; mirrors isTestFile in src/judge/fusion.ts. */
function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path);
}

/** The fusion unit's line: what was added, or how many tries were left out. */
function fusionLine(view: FusionView): string {
  if (view.error !== undefined && view.rows.length === 0) return "fusion round could not run";
  const kept = view.rows.filter((r) => r.outcome === "added");
  const added = [...new Set(kept.map((r) => displayName(r.agent)))];
  // "tests" while only test files were tried (the round before hunks), "work" once code joins.
  const testsOnly = view.rows.every((r) => r.kind === "file" && r.files.every(isTestPath));
  const work = testsOnly ? "tests" : "work";
  if (added.length === 0) return `tried ${view.rows.length} ${view.rows.length === 1 ? "loser's" : "losers'"} ${work}, kept none`;
  return `fused ${added.join(" & ")}'s ${work} into ${displayName(view.winner)}'s fix${view.commit === undefined ? "" : ` (${view.commit})`}`;
}

/** "6.1 s", "820 ms", "1 m 05 s". */
export function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const secs = Math.round(value / 1000);
  return `${Math.floor(secs / 60)} m ${String(secs % 60).padStart(2, "0")} s`;
}
