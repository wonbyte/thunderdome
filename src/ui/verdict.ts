// The result's one-line verdict: who won, by how much, what decided it and what the fusion round
// did. Pure, like board.ts. It is built from numbers and fixed phrases only; no Clef text and no
// agent-written text goes in it.
import { displayName, type WireScore } from "./board";
import type { FuseRow, FusionView } from "./fusion";
import type { TieView } from "./judgeview";

/** What the verdict line is built from. */
export interface VerdictInput {
  winner: string | null | undefined;
  /** The scored forks, best first. */
  scored: Pick<WireScore, "agent" | "total" | "parts">[];
  tie?: TieView;
  fusion?: FusionView;
}

type ClefPart = "taskFit" | "clarity" | "look" | "claim";
const PART_WORDS: Record<ClefPart, string> = { taskFit: "task fit", clarity: "clarity", look: "look", claim: "claim points" };

/** How each tie-break reads (the judge's TieBreak in src/judge/score.ts). */
const TIE_WORDS: Record<string, string> = {
  compare: "Clef's side-by-side vote broke the tie",
  diff: "the smaller diff broke the tie",
  finish: "the earlier finish broke the tie",
  order: "agent order broke the tie",
};

/** Why a fusion try was left out, in two or three words. Notes are the judge's own text, matched not shown. */
function leftOutWhy(row: FuseRow): string | undefined {
  const note = row.note ?? "";
  if (row.outcome === "failed") return "could not apply";
  if (note.includes("scored")) return "scored lower";
  if (/not every test|fewer tests/.test(note)) return "a test failed";
  if (row.clef !== undefined) return "Clef said no";
  if (note.includes("out of time")) return "out of time";
  return undefined;
}

const piece = (row: FuseRow): string => (row.kind === "hunk" ? "hunk" : "file");

function fusionClause(view: FusionView | undefined): string | undefined {
  if (view === undefined || view.rows.length === 0) return undefined;
  const kept = view.rows.filter((r) => r.outcome === "added");
  if (kept.length > 0) {
    const names = [...new Set(kept.map((r) => displayName(r.agent)))];
    const what = kept.length === 1 && kept[0] !== undefined ? `${names[0]}'s ${piece(kept[0])} was` : `${kept.length} pieces from ${names.join(" and ")} were`;
    return `${what} fused in${view.shipped ? " and shipped" : ""}.`;
  }
  const out = view.rows;
  const reasons = [...new Set(out.map(leftOutWhy))];
  const why = reasons.length === 1 && reasons[0] !== undefined ? ` (${reasons[0]})` : "";
  const first = out[0];
  if (out.length === 1 && first !== undefined) return `${displayName(first.agent)}'s ${piece(first)} was left out${why}.`;
  return `All ${out.length} pieces from the others were left out${why}.`;
}

/**
 * The verdict in one line, such as "Ponder won by 1.9: every test passed and the best look. All 3
 * pieces from the others were left out." Undefined before the verdict.
 */
export function verdictLine(input: VerdictInput): string | undefined {
  const { winner, scored } = input;
  if (winner === undefined) return undefined;
  if (winner === null) return "No winner: no fork passed.";
  const name = displayName(winner);
  const w = scored.find((s) => s.agent === winner);
  const r = scored.find((s) => s.agent !== winner);
  const fusion = fusionClause(input.fusion);
  const tail = fusion === undefined ? "" : ` ${fusion}`;
  if (w === undefined) return `${name} won.${tail}`;
  if (r === undefined) return `${name} won with ${w.total.toFixed(1)}, the only fork scored.${tail}`;
  const margin = w.total - r.total;
  const head = margin < 0.05 ? `${name} won a photo finish` : `${name} won by ${margin.toFixed(1)}`;
  const reasons: string[] = [];
  const testsMax = w.parts.look === undefined ? 50 : 45;
  if (w.parts.tests >= testsMax - 1e-9) reasons.push("every test passed");
  else if (w.parts.tests > r.parts.tests) reasons.push("more tests passed");
  const tieWords = input.tie === undefined ? undefined : TIE_WORDS[input.tie.by];
  if (tieWords !== undefined) reasons.push(tieWords);
  else {
    // The part the winner topped every fork on, as the judge's why leads with; failing that, the
    // part where it gained the most over the runner-up. Biggest gain first either way.
    const gains = (["taskFit", "clarity", "look", "claim"] as const)
      .map((part) => ({ part, gain: (w.parts[part] ?? 0) - (r.parts[part] ?? 0), top: scored.every((s) => (s.parts[part] ?? 0) <= (w.parts[part] ?? 0)) }))
      .filter((g) => g.gain > 0.05)
      .toSorted((a, b) => b.gain - a.gain);
    const best = gains.find((g) => g.top) ?? gains[0];
    if (best !== undefined) reasons.push(best.top ? `the best ${PART_WORDS[best.part]}` : `more ${PART_WORDS[best.part]} than ${displayName(r.agent)}`);
  }
  return `${head}${reasons.length === 0 ? "." : `: ${reasons.join(" and ")}.`}${tail}`;
}
