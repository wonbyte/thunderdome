// "Who wins?": the viewer picks a robot while the race runs, the pick locks when judging starts,
// and the reveal says how it went. Pure, like board.ts; the page keeps the pick in localStorage.
import { displayName, type Board } from "./board";

/** What the guess box shows. */
export type GuessView =
  | { kind: "hidden" }
  | { kind: "open"; pick?: string }
  | { kind: "locked"; pick: string }
  | { kind: "reveal"; pick: string; text: string; hit: boolean };

/**
 * The guess box for a board. Open while the robots race (or wait to start), locked while the
 * judge works, and revealed once the result is shown (`shown`: the page's reveal has finished).
 * With no pick there is nothing to lock or reveal.
 */
export function guessView(b: Board, pick: string | undefined, shown: boolean): GuessView {
  const status = b.task?.status;
  if (!b.ended && (status === "ready" || status === "running")) return pick === undefined ? { kind: "open" } : { kind: "open", pick };
  if (pick === undefined || !b.fighters.some((f) => f.agent === pick)) return { kind: "hidden" };
  if (!b.ended) return status === "finished" ? { kind: "locked", pick } : { kind: "hidden" };
  if (!shown) return { kind: "locked", pick };
  return { kind: "reveal", pick, ...revealText(b, pick) };
}

function revealText(b: Board, pick: string): { text: string; hit: boolean } {
  if (!b.winner) return { text: "No winner this time, so no one called it.", hit: false };
  if (b.winner === pick) return { text: `You called it 🎯 ${displayName(pick)} won.`, hit: true };
  const winner = b.fighters.find((f) => f.agent === b.winner)?.score;
  const mine = b.fighters.find((f) => f.agent === pick)?.score;
  const name = displayName(b.winner);
  if (winner === undefined) return { text: `${name} won, not your pick ${displayName(pick)}.`, hit: false };
  if (mine === undefined) return { text: `${name} won; your pick ${displayName(pick)} was not scored.`, hit: false };
  const gap = winner.total - mine.total;
  return { text: `${name} beat your pick by ${gap.toFixed(1)} point${gap.toFixed(1) === "1.0" ? "" : "s"}.`, hit: false };
}
