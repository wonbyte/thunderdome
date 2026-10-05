// Pure fork scoring: no I/O, no imports from cloudflare:workers.
export const WEIGHTS = { tests: 50, taskFit: 25, clarity: 15, claim: 10 } as const;
// Points off the claim part for changing a file held only as shared. Small, so who claimed first
// breaks near-ties but does not outweigh a better fix.
export const SHARED_COST = 2;

export interface ForkInput {
  agent: string;
  testsPassed: number;
  testsTotal: number;
  taskFit: number; // 0..1
  clarity: number; // 0..1
  linesChanged: number; // added + removed
  filesChanged: string[];
  filesClaimed: string[];
  filesShared?: string[]; // claimed files that were ever held only as shared (a clash)
  endedAt?: string; // ISO time the agent ended; the earlier one wins a tie on points and diff size
}

// Points per part, each rounded to 2 decimals.
export interface ScoreParts {
  tests: number;
  taskFit: number;
  clarity: number;
  claim: number;
}

export interface ForkScore {
  agent: string;
  parts: ScoreParts;
  total: number; // 0..100, 2 decimals
  eligible: boolean; // changed at least one file and passed at least one test
  claimKept: boolean;
  unclaimed: string[]; // changed files that were not claimed
  shared: string[]; // changed files that were claimed only as shared
  input: ForkInput;
}

export interface ScoreResult {
  ranked: ForkScore[]; // eligible first, then total desc, then linesChanged asc, then endedAt asc, then input order
  winner: string | null; // ranked[0].agent when it is eligible, else null
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

// Clamps x to lo..hi; NaN becomes lo.
function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

// Changed files that are not in the claimed set (exact match, no duplicates).
function unclaimedFiles(filesChanged: string[], filesClaimed: string[]): string[] {
  const claimed = new Set(filesClaimed);
  return [...new Set(filesChanged.filter((file) => !claimed.has(file)))];
}

// True when every changed file was claimed. No changes counts as kept.
export function claimKept(filesChanged: string[], filesClaimed: string[]): boolean {
  return unclaimedFiles(filesChanged, filesClaimed).length === 0;
}

function testPoints(passed: number, total: number): number {
  if (!(total > 0)) return 0;
  return (WEIGHTS.tests * clamp(passed, 0, total)) / total;
}

// Changed files that were claimed only as shared.
function sharedFiles(filesChanged: string[], filesShared: string[] = []): string[] {
  const shared = new Set(filesShared);
  return [...new Set(filesChanged.filter((file) => shared.has(file)))];
}

// Full points when every changed file was claimed, SHARED_COST less when some were shared, none when some were not claimed.
function claimPoints(kept: boolean, shared: string[]): number {
  if (!kept) return 0;
  return shared.length > 0 ? WEIGHTS.claim - SHARED_COST : WEIGHTS.claim;
}

export function scoreFork(input: ForkInput): ForkScore {
  const unclaimed = unclaimedFiles(input.filesChanged, input.filesClaimed);
  const kept = unclaimed.length === 0;
  const shared = sharedFiles(input.filesChanged, input.filesShared);
  const parts: ScoreParts = {
    tests: round2(testPoints(input.testsPassed, input.testsTotal)),
    taskFit: round2(WEIGHTS.taskFit * clamp(input.taskFit, 0, 1)),
    clarity: round2(WEIGHTS.clarity * clamp(input.clarity, 0, 1)),
    claim: claimPoints(kept, shared),
  };
  const total = round2(parts.tests + parts.taskFit + parts.clarity + parts.claim);
  return {
    agent: input.agent,
    parts,
    total,
    // A fork that changed nothing would merge as a no-op, so it cannot win.
    eligible: input.testsPassed > 0 && input.filesChanged.length > 0,
    claimKept: kept,
    unclaimed,
    shared,
    input,
  };
}

// Milliseconds of an ISO time; a missing or bad time sorts last.
export function endedMs(input: ForkInput): number {
  const ms = input.endedAt === undefined ? NaN : Date.parse(input.endedAt);
  return Number.isNaN(ms) ? Infinity : ms;
}

// Earlier end first; equal (or both missing) ends compare as 0.
function byEnd(a: ForkInput, b: ForkInput): number {
  const x = endedMs(a);
  const y = endedMs(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

// Eligible first, then total desc, then linesChanged asc, then endedAt asc; the stable sort keeps input order.
export function rankForks(scores: ForkScore[]): ForkScore[] {
  return [...scores].sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      b.total - a.total ||
      a.input.linesChanged - b.input.linesChanged ||
      byEnd(a.input, b.input),
  );
}

export function scoreForks(inputs: ForkInput[]): ScoreResult {
  const ranked = rankForks(inputs.map(scoreFork));
  const first = ranked[0];
  return { ranked, winner: first?.eligible ? first.agent : null };
}
