// The history of main after the race, as `git log --graph` prints it: the merge, the winner's
// fork (the fusion commit on top of its pushes), and the base every fork started from. Built from
// the task alone. Pure, like board.ts.
import { colorFor, displayName, FALLBACK_COLOR, type WireTask } from "./board";
import { fusionView } from "./fusion";

/** One line of the log: the graph glyphs, then the commit when the line is one. */
export interface LogLine {
  graph: string; // "*   ", "|\\  ", "| * ", "|/  ", "* "
  sha?: string; // short; absent on graph-only lines and on commits whose hash the page does not know
  hash?: string; // full, when the commit can be opened (the fusion head and the merge)
  message?: string;
  who?: string; // the author column
  color?: string; // the author's color
}

/**
 * A commit's subject, as `git log --oneline` shows it. Pushes recorded before Oct 7 kept the whole
 * message on one line, so a flattened trailer (Co-Authored-By, Signed-off-by) is cut off too.
 */
export function subjectOf(message: string): string {
  const cut = message.search(/\s(?:Co-Authored-By|Signed-off-by):/i);
  return (cut === -1 ? message : message.slice(0, cut)).trim();
}

/** Winner pushes the log shows before folding the rest into one line. */
export const LOG_PUSHES_MAX = 5;
const THUNDERDOME = "Thunderdome";

/** The log of main after a merged race, newest first; undefined until the winner merged. */
export function gitLog(task: WireTask): LogLine[] | undefined {
  const v = task.verdict;
  if (v === undefined || v.winner === null || v.ship?.status !== "merged") return undefined;
  const winner = v.winner;
  const name = displayName(winner);
  const lines: LogLine[] = [
    { graph: "*   ", ...commit(v.ship.commit), message: `Thunderdome: ship ${name}'s fork`, who: THUNDERDOME, color: FALLBACK_COLOR },
    { graph: "|\\  " },
  ];
  // One commit per kept try; only the newest (the fork's head) has a hash the page knows.
  const fusion = fusionView(v);
  const kept = (fusion?.rows ?? []).filter((r) => r.outcome === "added").toReversed();
  kept.forEach((row, i) => {
    const head = i === 0 && fusion?.hash !== undefined ? commit(fusion.hash) : {};
    lines.push({ graph: "| * ", ...head, message: `fusion: add ${displayName(row.agent)}'s ${row.what}`, who: displayName(row.agent), color: colorFor(row.agent) });
  });
  // The fusion push lands in the winner's push log too; it is already the fusion line.
  const pushes = (task.agents.find((a) => a.name === winner)?.push?.log ?? []).filter((p) => p.commit !== v.fusion?.commit).toReversed();
  for (const push of pushes.slice(0, LOG_PUSHES_MAX)) {
    const more = push.commits > 1 ? ` (+${push.commits - 1} more)` : "";
    lines.push({ graph: "| * ", sha: push.commit.slice(0, 7), message: `${(push.message === undefined ? "" : subjectOf(push.message)) || "push"}${more}`, who: name, color: colorFor(winner) });
  }
  if (pushes.length > LOG_PUSHES_MAX) lines.push({ graph: "| ⋮ ", message: `${pushes.length - LOG_PUSHES_MAX} earlier push${pushes.length - LOG_PUSHES_MAX === 1 ? "" : "es"}` });
  lines.push({ graph: "|/  " });
  lines.push({ graph: "* ", ...(task.baseCommit === undefined ? {} : { sha: task.baseCommit.slice(0, 7) }), message: "base: where every fork started" });
  return lines;
}

function commit(hash: string | undefined): Pick<LogLine, "sha" | "hash"> {
  return hash === undefined ? {} : { sha: hash.slice(0, 7), hash };
}
