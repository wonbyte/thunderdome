// Pure fork scoring: no I/O, no imports from cloudflare:workers.
export const WEIGHTS = { tests: 50, taskFit: 25, clarity: 15, claim: 10 } as const;
// Weights for a race judged on the look of each fork's preview too (the task asks for a visible change).
export const LOOK_WEIGHTS = { tests: 45, taskFit: 20, clarity: 10, look: 15, claim: 10 } as const;
export interface Weights { tests: number; taskFit: number; clarity: number; look?: number; claim: number }
// Points off the claim part for changing a file held only as shared when another fork showed the
// task could be done without it. Small, so an avoidable clash breaks near-ties but does not outweigh a better fix.
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
  fix?: string; // fingerprint of the diff's changed lines (fixFingerprint); equal means the same fix
  look?: number; // 0..1, how the preview looks for the task; set on a fork only when the race is judged on look
  lookError?: string; // why the fork's preview could not be judged (then look is 0)
}

// A fingerprint of a unified diff's changed lines, each with its file, that ignores whitespace,
// blank lines and line order, so two forks that wrote the same fix get the same value.
// Not a security hash: it only compares forks.
export function fixFingerprint(diff: string): string {
  const lines: string[] = [];
  let file = "";
  let inHunk = false;
  for (const line of diff.split("\n")) {
    // File headers come before the first hunk of each file; inside a hunk "---"/"+++" are content.
    if (line.startsWith("diff --git ")) {
      [file, inHunk] = [line.slice("diff --git ".length), false];
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      const code = line.slice(1).replace(/\s+/g, "");
      if (code !== "") lines.push(`${file}\0${line[0]}${code}`);
    }
  }
  lines.sort();
  // cyrb53: 53 bits, so equal diffs match and different ones practically never do.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const text = lines.join("\n");
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

// Points per part, each rounded to 2 decimals.
export interface ScoreParts {
  tests: number;
  taskFit: number;
  clarity: number;
  look?: number; // only in a race judged on look
  claim: number;
}

export interface ForkScore {
  agent: string;
  parts: ScoreParts;
  total: number; // 0..100, 2 decimals
  eligible: boolean; // changed at least one file and passed at least one test
  claimKept: boolean;
  unclaimed: string[]; // changed files that were not claimed
  shared: string[]; // changed files claimed only as shared that cost SHARED_COST: another eligible fork did without them
  unavoidable: string[]; // changed files claimed only as shared that cost nothing: every other eligible fork changed them too
  input: ForkInput;
}

export interface ScoreResult {
  weights: Weights; // LOOK_WEIGHTS when any fork has a look, else WEIGHTS
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

function testPoints(passed: number, total: number, weight: number): number {
  if (!(total > 0)) return 0;
  return (weight * clamp(passed, 0, total)) / total;
}

// Changed files that were claimed only as shared.
function sharedFiles(filesChanged: string[], filesShared: string[] = []): string[] {
  const shared = new Set(filesShared);
  return [...new Set(filesChanged.filter((file) => shared.has(file)))];
}

// Full points when every changed file was claimed, SHARED_COST less when some were shared, none when some were not claimed.
function claimPoints(kept: boolean, shared: string[], weight: number): number {
  if (!kept) return 0;
  return shared.length > 0 ? weight - SHARED_COST : weight;
}

// `needed` holds the files every other eligible fork changed too; a clash on one of those was
// unavoidable and costs nothing. scoreFork alone does not know the other forks, so every clash costs.
// With look weights, a fork without a look (its preview failed) gets 0 look points.
export function scoreFork(input: ForkInput, needed: ReadonlySet<string> = new Set(), weights: Weights = WEIGHTS): ForkScore {
  const unclaimed = unclaimedFiles(input.filesChanged, input.filesClaimed);
  const kept = unclaimed.length === 0;
  const clashed = sharedFiles(input.filesChanged, input.filesShared);
  const shared = clashed.filter((file) => !needed.has(file));
  const unavoidable = clashed.filter((file) => needed.has(file));
  const parts: ScoreParts = {
    tests: round2(testPoints(input.testsPassed, input.testsTotal, weights.tests)),
    taskFit: round2(weights.taskFit * clamp(input.taskFit, 0, 1)),
    clarity: round2(weights.clarity * clamp(input.clarity, 0, 1)),
    ...(weights.look === undefined ? {} : { look: round2(weights.look * clamp(input.look ?? 0, 0, 1)) }),
    claim: claimPoints(kept, shared, weights.claim),
  };
  const total = round2(parts.tests + parts.taskFit + parts.clarity + (parts.look ?? 0) + parts.claim);
  return {
    agent: input.agent,
    parts,
    total,
    // A fork that changed nothing would merge as a no-op, so it cannot win.
    eligible: isEligible(input),
    claimKept: kept,
    unclaimed,
    shared,
    unavoidable,
    input,
  };
}

function isEligible(input: ForkInput): boolean {
  return input.testsPassed > 0 && input.filesChanged.length > 0;
}

// The files every eligible fork other than `fork` changed. With no other eligible fork, nobody showed
// a way around any file, so every file counts as needed.
export function neededFiles(fork: ForkInput, inputs: ForkInput[]): Set<string> {
  const others = inputs.filter((other) => other !== fork && isEligible(other));
  if (others.length === 0) return new Set(fork.filesChanged);
  return new Set(fork.filesChanged.filter((file) => others.every((other) => other.filesChanged.includes(file))));
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
  return scores.toSorted(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      b.total - a.total ||
      a.input.linesChanged - b.input.linesChanged ||
      byEnd(a.input, b.input),
  );
}

// The race is judged on look when the judge gave any fork a look score.
export function scoreForks(inputs: ForkInput[]): ScoreResult {
  const weights: Weights = inputs.some((input) => input.look !== undefined) ? LOOK_WEIGHTS : WEIGHTS;
  const ranked = rankForks(inputs.map((input) => scoreFork(input, neededFiles(input, inputs), weights)));
  const first = ranked[0];
  return { weights, ranked, winner: first?.eligible ? first.agent : null };
}
