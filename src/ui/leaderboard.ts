// The leaderboard: how each agent style does across every race in the list. Pure, like board.ts.
import { colorFor, displayName } from "./board";

/** What decided a race (src/judge/why.ts DecidedBy). */
export type DecidedBy = "code" | "claims" | "close" | "same";

/** The fields of a race summary the leaderboard reads. */
export interface RaceRow {
  id: string;
  agents: string[];
  winner?: string | null; // only once judged
  clash?: boolean;
  scores?: { agent: string; total: number }[]; // races judged before scores were kept have none
  decidedBy?: DecidedBy;
  fused?: string[]; // agents whose files the fusion round shipped in this race
  losing?: Record<string, number>; // shipped lines by each robot that lost (races with blame only)
  team?: number; // fused score minus the winner's alone, when a scored fusion shipped
  startedAt?: string;
  finishedAt?: string;
}

/** One robot's row on the leaderboard. */
export interface Standing {
  agent: string;
  name: string;
  color: string;
  races: number; // judged races it ran in
  wins: number;
  winRate: number; // 0..1
  avgScore?: number; // over the races with scores, 1 decimal
  assists: number; // races where its losing fork's files were fused into the winner's and shipped
  losingLines: number; // lines it wrote that shipped in races it lost
}

/** Totals across every judged race: clash rate, what decided the races, and the average race time. */
export interface RaceStats {
  judged: number;
  clashRate: number; // 0..1, of judged races
  decided: Record<DecidedBy, number>;
  fusedRate: number; // 0..1, of judged races: the fusion round shipped a loser's files
  losingLines: number; // lines shipped by robots that lost, over every judged race with blame
  teamBeat: number; // judged races where the fused change scored above the winner alone
  scoredFusions: number; // judged races where a scored fusion shipped (the base for teamBeat)
  avgSeconds?: number; // start to finish, judged races with both times
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function judged(races: readonly RaceRow[]): RaceRow[] {
  return races.filter((r) => r.winner !== undefined);
}

/** Most wins first, then the better win rate, then the higher average, then the agent id. */
export function standings(races: readonly RaceRow[]): Standing[] {
  const rows = new Map<string, { races: number; wins: number; sum: number; scored: number; assists: number; losingLines: number }>();
  for (const race of judged(races)) {
    for (const agent of race.agents) {
      const row = rows.get(agent) ?? { races: 0, wins: 0, sum: 0, scored: 0, assists: 0, losingLines: 0 };
      row.races += 1;
      if (race.winner === agent) row.wins += 1;
      if (race.fused?.includes(agent) === true) row.assists += 1;
      const lines = race.winner === agent ? 0 : (race.losing?.[agent] ?? 0);
      if (Number.isFinite(lines) && lines > 0) row.losingLines += lines;
      const score = race.scores?.find((s) => s.agent === agent);
      if (score !== undefined && Number.isFinite(score.total)) {
        row.sum += score.total;
        row.scored += 1;
      }
      rows.set(agent, row);
    }
  }
  return [...rows.entries()]
    .map(([agent, row]): Standing => ({
      agent,
      name: displayName(agent),
      color: colorFor(agent),
      races: row.races,
      wins: row.wins,
      winRate: row.races === 0 ? 0 : row.wins / row.races,
      ...(row.scored === 0 ? {} : { avgScore: round1(row.sum / row.scored) }),
      assists: row.assists,
      losingLines: row.losingLines,
    }))
    .toSorted((a, b) => b.wins - a.wins || b.winRate - a.winRate || (b.avgScore ?? -1) - (a.avgScore ?? -1) || a.agent.localeCompare(b.agent));
}

/** The gallery card's pill for a shipped, scored fusion: "team +2.7", or undefined. */
export function teamPill(team: number | undefined): string | undefined {
  if (typeof team !== "number" || !Number.isFinite(team)) return undefined;
  return `team ${team > 0 ? "+" : team < 0 ? "−" : "±"}${Math.abs(team).toFixed(1)}`;
}

/** The totals for the stats strip above the leaderboard. */
export function raceStats(races: readonly RaceRow[]): RaceStats {
  const done = judged(races);
  const decided: Record<DecidedBy, number> = { code: 0, claims: 0, close: 0, same: 0 };
  let secs = 0;
  let timed = 0;
  for (const race of done) {
    if (race.decidedBy !== undefined) decided[race.decidedBy] += 1;
    const start = Date.parse(race.startedAt ?? "");
    const end = Date.parse(race.finishedAt ?? "");
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      secs += (end - start) / 1000;
      timed += 1;
    }
  }
  return {
    judged: done.length,
    clashRate: done.length === 0 ? 0 : done.filter((r) => r.clash === true).length / done.length,
    decided,
    fusedRate: done.length === 0 ? 0 : done.filter((r) => (r.fused?.length ?? 0) > 0).length / done.length,
    losingLines: done.reduce((sum, r) => sum + Object.entries(r.losing ?? {}).reduce((n, [agent, lines]) => n + (agent !== r.winner && Number.isFinite(lines) && lines > 0 ? lines : 0), 0), 0),
    teamBeat: done.filter((r) => typeof r.team === "number" && r.team > 0).length,
    scoredFusions: done.filter((r) => typeof r.team === "number" && Number.isFinite(r.team)).length,
    ...(timed === 0 ? {} : { avgSeconds: Math.round(secs / timed) }),
  };
}
