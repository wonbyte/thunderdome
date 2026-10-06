// The fusion round as the race page shows it: the panel rows, the git graph arrows, the stage act
// and the leaderboard's assists all read this model. Pure, like board.ts.
import { displayName, type WireFuseScore, type WireFuseTry, type WireFusion, type WireTask, type WireVerdict } from "./board";

/** Clef's yes a try must reach to be added. Mirrors FUSE_THRESHOLD in src/judge/fusion.ts (a test checks they match). */
export const FUSE_BAR = 0.6;

/** How one try ended, for its badge. */
export type FuseOutcome = "added" | "rejected" | "failed";

/** One loser's try, ready to draw. */
export interface FuseRow {
  agent: string;
  files: string[];
  /** "file": whole files the winner never touched; "hunk": one hunk of a file both changed. */
  kind: "file" | "hunk";
  /** What was tried, in a few words: "test/ponder.test.ts", or "cartMessage in src/cart.ts". */
  what: string;
  outcome: FuseOutcome;
  /** "23/23", when the tests ran. */
  tests?: string;
  /** True when every test passed. */
  green?: boolean;
  /** Clef's yes (0..1), when Clef was asked. */
  clef?: number;
  /** What Clef was asked, in a few words. */
  asked?: string;
  /** Why it was not added. */
  note?: string;
}

/** The whole round, ready to draw. */
export interface FusionView {
  winner: string;
  rows: FuseRow[];
  /** The fusion commit on the winner's fork, short, only when something was added. */
  commit?: string;
  /** The same commit's full hash, for GET /tasks/:id/commits/:sha. */
  hash?: string;
  /** Who wrote the fusion commit (the head): the last loser whose files were added. */
  author?: string;
  /** True when the fusion reached main: something was added and the winner merged. */
  shipped: boolean;
  /** Why the round itself did not run. */
  error?: string;
  /** The winner alone vs the fused head, when the round scored it and that decided something. */
  score?: FuseScoreView;
  /** Why the fused head was not scored (the fusion was kept on its gates). */
  scoreNote?: string;
}

/** The fused score, ready to draw: both totals, the tests, and what the score decided. */
export interface FuseScoreView {
  before: number;
  after: number;
  /** after - before, 1 decimal. */
  delta: number;
  testsBefore: string; // "20/20"
  testsAfter: string;
  /** True when the fusion was kept: it scored at least the winner alone, or it added only tests. */
  kept: boolean;
  /** "Testy alone 91.9 → fused 94.6 · tests 20 → 26". */
  headline: string;
}

const QUESTIONS: Readonly<Record<string, string>> = {
  coverage: "tests something new the task asks?",
  better: "makes the change better?",
};

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * A hunk in a few words: "cartMessage in src/cart.ts", or "lines 12-18 of src/cart.ts". Mirrors
 * hunkLabel in src/judge/fusion.ts (a test checks they match).
 */
export function hunkWhat(hunk: { file: string; header: string; name?: string }): string {
  if (hunk.name !== undefined) return `${hunk.name} in ${hunk.file}`;
  const m = /\+(\d+)(?:,(\d+))?/.exec(hunk.header);
  const start = Number(m?.[1] ?? 0);
  const count = m?.[2] === undefined ? 1 : Number(m[2]);
  return count <= 1 ? `line ${start} of ${hunk.file}` : `lines ${start}-${start + count - 1} of ${hunk.file}`;
}

/** What one try tried, in a few words. */
function whatOf(t: WireFuseTry): string {
  return t.kind === "hunk" && t.hunk !== undefined ? hunkWhat(t.hunk) : t.files.join(", ");
}

const finite = (s: WireFuseScore | undefined): s is WireFuseScore =>
  s !== undefined && Number.isFinite(s.total) && Number.isFinite(s.tests?.passed) && Number.isFinite(s.tests?.total);

/** The score view: shown when the fusion was kept with a score, or dropped because of it. */
function scoreOf(fusion: WireFusion, winner: string): FuseScoreView | undefined {
  const s = fusion.score;
  if (s === undefined || !finite(s.before) || !finite(s.after)) return undefined;
  const higher = s.after.total >= s.before.total;
  // Kept: pushed. A tests-only fusion is kept even when it scores lower (tests cannot raise it).
  const kept = fusion.commit !== undefined;
  // A fusion that scored well but was not pushed (the push failed) has nothing to show.
  if (higher && !kept) return undefined;
  const before = round1(s.before.total);
  const after = round1(s.after.total);
  const tests = `tests ${s.before.tests.passed} → ${s.after.tests.passed}`;
  const headline = !kept
    ? `Fused ${after.toFixed(1)} < ${displayName(winner)} alone ${before.toFixed(1)}: the fusion was dropped`
    : higher
      ? `${displayName(winner)} alone ${before.toFixed(1)} → fused ${after.toFixed(1)} · ${tests}`
      : `${displayName(winner)} alone ${before.toFixed(1)} → fused ${after.toFixed(1)} · ${tests} · tests only, kept`;
  return {
    before,
    after,
    delta: round1(s.after.total - s.before.total),
    testsBefore: `${s.before.tests.passed}/${s.before.tests.total}`,
    testsAfter: `${s.after.tests.passed}/${s.after.tests.total}`,
    kept,
    headline,
  };
}

function outcomeOf(status: string): FuseOutcome {
  return status === "added" || status === "rejected" ? status : "failed";
}

/** The fusion round of a verdict, or undefined when there was none to show. */
export function fusionView(verdict: WireVerdict | undefined): FusionView | undefined {
  const fusion: WireFusion | undefined = verdict?.fusion;
  if (verdict === undefined || verdict.winner === null || fusion === undefined) return undefined;
  if (fusion.tried.length === 0 && fusion.error === undefined) return undefined;
  const rows = fusion.tried.map((t): FuseRow => {
    const row: FuseRow = { agent: t.agent, files: t.files, kind: t.kind === "hunk" ? "hunk" : "file", what: whatOf(t), outcome: outcomeOf(t.status) };
    if (t.tests !== undefined) {
      row.tests = `${t.tests.passed}/${t.tests.total}`;
      row.green = t.tests.total > 0 && t.tests.passed === t.tests.total;
    }
    if (typeof t.better === "number" && Number.isFinite(t.better)) row.clef = Math.min(1, Math.max(0, t.better));
    const asked = t.question === undefined ? undefined : QUESTIONS[t.question];
    if (asked !== undefined) row.asked = asked;
    if (t.note !== undefined && row.outcome !== "added") row.note = t.note;
    return row;
  });
  const author = rows.findLast((r) => r.outcome === "added")?.agent;
  const added = author !== undefined;
  const score = scoreOf(fusion, verdict.winner);
  return {
    winner: verdict.winner,
    rows,
    ...(added && fusion.commit !== undefined ? { commit: fusion.commit.slice(0, 7), hash: fusion.commit, author } : {}),
    shipped: added && verdict.ship?.status === "merged",
    ...(fusion.error === undefined ? {} : { error: fusion.error }),
    ...(score === undefined ? {} : { score }),
    ...(fusion.scoreNote === undefined ? {} : { scoreNote: fusion.scoreNote }),
  };
}

const barWidth = (x: number): number => Math.max(0, Math.min(100, x));

/**
 * The fused score's two bars, as shares of 100 points: the winner alone and the fused head, with
 * an aria-label that reads both. Undefined without a score.
 */
export function scoreBars(view: FusionView): { label: string; bars: { key: "before" | "after"; name: string; total: number; width: number; tests: string }[] } | undefined {
  const s = view.score;
  if (s === undefined) return undefined;
  const winner = displayName(view.winner);
  const bars = [
    { key: "before" as const, name: `${winner} alone`, total: s.before, width: barWidth(s.before), tests: s.testsBefore },
    { key: "after" as const, name: "Fused", total: s.after, width: barWidth(s.after), tests: s.testsAfter },
  ];
  const sign = s.delta > 0 ? "+" : "";
  return { label: `${winner} alone scored ${s.before.toFixed(1)} with tests ${s.testsBefore}; fused scored ${s.after.toFixed(1)} with tests ${s.testsAfter} (${sign}${s.delta.toFixed(1)})`, bars };
}

/** The agents whose files reached main through the fusion round: the race's assists. */
export function assistsOf(task: Pick<WireTask, "verdict">): string[] {
  const view = fusionView(task.verdict);
  if (view === undefined || !view.shipped) return [];
  return [...new Set(view.rows.filter((r) => r.outcome === "added").map((r) => r.agent))];
}
