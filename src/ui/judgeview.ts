// What the race page shows of the judge's work: the tie's photo finish, who passes whose tests,
// Clef's task-fit probabilities and the judge's steps as they run. Pure, like board.ts: it reads
// the public GET /tasks/:id/judge body and the task's judge steps.
import { displayName, type WireJudgeStep } from "./board";

/** Judgment points closer than this tie (mirrors JUDGE_TIE in src/judge/score.ts). */
export const JUDGE_TIE = 0.75;
/** The repo's own test files (mirrors BASE_AUTHOR in src/judge/judge.ts). */
export const BASE_AUTHOR = "base";

/** Passing and total tests. */
export interface TestCount { passed: number; total: number }

/** The top forks that tied within the judge's noise, and how the winner was picked among them. */
export interface TieView {
  agents: string[]; // winner first
  by: string; // "compare", "diff", "finish" or "order"
  gap: number;
  judgment: Record<string, number>; // Clef's points (task fit + clarity + look) per tied agent
  prefer?: Record<string, number>; // the side-by-side vote, when it was asked
}

/** One test file in the shared suite grid. */
export interface CrossColumn {
  author: string; // BASE_AUTHOR or an agent id
  file: string;
  counted: boolean; // false: left out of the shared suite (passed on fewer than two forks, or a split task)
}

/** One fork's row: its result on each column, and its shared suite total. */
export interface CrossRow {
  agent: string;
  cells: (TestCount | undefined)[]; // undefined: the fork did not run that file
  shared?: TestCount;
}

/** Who passes whose tests. */
export interface CrossView {
  columns: CrossColumn[];
  rows: CrossRow[];
  split: boolean; // the task gave robots different parts, so only the repo's tests counted
}

/** One fork as the look step saw it: Clef's two answers, or why it could not be judged. */
export interface LookForkView {
  agent: string;
  look: number; // 0..1
  fit?: number; // 0..1: how completely the page shows what the task asks
  quality?: number; // 0..1: how clean and readable it is
  error?: string;
}

/** The look step's output: the forks it judged, in the score's rank order, and whether the source's before shot exists. */
export interface LookView {
  forks: LookForkView[];
  before: boolean;
}

/** Everything the page draws from the judge's output. */
export interface JudgeView {
  tie?: TieView;
  cross?: CrossView;
  look?: LookView;
  fit: Record<string, number[]>; // Clef's probability of each task-fit level, lowest first
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

function count(x: unknown): TestCount | undefined {
  if (!isObject(x)) return undefined;
  const passed = num(x.passed);
  const total = num(x.total);
  return passed === undefined || total === undefined ? undefined : { passed, total };
}

function tieOf(scores: Record<string, unknown>): TieView | undefined {
  const tie = scores.tie;
  if (!isObject(tie) || !Array.isArray(tie.agents)) return undefined;
  const agents = tie.agents.filter((a): a is string => typeof a === "string");
  const by = str(tie.by);
  const gap = num(tie.gap);
  if (agents.length < 2 || by === undefined || gap === undefined) return undefined;
  const judgment: Record<string, number> = {};
  for (const s of Array.isArray(scores.ranked) ? scores.ranked : []) {
    if (!isObject(s) || !isObject(s.parts) || typeof s.agent !== "string" || !agents.includes(s.agent)) continue;
    judgment[s.agent] = (num(s.parts.taskFit) ?? 0) + (num(s.parts.clarity) ?? 0) + (num(s.parts.look) ?? 0);
  }
  const prefer = isObject(tie.prefer) ? Object.fromEntries(agents.map((a) => [a, num((tie.prefer as Record<string, unknown>)[a]) ?? 0])) : undefined;
  return { agents, by, gap, judgment, ...(prefer === undefined ? {} : { prefer }) };
}

const key = (author: string, file: string): string => `${author}\0${file}`;

/** Base files first, then by author, then by file. */
function columnOrder(a: CrossColumn, b: CrossColumn): number {
  const rank = (c: CrossColumn): string => `${c.author === BASE_AUTHOR ? "0" : "1"}${c.author}\0${c.file}`;
  return rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0;
}

/**
 * The grid of who passes whose tests. `counted` is the judge's list of shared-suite files; verdicts
 * from before it was recorded are counted here by the judge's rules. No fork with a shared total
 * means the judge fell back to each fork's own npm test, so no file counted.
 */
function crossOf(forks: unknown[], split: boolean, counted: unknown): CrossView | undefined {
  const runs = forks.filter(isObject).flatMap((f) => {
    const agent = str(f.agent);
    const shared = isObject(f.input) ? count(f.input.shared) : undefined;
    // Older verdicts: a fork whose run failed has no tests but a shared total of 0; it keeps its row.
    if (agent === undefined || (!Array.isArray(f.crossTests) && shared === undefined)) return [];
    const tests = (Array.isArray(f.crossTests) ? f.crossTests : []).filter(isObject).flatMap((t) => {
      const author = str(t.author);
      const file = str(t.file);
      const c = count(t);
      return author === undefined || file === undefined || c === undefined ? [] : [{ author, file, ...c }];
    });
    return [{ agent, tests, ...(shared === undefined ? {} : { shared }) }];
  });
  if (runs.length === 0) return undefined;
  // Older verdicts: counted as the judge counts it. Files every fork ran and some fork loaded; base files always, others when they pass in full on two forks.
  const passes = new Map<string, number>();
  const ran = new Map<string, number>();
  const size = new Map<string, number>();
  const columns = new Map<string, CrossColumn>();
  for (const run of runs) {
    for (const t of run.tests) {
      const k = key(t.author, t.file);
      if (t.total > 0 && t.passed === t.total) passes.set(k, (passes.get(k) ?? 0) + 1);
      ran.set(k, (ran.get(k) ?? 0) + 1);
      size.set(k, Math.max(size.get(k) ?? 0, t.total));
      columns.set(k, { author: t.author, file: t.file, counted: false });
    }
  }
  const recorded = Array.isArray(counted)
    ? new Set(counted.filter(isObject).flatMap((c) => (typeof c.author === "string" && typeof c.file === "string" ? [key(c.author, c.file)] : [])))
    : undefined;
  const used = runs.some((r) => r.shared !== undefined);
  const isCounted = (k: string, c: CrossColumn): boolean =>
    recorded !== undefined ? recorded.has(k) : used && ran.get(k) === runs.length && (size.get(k) ?? 0) > 0 && (c.author === BASE_AUTHOR || (!split && (passes.get(k) ?? 0) >= 2));
  const ordered = [...columns.entries()]
    .map(([k, c]) => ({ ...c, counted: isCounted(k, c) }))
    .toSorted(columnOrder);
  const rows = runs.map((run) => ({
    agent: run.agent,
    cells: ordered.map((c) => {
      const t = run.tests.find((x) => x.author === c.author && x.file === c.file);
      return t === undefined ? undefined : { passed: t.passed, total: t.total };
    }),
    ...(run.shared === undefined ? {} : { shared: run.shared }),
  }));
  return { columns: ordered, rows, split };
}

function fitOf(forks: unknown[]): Record<string, number[]> {
  const fit: Record<string, number[]> = {};
  for (const f of forks) {
    if (!isObject(f) || typeof f.agent !== "string" || !isObject(f.scorer) || !isObject(f.scorer.raw)) continue;
    const answer = f.scorer.raw.taskFit;
    if (!isObject(answer) || !isObject(answer.probabilities)) continue;
    const probs = answer.probabilities;
    const levels = Object.keys(probs).map(Number).filter((n) => Number.isInteger(n) && n >= 0).toSorted((a, b) => a - b);
    if (levels.length < 2) continue;
    fit[f.agent] = levels.map((n) => num(probs[String(n)]) ?? 0);
  }
  return fit;
}

/** The look view: only when the race was judged on look. Forks follow `ranked`'s order; one Clef could not score keeps its error. */
function lookOf(look: unknown, ranked: unknown): LookView | undefined {
  if (!isObject(look) || look.judged !== true || !Array.isArray(look.forks)) return undefined;
  const order = Array.isArray(ranked) ? ranked.filter(isObject).map((s) => s.agent).filter((a): a is string => typeof a === "string") : [];
  const forks = look.forks.filter(isObject).flatMap((f): LookForkView[] => {
    const agent = str(f.agent);
    const value = num(f.look);
    if (agent === undefined || value === undefined) return [];
    const fit = num(f.fit);
    const quality = num(f.quality);
    const error = str(f.error);
    return [{ agent, look: value, ...(fit === undefined ? {} : { fit }), ...(quality === undefined ? {} : { quality }), ...(error === undefined ? {} : { error }) }];
  });
  const rank = (a: string): number => (order.includes(a) ? order.indexOf(a) : order.length);
  return { forks: forks.toSorted((a, b) => rank(a.agent) - rank(b.agent)), before: str(look.before) === undefined };
}

/** The judge view from a GET /tasks/:id/judge body, or undefined when it has no output yet. */
export function judgeView(body: unknown): JudgeView | undefined {
  if (!isObject(body) || !isObject(body.output)) return undefined;
  const out = body.output;
  const forks = Array.isArray(out.forks) ? out.forks : [];
  const split = (num(out.split) ?? 0) >= 0.5;
  const tie = isObject(out.scores) ? tieOf(out.scores) : undefined;
  const cross = crossOf(forks, split, out.counted);
  const look = lookOf(out.look, isObject(out.scores) ? out.scores.ranked : undefined);
  return { ...(tie === undefined ? {} : { tie }), ...(cross === undefined ? {} : { cross }), ...(look === undefined ? {} : { look }), fit: fitOf(forks) };
}

/** One step of the judge as the page lists it. */
export interface JudgeStepView {
  name: string;
  label: string; // what the step does, for the tooltip
  short: string; // the chip's text
  state: "waiting" | "running" | "done" | "failed";
}

function stepShort(name: string): string {
  if (name.startsWith("fork ")) return displayName(name.slice(5));
  const labels: Record<string, string> = { look: "Look", split: "Split?", compare: "Side by side", fuse: "Fusion", ship: "Ship" };
  return labels[name] ?? name;
}

function stepLabel(name: string): string {
  if (name.startsWith("fork ")) return `${displayName(name.slice(5))}: tests + Clef`;
  const labels: Record<string, string> = { look: "Look: screenshots", split: "Split task?", compare: "Side by side", fuse: "Fusion round", ship: "Ship: merge" };
  return labels[name] ?? name;
}

/**
 * The judge's steps in run order: one per fork, then the look, the split check, the side-by-side
 * comparison, the fusion round and the ship. Forks, fusion and ship always run, so they show as
 * waiting until they start; the others show once they start.
 */
export function judgeSteps(agents: string[], steps: WireJudgeStep[]): JudgeStepView[] {
  const always = [...agents.map((a) => `fork ${a}`), "look", "split", "compare", "fuse", "ship"];
  const sometimes = new Set(["look", "split", "compare"]);
  return always.flatMap((name): JudgeStepView[] => {
    const step = steps.find((s) => s.name === name);
    if (step === undefined && sometimes.has(name)) return [];
    return [{ name, label: stepLabel(name), short: stepShort(name), state: step?.state ?? "waiting" }];
  });
}
