// The claim board: which agent may edit which file. Pure code, so the rules are unit tested.
//
// Rules:
// - An agent claims files before it edits them. Each agent works in its own fork, so a claim is never
//   refused: a claim on a file another agent holds succeeds as a "shared" claim and returns the clash.
// - A shared claim (forced by a clash, or asked for) is recorded, and the judge counts it against the agent.
// - Claiming a file you already hold changes nothing. Releasing frees files for other agents.
// - History keeps every claim ever made, for the "claim kept" score.

export const MAX_FILES_PER_CLAIM = 50;
const MAX_PATH_LENGTH = 300;

export interface Claim {
  agent: string;
  file: string;
  shared: boolean;
  at: string;
}

export interface ClaimBoard {
  active: Claim[];
  history: Claim[];
}

export interface Conflict {
  file: string;
  heldBy: string[];
}

export type ClaimResult =
  | { ok: true; claimed: string[]; already: string[]; shared: string[]; clashes: Conflict[] }
  | { ok: false; status: number; error: string };

export function emptyBoard(): ClaimBoard {
  return { active: [], history: [] };
}

// Repo-relative path with no "./", no "..", and no leading "/". Undefined when it is not one.
export function normalizeFile(path: string): string | undefined {
  let file = path.trim().replace(/\/{2,}/g, "/");
  while (file.startsWith("./")) file = file.slice(2);
  if (file === "" || file.startsWith("/") || file.endsWith("/") || file.length > MAX_PATH_LENGTH) return undefined;
  if (file.includes("\0") || file.split("/").some((part) => part === ".." || part === ".")) return undefined;
  return file;
}

// Returns the normalized, distinct files, or an error message.
export function parseFiles(value: unknown, { allowEmpty = false } = {}): string[] | string {
  if (!Array.isArray(value)) return "files must be an array of repo paths";
  if (value.length === 0 && !allowEmpty) return "files must not be empty";
  if (value.length > MAX_FILES_PER_CLAIM) return `at most ${MAX_FILES_PER_CLAIM} files per request`;
  const files: string[] = [];
  for (const item of value) {
    const file = typeof item === "string" ? normalizeFile(item) : undefined;
    if (file === undefined) return `not a repo path: ${JSON.stringify(item)}`;
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

export function holdersOf(board: ClaimBoard, file: string): Claim[] {
  return board.active.filter((claim) => claim.file === file);
}

// Claims every file. A file other agents hold is claimed as shared and reported in clashes;
// with shared set, every new claim is shared.
export function claimFiles(board: ClaimBoard, agent: string, files: string[], shared: boolean, at: string): ClaimResult {
  const clashes: Conflict[] = [];
  const already: string[] = [];
  const claimed: string[] = [];
  const sharedFiles: string[] = [];
  for (const file of files) {
    const holders = holdersOf(board, file);
    if (holders.some((claim) => claim.agent === agent)) {
      already.push(file);
      continue;
    }
    const others = holders.map((claim) => claim.agent);
    if (others.length > 0) clashes.push({ file, heldBy: others });
    const claim = { agent, file, shared: shared || others.length > 0, at };
    board.active.push(claim);
    board.history.push(claim);
    claimed.push(file);
    if (claim.shared) sharedFiles.push(file);
  }
  return { ok: true, claimed, already, shared: sharedFiles, clashes };
}

// Releases the given files, or all of the agent's files. Returns the released files.
export function releaseFiles(board: ClaimBoard, agent: string, files?: string[]): string[] {
  const released: string[] = [];
  board.active = board.active.filter((claim) => {
    const release = claim.agent === agent && (files === undefined || files.includes(claim.file));
    if (release) released.push(claim.file);
    return !release;
  });
  return released;
}

// Every file the agent ever claimed, and which of those claims were shared.
export function claimsOf(board: ClaimBoard, agent: string): { files: string[]; shared: string[] } {
  const mine = board.history.filter((claim) => claim.agent === agent);
  return {
    files: [...new Set(mine.map((claim) => claim.file))],
    shared: [...new Set(mine.filter((claim) => claim.shared).map((claim) => claim.file))],
  };
}

// One line for the step log.
export function describeClaim(result: ClaimResult): string {
  if (!result.ok) return `claim refused: ${result.error}`;
  const own = result.claimed.filter((file) => !result.shared.includes(file));
  const parts = [
    own.length > 0 ? `claimed ${own.join(", ")}` : "",
    result.shared.length > 0 ? `shared claim ${result.shared.join(", ")}` : "",
    result.clashes.length > 0
      ? `clash: ${result.clashes.map((c) => `${c.file} (also held by ${c.heldBy.join(", ")})`).join("; ")}`
      : "",
    result.already.length > 0 ? `already held ${result.already.join(", ")}` : "",
  ];
  return parts.filter(Boolean).join("; ") || "claimed nothing";
}
