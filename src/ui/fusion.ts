// The fusion round as the race page shows it: the panel rows, the git graph arrows, the stage act
// and the leaderboard's assists all read this model. Pure, like board.ts.
import type { WireFusion, WireTask, WireVerdict } from "./board";

/** Clef's yes a try must reach to be added. Mirrors FUSE_THRESHOLD in src/judge/fusion.ts (a test checks they match). */
export const FUSE_BAR = 0.6;

/** How one try ended, for its badge. */
export type FuseOutcome = "added" | "rejected" | "failed";

/** One loser's try, ready to draw. */
export interface FuseRow {
  agent: string;
  files: string[];
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
  /** True when the fusion reached main: something was added and the winner merged. */
  shipped: boolean;
  /** Why the round itself did not run. */
  error?: string;
}

const QUESTIONS: Readonly<Record<string, string>> = {
  coverage: "tests something new the task asks?",
  better: "makes the change better?",
};

function outcomeOf(status: string): FuseOutcome {
  return status === "added" || status === "rejected" ? status : "failed";
}

/** The fusion round of a verdict, or undefined when there was none to show. */
export function fusionView(verdict: WireVerdict | undefined): FusionView | undefined {
  const fusion: WireFusion | undefined = verdict?.fusion;
  if (verdict === undefined || verdict.winner === null || fusion === undefined) return undefined;
  if (fusion.tried.length === 0 && fusion.error === undefined) return undefined;
  const rows = fusion.tried.map((t): FuseRow => {
    const row: FuseRow = { agent: t.agent, files: t.files, outcome: outcomeOf(t.status) };
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
  const added = rows.some((r) => r.outcome === "added");
  return {
    winner: verdict.winner,
    rows,
    ...(added && fusion.commit !== undefined ? { commit: fusion.commit.slice(0, 7) } : {}),
    shipped: added && verdict.ship?.status === "merged",
    ...(fusion.error === undefined ? {} : { error: fusion.error }),
  };
}

/** The agents whose files reached main through the fusion round: the race's assists. */
export function assistsOf(task: Pick<WireTask, "verdict">): string[] {
  const view = fusionView(task.verdict);
  if (view === undefined || !view.shipped) return [];
  return [...new Set(view.rows.filter((r) => r.outcome === "added").map((r) => r.agent))];
}
