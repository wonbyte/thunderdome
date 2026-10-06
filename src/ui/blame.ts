// "Who wrote main": the shipped change's lines by robot, from the git blame the ship saved
// (verdict.ship.blame). Pure, like board.ts: the race page and its tests read this model.
import { colorFor, displayName, type WireVerdict } from "./board";

/** One author's share of the shipped lines. */
export interface BlameShare {
  /** An agent name, "thunderdome" (lines the merge itself wrote) or "other". */
  key: string;
  name: string;
  color: string;
  lines: number;
  /** Whole percent; the shares add up to 100. */
  pct: number;
  /** True for the winner. */
  winner: boolean;
}

/** The bar, ready to draw: the shares in order and an aria-label that reads them all. */
export interface BlameView {
  total: number;
  shares: BlameShare[];
  /** Lines shipped by robots that lost: fused files and hunks. */
  losers: number;
  label: string;
}

/** Neutral colors for the lines no robot wrote. Mirror --dim and --faint in race.css. */
const NEUTRAL: Readonly<Record<string, string>> = { thunderdome: "#8a90a6", other: "#7d839b" };

function nameOf(key: string): string {
  if (key === "thunderdome") return "Thunderdome";
  if (key === "other") return "Others";
  return displayName(key);
}

/** Whole percents that add up to 100: the largest remainders get the leftover points. */
export function wholePercents(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).toSorted((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

/**
 * The blame bar of a merged race: the winner first, then the other robots by lines, then
 * Thunderdome and others. Undefined when the verdict has no blame (older races) or no lines.
 */
export function blameView(verdict: WireVerdict | undefined): BlameView | undefined {
  const blame = verdict?.ship?.blame;
  if (verdict === undefined || blame === undefined || verdict.ship?.status !== "merged") return undefined;
  const entries = Object.entries(blame).filter(([, n]) => Number.isFinite(n) && n > 0);
  const rank = (key: string): number => (key === verdict.winner ? 0 : key in NEUTRAL ? 2 : 1);
  entries.sort(([a, x], [b, y]) => rank(a) - rank(b) || y - x || a.localeCompare(b));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return undefined;
  const pcts = wholePercents(entries.map(([, n]) => n));
  const shares = entries.map(([key, lines], i): BlameShare => ({
    key,
    name: nameOf(key),
    color: NEUTRAL[key] ?? colorFor(key),
    lines,
    pct: pcts[i] ?? 0,
    winner: key === verdict.winner,
  }));
  const losers = shares.filter((s) => !s.winner && !(s.key in NEUTRAL)).reduce((sum, s) => sum + s.lines, 0);
  const label = `Who wrote main: ${shares.map((s) => `${s.name} ${s.pct}% (${s.lines} ${s.lines === 1 ? "line" : "lines"})`).join(", ")}`;
  return { total, shares, losers, label };
}
