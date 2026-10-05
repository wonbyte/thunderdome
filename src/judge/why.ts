// Pure: builds the plain-text "why" for the merge commit body from score results.
import { endedMs, type ForkScore, type ScoreParts, type ScoreResult } from "./score";

export const REASON_COUNT = 3;
// Code points (tests + task fit + clarity) closer than this count as a tie on code.
export const CODE_TIE = 1;

// What decided a race with a winner and an eligible runner-up. "same": the winner and the
// runner-up wrote the same fix, so no score of the code could tell them apart.
export type DecidedBy = "code" | "claims" | "close" | "same";

type PartKey = keyof ScoreParts;

const PART_LABELS: Record<PartKey, string> = {
  tests: "tests",
  taskFit: "task fit",
  clarity: "clarity",
  claim: "claim",
};
const PART_KEYS: PartKey[] = ["tests", "taskFit", "clarity", "claim"];

// Diff size has no points; a smaller diff ranks just after any real point margin (points have 2 decimals).
const DIFF_MARGIN = 0.001;
// A tie-break that decided the winner ranks after diff size but ahead of level parts.
const TIE_MARGIN = DIFF_MARGIN / 2;

const HEADER = ["agent", "tests", "task fit", "clarity", "claim", "total"];

function testsCell(score: ForkScore): string {
  return `${score.input.testsPassed}/${score.input.testsTotal} (${score.parts.tests})`;
}

function tableRow(score: ForkScore): string[] {
  const { parts } = score;
  return [score.agent, testsCell(score), String(parts.taskFit), String(parts.clarity), String(parts.claim), String(score.total)];
}

// Pads every column to its widest cell; columns are separated by two spaces.
function formatRows(rows: string[][]): string {
  const widths = HEADER.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd()).join("\n");
}

// Header row: agent | tests | task fit | clarity | claim | total. One row per fork in ranked order.
export function scoresTable(ranked: ForkScore[]): string {
  return formatRows([HEADER, ...ranked.map(tableRow)]);
}

interface Reason {
  margin: number;
  text: string;
}

function bestOther(others: ForkScore[], key: PartKey): number | undefined {
  return others.length === 0 ? undefined : Math.max(...others.map((o) => o.parts[key]));
}

function partDetail(winner: ForkScore, key: PartKey): string {
  const points = winner.parts[key];
  if (key === "tests") return `${winner.input.testsPassed}/${winner.input.testsTotal} passed, ${points} points`;
  if (key === "claim") {
    if (!winner.claimKept) return `changed unclaimed files (${winner.unclaimed.join(", ")}), ${points} points`;
    if (winner.shared.length > 0) return `changed files it held only as shared (${winner.shared.join(", ")}), ${points} points`;
    const free =
      winner.unavoidable.length > 0 ? `; its shared files (${winner.unavoidable.join(", ")}) cost nothing, since every other fork changed them too` : "";
    return `kept its file claim, ${points} points${free}`;
  }
  return `${points} points`;
}

function partReason(winner: ForkScore, others: ForkScore[], key: PartKey): Reason {
  const best = bestOther(others, key);
  const label = PART_LABELS[key];
  const head = `${label[0]?.toUpperCase()}${label.slice(1)}: ${partDetail(winner, key)}`;
  if (best === undefined) return { margin: winner.parts[key], text: `${head}.` };
  const margin = winner.parts[key] - best;
  // Only a positive margin is a reason it won; level or behind is said plainly.
  if (margin > 0) return { margin, text: `${head} vs ${best} for the best other fork.` };
  if (margin === 0) return { margin, text: `${head}, level with the best other fork.` };
  return { margin, text: `${head}, behind ${best} for the best other fork, made up on other parts.` };
}

function diffReason(winner: ForkScore, others: ForkScore[]): Reason {
  const lines = winner.input.linesChanged;
  if (others.length === 0) return { margin: -Infinity, text: `Diff size: ${lines} lines changed.` };
  const smallest = Math.min(...others.map((o) => o.input.linesChanged));
  return {
    margin: lines < smallest ? DIFF_MARGIN : -Infinity,
    text: `Diff size: ${lines} lines changed vs ${smallest} for the smallest other fork.`,
  };
}

// "12 s" or "2 min 5 s".
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Rivals level with the winner on total and diff size, so a tie-break picked the winner.
function tiedWith(winner: ForkScore, rivals: ForkScore[]): ForkScore[] {
  return rivals.filter((o) => o.total === winner.total && o.input.linesChanged === winner.input.linesChanged);
}

// How a tie was broken: by finish time when the winner ended first, else by agent order.
function tieReason(winner: ForkScore, rivals: ForkScore[]): Reason | undefined {
  const tied = tiedWith(winner, rivals);
  if (tied.length === 0) return undefined;
  const names = tied.map((o) => o.agent).join(", ");
  const mine = endedMs(winner.input);
  const next = Math.min(...tied.map((o) => endedMs(o.input)));
  if (mine < next) {
    const ahead = Number.isFinite(next) ? `, ${duration(next - mine)} earlier` : "";
    return { margin: TIE_MARGIN, text: `Finish: tied with ${names} on points and diff size, and finished first${ahead}.` };
  }
  return { margin: TIE_MARGIN, text: `Tie: level with ${names} on points, diff size and finish time; won on agent order.` };
}

// Exactly 3 reasons, each a sentence without the leading "- ", derived from score parts
// (tests, task fit, clarity, claim, diff size) ordered by the winner's margin over the best other fork.
// Only forks that could win are compared: beating an ineligible fork is not a reason.
export function winnerReasons(winner: ForkScore, others: ForkScore[]): string[] {
  const rivals = others.filter((o) => o.eligible);
  const tie = tieReason(winner, rivals);
  const reasons = [
    ...PART_KEYS.map((key) => partReason(winner, rivals, key)),
    diffReason(winner, rivals),
    ...(tie ? [tie] : []),
  ];
  // Stable sort: equal margins keep the fixed part order.
  return reasons
    .sort((a, b) => b.margin - a.margin)
    .slice(0, REASON_COUNT)
    .map((r) => r.text);
}

// The part where the loser trails the winner the most, if it trails on any.
function worstPart(loser: ForkScore, winner: ForkScore): PartKey | undefined {
  let worst: PartKey | undefined;
  let gap = 0;
  for (const key of PART_KEYS) {
    const d = winner.parts[key] - loser.parts[key];
    if (d > gap) [worst, gap] = [key, d];
  }
  return worst;
}

// One line for a loser: its total and the part where it lost the most, or why it could not win.
export function loserLine(loser: ForkScore, winner: ForkScore | undefined): string {
  const head = `${loser.agent} (${loser.total}/100)`;
  if (!loser.eligible) {
    return loser.input.testsPassed > 0 ? `${head}: changed no files, cannot win.` : `${head}: 0 tests passed, cannot win.`;
  }
  if (!winner) return `${head}.`;
  const key = worstPart(loser, winner);
  if (key) return `${head}: lost most on ${PART_LABELS[key]} (${loser.parts[key]} vs ${winner.parts[key]}).`;
  if (loser.input.linesChanged !== winner.input.linesChanged) {
    return `${head}: no lower part, lost on diff size (${loser.input.linesChanged} vs ${winner.input.linesChanged} lines changed).`;
  }
  const late = endedMs(loser.input) - endedMs(winner.input);
  if (late > 0) {
    const after = Number.isFinite(late) ? ` ${duration(late)}` : "";
    return `${head}: tied on points and diff size, finished${after} after ${winner.agent}.`;
  }
  return `${head}: tied on points, diff size and finish time, lost on agent order.`;
}

// Local copy: score.ts does not export it.
const round2 = (x: number): number => Math.round(x * 100) / 100;

// 2 decimals without trailing zeros: 0.55, 1, 18.8.
function num(x: number): string {
  return String(round2(x));
}

function codePoints(s: ForkScore): number {
  return s.parts.tests + s.parts.taskFit + s.parts.clarity;
}

// The highest-ranked eligible fork other than the winner.
function runnerUp(result: ScoreResult, winner: ForkScore): ForkScore | undefined {
  return result.ranked.find((s) => s.eligible && s !== winner);
}

function claimVerb(winner: ForkScore, runner: ForkScore): string {
  // A clash only costs when another fork did without the file, so the runner-up could have avoided it.
  return runner.shared.length > 0 && winner.shared.length === 0 ? `had no avoidable clash and ${runner.agent} did` : "kept its file claim";
}

// Which case decided the race. Shared by headline and decidedBy so they cannot drift.
type Decision = {
  kind: "code" | "claims-within" | "claims-lower" | "close" | "same";
  winner: ForkScore;
  runner: ForkScore;
  gap: number;
  abs: number;
  same: ForkScore[]; // eligible forks other than the winner with the winner's fix
};

// undefined with no winner or no eligible runner-up.
function decision(result: ScoreResult): Decision | undefined {
  const winner = result.winner === null ? undefined : result.ranked.find((s) => s.agent === result.winner);
  const runner = winner ? runnerUp(result, winner) : undefined;
  if (!winner || !runner) return undefined;
  // Rounded first so float noise cannot change the case; Math.abs keeps -0 from printing.
  const gap = round2(codePoints(winner) - codePoints(runner));
  const abs = Math.abs(gap);
  const same = winner.input.fix === undefined ? [] : result.ranked.filter((s) => s !== winner && s.eligible && s.input.fix === winner.input.fix);
  const base = { winner, runner, gap, abs, same };
  if (same.includes(runner)) return { kind: "same", ...base };
  if (gap >= CODE_TIE) return { kind: "code", ...base };
  if (abs < CODE_TIE && winner.parts.claim - runner.parts.claim > 0) return { kind: "claims-within", ...base };
  if (gap <= -CODE_TIE) return { kind: "claims-lower", ...base };
  return { kind: "close", ...base };
}

// One plain-text line naming what decided the race; undefined with no winner or no eligible runner-up.
export function headline(result: ScoreResult): string | undefined {
  const d = decision(result);
  if (!d) return undefined;
  const { winner, runner, gap, abs } = d;
  const [w, r] = [winner.agent, runner.agent];
  const [wClaim, rClaim] = [winner.parts.claim, runner.parts.claim];
  switch (d.kind) {
    case "code":
      return `Decided by code: ${w}'s fix scored ${num(gap)} more points on tests, task fit and clarity than ${r}'s.`;
    case "claims-within": {
      const though = gap < 0 ? ` even though its code scored ${num(abs)} lower` : "";
      return `Decided by claims: the fixes were within ${num(abs)} points on code; ${w} ${claimVerb(winner, runner)} (${num(wClaim)} vs ${num(rClaim)} claim points)${though}.`;
    }
    case "claims-lower":
      return `Decided by claims: ${w}'s code scored ${num(abs)} points lower than ${r}'s, but its claim points made up for it (${num(wClaim)} vs ${num(rClaim)}).`;
    case "close":
      return `Decided by a close margin: the fixes were within ${num(abs)} points on code.`;
    case "same":
      return sameHeadline(winner, d.same);
  }
}

// The same fix from several forks: no score of the code can separate them, so say what did.
function sameHeadline(winner: ForkScore, same: ForkScore[]): string {
  const names = [winner, ...same].map((s) => s.agent);
  const who = names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const head = `${who} wrote the same fix`;
  const next = same[0];
  if (next === undefined) return `Decided by finish time: ${head}.`;
  // The same code can still score differently, for example from a flaky test or an unclaimed file.
  if (winner.total !== next.total) {
    const key = worstPart(next, winner);
    const on = key === undefined ? "" : ` on ${PART_LABELS[key]}`;
    return `Decided by score on the same code: ${head}; ${winner.agent} scored ${num(winner.total - next.total)} more points${on}.`;
  }
  // Blank lines and whitespace are not part of the fix but still count toward diff size.
  const lines = next.input.linesChanged - winner.input.linesChanged;
  if (lines > 0) return `Decided by diff size: ${head}; ${winner.agent}'s diff was ${lines} ${lines === 1 ? "line" : "lines"} smaller (blank lines or whitespace).`;
  const ahead = endedMs(next.input) - endedMs(winner.input);
  if (ahead > 0) return `Decided by finish time: ${head}; ${winner.agent} finished first${Number.isFinite(ahead) ? `, ${duration(ahead)} earlier` : ""}.`;
  return `Decided by agent order: ${head} and finished together.`;
}

// What decided the race, in step with headline; undefined when headline is.
export function decidedBy(result: ScoreResult): DecidedBy | undefined {
  const kind = decision(result)?.kind;
  if (kind === undefined) return undefined;
  if (kind === "code" || kind === "close" || kind === "same") return kind;
  return "claims";
}

function noWinnerLine(ranked: ForkScore[]): string {
  return ranked.some((s) => s.input.testsPassed > 0)
    ? "No winner: no fork both changed files and passed a test."
    : "No winner: no fork passed any tests.";
}

// The full plain-text why for the merge commit body.
export function buildWhy(result: ScoreResult): string {
  const winner = result.winner === null ? undefined : result.ranked.find((s) => s.agent === result.winner);
  const losers = result.ranked.filter((s) => s !== winner);
  const head = headline(result);
  const lines: string[] = [];
  lines.push(winner ? `Winner: ${winner.agent} (${winner.total}/100)` : noWinnerLine(result.ranked));
  lines.push("", scoresTable(result.ranked));
  if (head) lines.push("", head);
  if (winner) {
    lines.push("", `Why ${winner.agent} won:`, ...winnerReasons(winner, losers).map((r) => `- ${r}`));
  }
  if (losers.length > 0) {
    lines.push("", "Others:", ...losers.map((l) => `- ${loserLine(l, winner)}`));
  }
  return lines.join("\n");
}
