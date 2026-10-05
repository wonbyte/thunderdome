// The race board: a pure model of a race built from the task, its steps, its claims and live
// events. No DOM, no Worker globals, no imports, so it runs in the browser and in plain Node tests.
// Every function returns new objects and never changes its inputs.

// Wire types mirror the server's (Task, LoggedStep, ClaimBoard, LiveEvent, ForkScore), keeping
// only the fields the board reads, so a real server value is assignable to them.
export interface WirePreview { url: string; commit: string; at: string }
export type WireTaskStatus = "creating" | "ready" | "running" | "finished" | "failed";
export type WireAgentStatus = "idle" | "starting" | "running" | "done" | "failed" | "timeout";
export interface WireAgent {
  name: string; // mirrors AgentSlot.name (the server field is `name`, not `agent`)
  status: WireAgentStatus;
  startedAt?: string;
  endedAt?: string;
  push?: {
    commits: number;
    pushes?: number;
    lastPushAt?: string;
    head?: string;
    seen?: string[];
    preview?: WirePreview;
    log?: { at: string; commit: string; commits: number; message?: string }[]; // tasks from before the log have none
  };
  costUsd?: number;
}
export interface WireVerdict {
  winner: string | null;
  why: string;
  judgedAt?: string;
  ship?: { status: string; commit?: string; resolve?: { chosen?: string } };
}
export interface WireTask {
  id: string;
  prompt: string;
  status: WireTaskStatus;
  startedAt?: string;
  finishedAt?: string;
  agents: WireAgent[];
  createdAt?: string;
  verdict?: WireVerdict;
  basePreview?: WirePreview;
}
export interface WireStep { seq: number; agent: string; at: string; kind: string; text: string }
export interface WireClaim { agent: string; file: string; shared: boolean; at: string }
export interface WireClaimBoard { active: WireClaim[]; history: WireClaim[] }
export type WireClaimResult =
  | { ok: true; claimed: string[]; shared: string[]; clashes: { file: string; heldBy: string[] }[] }
  | { ok: false };
export interface WireScore {
  agent: string;
  parts: { tests: number; taskFit: number; clarity: number; look?: number; claim: number };
  total: number;
  eligible: boolean;
}
export type BoardEvent =
  | { kind: "snapshot"; taskId: string; task: WireTask | null }
  | { kind: "status"; taskId: string; task: WireTask }
  | { kind: "steps"; taskId: string; agent: string; steps: WireStep[] }
  | { kind: "claim"; taskId: string; agent: string; result: WireClaimResult }
  | { kind: "release"; taskId: string; agent: string; released: string[] }
  | { kind: "push"; taskId: string; agent: string; push: { commits: number; pushes?: number; lastPushAt?: string } }
  | { kind: "preview"; taskId: string; agent: string; preview: WirePreview }
  | { kind: "agent-end"; taskId: string; agent: string; outcome: { end: "done" | "failed" | "timeout" }; status: WireTaskStatus }
  | { kind: "verdict"; taskId: string; verdict: WireVerdict }
  | { kind: "base-preview"; taskId: string; preview: WirePreview };

export const AGENT_COLORS: Readonly<Record<string, string>> = {
  careful: "#d97757",
  fast: "#e5484d",
  tester: "#3e8ed0",
  lean: "#30a46c",
  tidy: "#8e4ec6",
};
// The fighters' names on the page. The agent id (its style) stays the key everywhere else.
export const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  careful: "Dillion",
  fast: "Sam",
  tester: "Leo",
};
export const FALLBACK_COLOR = "#8b8d98";
export const STEP_TEXT_MAX = 120;

// The fighter's name, or the agent id when it has none.
export function displayName(agent: string): string {
  return Object.prototype.hasOwnProperty.call(AGENT_DISPLAY_NAMES, agent) ? (AGENT_DISPLAY_NAMES[agent] ?? agent) : agent;
}

// The judge's why with each agent id swapped for its name. In the score table (an id followed
// by 2+ spaces) the padding changes so the columns stay aligned.
export function whyWithNames(why: string, agents: readonly string[]): string {
  let text = why;
  for (const agent of agents) {
    const name = displayName(agent);
    if (name === agent || !/^[a-z]+$/.test(agent)) continue;
    text = text.replace(new RegExp(`\\b${agent}\\b( {2,})?`, "g"), (_match, pad: string | undefined) =>
      pad === undefined ? name : name + " ".repeat(Math.max(2, agent.length + pad.length - name.length)),
    );
  }
  return text;
}

// The judge's "Decided by …" line from the why, if it has one.
export function decidedLine(why: string | undefined): string | undefined {
  return why?.split("\n").find((line) => line.startsWith("Decided by"));
}

export function colorFor(agent: string): string {
  return Object.prototype.hasOwnProperty.call(AGENT_COLORS, agent) ? (AGENT_COLORS[agent] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
}

export type Action = "idle" | "think" | "scan" | "hammer" | "charge" | "work" | "flag" | "clash" | "push" | "hurt" | "finished" | "down" | "won" | "lost";

const SCAN_TOOLS = ["Read", "Grep", "Glob", "LS"];
const HAMMER_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const TEST_COMMAND = /\b(vitest|jest|pytest|mocha)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?t(est)?\b|--test\b|\btest\b(?!\/)/;

// The robot move for one step. Tool steps are "<Tool> <input>", as src/agents/events.ts writes them.
export function actionForStep(step: Pick<WireStep, "kind" | "text">): Action {
  switch (step.kind) {
    case "text":
      return "think";
    case "claim":
      return "flag";
    case "error":
      return "hurt";
    case "init":
      return "idle";
    case "result":
      return "finished";
    case "tool":
      return actionForTool(step.text);
    default:
      return "idle";
  }
}

function actionForTool(text: string): Action {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const tool = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? "" : trimmed.slice(space + 1);
  if (SCAN_TOOLS.includes(tool)) return "scan";
  if (HAMMER_TOOLS.includes(tool)) return "hammer";
  if (tool === "Bash" && TEST_COMMAND.test(rest)) return "charge";
  return "work";
}

const BUBBLE_MAX = 64;
const SHELL_WORDS = ["for", "if", "while", "until", "set", "export", "(", "{"];
const SHELL_PREFIX = /^(?:cd\s+\S+\s*(?:;|&&)\s*)+/;

function baseName(path: string): string {
  const clean = path.trim().split(/\s/)[0] ?? "";
  return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}

function shortText(text: string): string {
  const flat = text.replace(/[*`#>]/g, "").replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length <= BUBBLE_MAX ? sentence : `${sentence.slice(0, BUBBLE_MAX - 1)}…`;
}

// A short speech-bubble label for a step, e.g. "editing cart.ts" or "running the tests".
// Undefined for a step that should not replace the bubble (an init step).
export function bubbleFor(step: Pick<WireStep, "kind" | "text">): string | undefined {
  const text = step.text.trim();
  switch (step.kind) {
    case "text":
      return shortText(text);
    case "claim":
      return text.startsWith("released") ? "released files" : text.includes("clash") ? "clash on a claim!" : "claimed files";
    case "error":
      return "hit an error";
    case "result":
      return "done";
    case "tool":
      break;
    default:
      return undefined;
  }
  const space = text.search(/\s/);
  const tool = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : text.slice(space + 1).trim();
  if (tool === "Read") return `reading ${baseName(rest)}`;
  if (tool === "Grep" || tool === "Glob" || tool === "LS") return "searching the code";
  if (HAMMER_TOOLS.includes(tool)) return `editing ${baseName(rest)}`;
  if (tool !== "Bash") return `using ${tool}`;
  const command = rest.replace(SHELL_PREFIX, "");
  if (TEST_COMMAND.test(command)) return "running the tests";
  if (/^claim\b/.test(command)) return "claiming files";
  if (/\bgit\s+push\b/.test(command)) return "pushing";
  if (/\bgit\s+commit\b/.test(command)) return "committing";
  const written = /^(?:cat|echo|printf|tee)\b[^>|]*>>?\s*([^\s;&|<]+)/.exec(command)?.[1];
  if (written !== undefined) return `writing ${baseName(written)}`;
  if (/^(cat|head|tail|sed -n|ls|find|grep|rg)\b/.test(command)) return "reading the code";
  const word = command.split(/\s/)[0] ?? "";
  if (SHELL_WORDS.includes(word)) return "running a script";
  return word === "" ? "working" : `running ${word}`;
}

export interface FighterScore { total: number; parts: WireScore["parts"]; eligible: boolean; place: number }
export interface Fighter {
  agent: string;
  color: string;
  status: WireAgentStatus;
  action: Action;
  actionAt: number; // ms (the `now` of the event that set the action)
  lastStep?: string;
  bubble?: string; // short label of the newest step, for the speech bubble
  commits: number;
  preview?: WirePreview;
  files: string[]; // files held now, claim order, no duplicates
  clashFile?: string;
  score?: FighterScore;
}
export type Cell = "own" | "shared";
export interface Grid {
  files: string[]; // sorted, only files someone holds
  cells: Record<string, Record<string, Cell>>; // file -> agent -> cell
  clashes: string[]; // files with 2+ holders, in `files` order
}
export interface Board {
  taskId: string;
  task?: WireTask;
  fighters: Fighter[]; // task agent order
  grid: Grid; // files held now
  claimed: Grid; // every claim of the race, never released; its clashes are the race's clashes
  basePreview?: WirePreview;
  winner?: string | null;
  why?: string;
  ended: boolean;
  lastSeq: number;
}

export function emptyBoard(taskId: string): Board {
  return { taskId, fighters: [], grid: { files: [], cells: {}, clashes: [] }, claimed: { files: [], cells: {}, clashes: [] }, ended: false, lastSeq: 0 };
}

// Built by replaying events, so a page that loads late sees the same board as one that watched live.
export function initBoard(task: WireTask, steps: WireStep[], claims: WireClaimBoard, now: number): Board {
  const taskId = task.id;
  let board = applyEvent(emptyBoard(taskId), { kind: "snapshot", taskId, task }, now);
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    board = applyEvent(board, { kind: "steps", taskId, agent: step.agent, steps: [step] }, now);
  }
  // Agents release their files as they go and when they end, so the history keeps the race's record.
  let claimed = board.claimed.cells;
  for (const claim of claims.history) claimed = withCell(claimed, claim.file, claim.agent, claim.shared ? "shared" : "own");
  board = { ...board, claimed: gridOf(claimed) };
  const holders: Record<string, string[]> = {};
  for (const claim of claims.active) {
    const heldBy = holders[claim.file] ?? [];
    const clashes = heldBy.length > 0 ? [{ file: claim.file, heldBy }] : [];
    const result: WireClaimResult = { ok: true, claimed: [claim.file], shared: claim.shared ? [claim.file] : [], clashes };
    board = applyEvent(board, { kind: "claim", taskId, agent: claim.agent, result }, now);
    holders[claim.file] = [...heldBy, claim.agent];
  }
  return board;
}

export function applyEvent(board: Board, event: BoardEvent, now: number): Board {
  if (event.taskId !== board.taskId) return board;
  switch (event.kind) {
    case "snapshot":
      return event.task === null ? board : syncTask(board, event.task, now);
    case "status":
      return syncTask(board, event.task, now);
    case "steps":
      return applySteps(board, event.steps, now);
    case "claim":
      return applyClaim(board, event.agent, event.result, now);
    case "release":
      return releaseCells(board, event.agent, event.released);
    case "push": {
      const commits = event.push.commits;
      return withFighter(board, event.agent, (f) => ({ ...(isActive(board, f) ? act(f, "push", now) : f), commits }));
    }
    case "preview": {
      const preview = { ...event.preview };
      return withFighter(board, event.agent, (f) => ({ ...f, preview }));
    }
    case "agent-end":
      return applyAgentEnd(board, event.agent, event.outcome.end, event.status, now);
    case "verdict": {
      const { winner, why, judgedAt, ship } = event.verdict;
      const verdict: WireVerdict = {
        winner,
        why,
        ...(judgedAt === undefined ? {} : { judgedAt }),
        ...(ship === undefined ? {} : {
              ship: {
                status: ship.status,
                ...(ship.commit === undefined ? {} : { commit: ship.commit }),
                ...(ship.resolve?.chosen === undefined ? {} : { resolve: { chosen: ship.resolve.chosen } }),
              },
            }),
      };
      const next = board.task === undefined ? board : { ...board, task: { ...board.task, verdict } };
      return applyVerdict(next, verdict, now);
    }
    case "base-preview":
      return { ...board, basePreview: { ...event.preview } };
    default:
      return board;
  }
}

// Gives each fighter its score and place (index in the judge's ranking + 1). Order is unchanged.
export function applyScores(board: Board, ranked: WireScore[]): Board {
  const fighters = board.fighters.map((f) => {
    const place = ranked.findIndex((score) => score.agent === f.agent);
    const score = ranked[place];
    if (score === undefined) return f;
    const { tests, taskFit, clarity, look, claim } = score.parts;
    const parts = { tests, taskFit, clarity, ...(look === undefined ? {} : { look }), claim };
    return { ...f, score: { total: score.total, parts, eligible: score.eligible, place: place + 1 } };
  });
  return { ...board, fighters };
}

function isEnded(status: WireAgentStatus): boolean {
  return status === "done" || status === "failed" || status === "timeout";
}

// A fighter whose action may still change with steps, claims and pushes.
function isActive(board: Board, f: Fighter): boolean {
  return !board.ended && !isEnded(f.status);
}

function endAction(status: WireAgentStatus): Action | undefined {
  if (status === "done") return "finished";
  if (status === "failed" || status === "timeout") return "down";
  return undefined;
}

// Sets an action and its time; each new move re-triggers the animation.
function act(f: Fighter, action: Action, now: number): Fighter {
  return { ...f, action, actionAt: now };
}

// Sets an action only when it differs, so a resync does not replay the animation.
function settle(f: Fighter, action: Action, now: number): Fighter {
  return f.action === action ? f : act(f, action, now);
}

function withFighter(board: Board, agent: string, change: (f: Fighter) => Fighter): Board {
  if (!board.fighters.some((f) => f.agent === agent)) return board;
  return { ...board, fighters: board.fighters.map((f) => (f.agent === agent ? change(f) : f)) };
}

function syncTask(board: Board, task: WireTask, now: number): Board {
  const fighters = task.agents.map((slot) => syncFighter(board.fighters.find((f) => f.agent === slot.name), slot, now));
  const basePreview = task.basePreview ?? board.basePreview;
  const next: Board = { ...board, task, fighters, ...(basePreview === undefined ? {} : { basePreview }) };
  return task.verdict === undefined ? next : applyVerdict(next, task.verdict, now);
}

function syncFighter(old: Fighter | undefined, slot: WireAgent, now: number): Fighter {
  const base: Fighter = old ?? { agent: slot.name, color: colorFor(slot.name), status: slot.status, action: "idle", actionAt: now, commits: 0, files: [] };
  const preview = slot.push?.preview ?? old?.preview;
  let f: Fighter = {
    ...base,
    status: slot.status,
    commits: slot.push?.commits ?? old?.commits ?? 0,
    ...(preview === undefined ? {} : { preview }),
  };
  const end = endAction(slot.status);
  if (end !== undefined && f.action !== "won" && f.action !== "lost") f = settle(f, end, now);
  return f;
}

function clipStep(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= STEP_TEXT_MAX ? flat : `${flat.slice(0, STEP_TEXT_MAX - 1)}…`;
}

// Steps at or below lastSeq were already seen (a reload replays them).
function applySteps(board: Board, steps: WireStep[], now: number): Board {
  let next = board;
  for (const step of steps) {
    if (step.seq <= next.lastSeq) continue;
    const lastStep = clipStep(step.text);
    const bubble = bubbleFor(step);
    const current = next;
    next = withFighter({ ...current, lastSeq: step.seq }, step.agent, (f) => ({
      ...(isActive(current, f) ? act(f, actionForStep(step), now) : f),
      lastStep,
      ...(bubble === undefined ? {} : { bubble }),
    }));
  }
  return next;
}

function applyClaim(board: Board, agent: string, result: WireClaimResult, now: number): Board {
  if (!result.ok) return board;
  const cells = { ...board.grid.cells };
  for (const file of result.claimed) {
    cells[file] = { ...(cells[file] ?? {}), [agent]: result.shared.includes(file) ? "shared" : "own" };
  }
  let claimed = board.claimed.cells;
  for (const file of result.claimed) claimed = withCell(claimed, file, agent, result.shared.includes(file) ? "shared" : "own");
  let next = withFighter({ ...board, grid: gridOf(cells), claimed: gridOf(claimed) }, agent, (f) => ({
    ...f,
    files: [...f.files, ...result.claimed.filter((file, i) => !f.files.includes(file) && result.claimed.indexOf(file) === i)],
  }));
  for (const clash of result.clashes) {
    for (const holder of [...clash.heldBy, agent]) {
      const current = next;
      next = withFighter(current, holder, (f) => ({ ...(isActive(current, f) ? act(f, "clash", now) : f), clashFile: clash.file }));
    }
  }
  return next;
}

// A shared cell stays shared once it was.
function withCell(cells: Grid["cells"], file: string, agent: string, cell: Cell): Grid["cells"] {
  const row = cells[file] ?? {};
  const kept = row[agent] === "shared" ? "shared" : cell;
  return { ...cells, [file]: { ...row, [agent]: kept } };
}

// Frees the agent's cells for the given files and clears clash marks that no longer hold.
function releaseCells(board: Board, agent: string, files: string[]): Board {
  const cells: Grid["cells"] = {};
  for (const [file, row] of Object.entries(board.grid.cells)) {
    if (!files.includes(file)) {
      cells[file] = row;
      continue;
    }
    const { [agent]: _released, ...rest } = row;
    cells[file] = rest;
  }
  const grid = gridOf(cells);
  const fighters = board.fighters.map((f) => {
    const kept = f.agent === agent ? { ...f, files: f.files.filter((file) => !files.includes(file)) } : f;
    if (kept.clashFile === undefined || grid.clashes.includes(kept.clashFile)) return kept;
    const { clashFile: _cleared, ...rest } = kept;
    return rest;
  });
  return { ...board, grid, fighters };
}

// Rows with no holder are dropped; a file with 2+ holders is a clash.
function gridOf(cells: Grid["cells"]): Grid {
  const kept: Grid["cells"] = {};
  for (const [file, row] of Object.entries(cells)) {
    if (Object.keys(row).length > 0) kept[file] = row;
  }
  const files = Object.keys(kept).sort();
  const clashes = files.filter((file) => Object.keys(kept[file] ?? {}).length >= 2);
  return { files, cells: kept, clashes };
}

// The server frees an ended agent's files without a release event, so the board does too.
function applyAgentEnd(board: Board, agent: string, end: "done" | "failed" | "timeout", status: WireTaskStatus, now: number): Board {
  const at = new Date(now).toISOString();
  let next = board;
  if (board.task !== undefined) {
    const task = board.task;
    const agents = task.agents.map((slot) => (slot.name === agent ? { ...slot, status: end, endedAt: slot.endedAt ?? at } : slot));
    const finishedAt = task.finishedAt ?? (status === "finished" ? at : undefined);
    next = { ...board, task: { ...task, agents, status, ...(finishedAt === undefined ? {} : { finishedAt }) } };
  }
  next = withFighter(next, agent, (f) => {
    const ended = { ...f, status: end };
    return f.action === "won" || f.action === "lost" ? ended : settle(ended, end === "done" ? "finished" : "down", now);
  });
  const held = Object.keys(next.grid.cells).filter((file) => next.grid.cells[file]?.[agent] !== undefined);
  return held.length > 0 ? releaseCells(next, agent, held) : next;
}

// The winner wins and the rest lose; with no winner, each robot just finishes or goes down.
function applyVerdict(board: Board, verdict: { winner: string | null; why: string }, now: number): Board {
  const { winner, why } = verdict;
  const fighters = board.fighters.map((f) => {
    if (winner !== null) return settle(f, f.agent === winner ? "won" : "lost", now);
    return settle(f, f.status === "failed" || f.status === "timeout" ? "down" : "finished", now);
  });
  return { ...board, fighters, winner, why, ended: true };
}
