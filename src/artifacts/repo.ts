// Thin wrapper on the Artifacts binding. Every Thunderdome repo call goes through here.

/** The demo repo a task starts from when it names no template. */
export const SAMPLE_REPO = "thunderdome-sample";

/** Repo names allow letters, digits, dots, hyphens and underscores. */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** A repo handle throws these while a create, import or fork still runs. */
const NOT_READY = ["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"] as const;

/** True when `name` is a valid Artifacts repo name. */
export function isRepoName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * True when `cause` is an error from the Artifacts binding, and, when `code` is given, has that
 * code.
 */
export function isArtifactsError(cause: unknown, code?: ArtifactsErrorCode): cause is ArtifactsError {
  return (
    cause instanceof Error &&
    cause.name === "ArtifactsError" &&
    (code === undefined || (cause as ArtifactsError).code === code)
  );
}

/** True when the repo exists but a create, import or fork on it has not finished yet. */
export function notReady(cause: unknown): boolean {
  return NOT_READY.some((code) => isArtifactsError(cause, code));
}

/** The repo name of an agent's fork: `<taskId>-<agent>`. Throws when that is not a valid repo name. */
export function forkName(taskId: string, agent: string): string {
  const name = `${taskId}-${agent}`;
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid fork name: ${name}`);
  return name;
}

/** A repo's name, git remote and default branch, with a token for it. */
export interface RepoAccess {
  name: string;
  remote: string;
  token: string;
  defaultBranch: string;
}

/** Returns write access to a repo, and creates the repo when it does not exist. */
export async function openOrCreate(artifacts: Artifacts, name: string, description: string): Promise<RepoAccess & { created: boolean }> {
  try {
    const created = await artifacts.create(name, { description, setDefaultBranch: "main" });
    return { ...access(created), created: true };
  } catch (cause) {
    if (!isArtifactsError(cause, "ALREADY_EXISTS")) throw cause;
  }
  using repo = await artifacts.get(name);
  const [info, token] = await Promise.all([repo.info(), repo.createToken("write")]);
  return {
    name: info.name,
    remote: info.remote,
    token: token.plaintext,
    defaultBranch: info.defaultBranch,
    created: false,
  };
}

/** Forks a source repo for one agent. The result carries a write token for the fork only. */
export async function forkFor(artifacts: Artifacts, source: string, name: string, description: string): Promise<RepoAccess> {
  using repo = await artifacts.get(source);
  return access(await repo.fork(name, { description, defaultBranchOnly: true }));
}

/** Revokes every active write token, so the repo stays as a read-only record. */
export async function revokeWriteTokens(artifacts: Artifacts, name: string): Promise<number> {
  using repo = await artifacts.get(name);
  const { tokens } = await repo.listTokens();
  const live = tokens.filter((token) => token.scope === "write" && token.state === "active");
  const results = await Promise.all(live.map((token) => repo.revokeToken(token.id)));
  return results.filter(Boolean).length;
}

/** Deletes a repo and its tokens. Returns false when the repo did not exist. */
export async function deleteRepo(artifacts: Artifacts, name: string): Promise<boolean> {
  return artifacts.delete(name);
}

/** The newest commit on `ref` (the default branch when omitted), or undefined for an empty repo. */
export async function latestCommit(artifacts: Artifacts, name: string, ref?: string): Promise<ArtifactsCommitMetadata | undefined> {
  using repo = await artifacts.get(name);
  const [commit] = await repo.log({ ref, limit: 1 });
  return commit;
}

function access(result: ArtifactsCreateRepoResult): RepoAccess {
  return {
    name: result.name,
    remote: result.remote,
    token: result.token,
    defaultBranch: result.defaultBranch,
  };
}
