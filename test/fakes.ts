// Mock Artifacts binding for unit tests.
import { vi } from "vitest";

export function artifactsError(code: ArtifactsErrorCode): ArtifactsError {
  return Object.assign(new Error(code), { name: "ArtifactsError" as const, code, numericCode: 0 });
}

export function created(name: string): ArtifactsCreateRepoResult {
  return { id: `id-${name}`, name, description: null, defaultBranch: "main", remote: `https://git.test/thunderdome/${name}.git`, token: `token-${name}` };
}

export function fakeRepo(overrides: Partial<ArtifactsRepo> = {}): ArtifactsRepo {
  return {
    [Symbol.dispose]: vi.fn(),
    createToken: vi.fn(async () => ({ id: "t1", plaintext: "fresh-token", scope: "write" as const, expiresAt: "" })),
    listTokens: vi.fn(async () => ({ tokens: [], total: 0 })),
    revokeToken: vi.fn(async () => true),
    info: vi.fn(async () => ({ ...created("thunderdome-sample"), createdAt: "", updatedAt: "", lastPushAt: null, source: null, readOnly: false })),
    readBlob: vi.fn(),
    readTree: vi.fn(),
    readCommit: vi.fn(),
    readFile: vi.fn(),
    log: vi.fn(async () => []),
    fork: vi.fn(async (name: string) => created(name)),
    ...overrides,
  };
}

export function fakeArtifacts(repo: ArtifactsRepo, overrides: Partial<Artifacts> = {}): Artifacts {
  return {
    create: vi.fn(async (name: string) => created(name)),
    get: vi.fn(async () => repo),
    import: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(async () => true),
    ...overrides,
  };
}
