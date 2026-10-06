import { describe, expect, it, vi } from "vitest";

import { deleteRepo, forkFor, forkName, isArtifactsError, isRepoName, latestCommit, notReady, openOrCreate, revokeWriteTokens } from "../src/artifacts/repo";
import { artifactsError, fakeArtifacts, fakeRepo } from "./fakes";

describe("isArtifactsError", () => {
  it("matches by name and code", () => {
    expect(isArtifactsError(artifactsError("NOT_FOUND"))).toBe(true);
    expect(isArtifactsError(artifactsError("NOT_FOUND"), "NOT_FOUND")).toBe(true);
    expect(isArtifactsError(artifactsError("NOT_FOUND"), "ALREADY_EXISTS")).toBe(false);
    expect(isArtifactsError(new Error("x"))).toBe(false);
  });
});

describe("notReady", () => {
  it("matches only in-progress codes", () => {
    expect(notReady(artifactsError("FORK_IN_PROGRESS"))).toBe(true);
    expect(notReady(artifactsError("CREATE_IN_PROGRESS"))).toBe(true);
    expect(notReady(artifactsError("NOT_FOUND"))).toBe(false);
    expect(notReady(new Error("x"))).toBe(false);
  });
});

describe("isRepoName", () => {
  it("accepts Artifacts names and rejects others", () => {
    expect(isRepoName("thunderdome-sample")).toBe(true);
    expect(isRepoName("a.b_c-1")).toBe(true);
    expect(isRepoName("")).toBe(false);
    expect(isRepoName("a/b")).toBe(false);
    expect(isRepoName("x".repeat(101))).toBe(false);
  });
});

describe("forkName", () => {
  it("joins task and agent", () => {
    expect(forkName("t1", "ponder")).toBe("t1-ponder");
  });
  it("rejects names Artifacts would refuse", () => {
    expect(() => forkName("t 1", "a/b")).toThrow(/Invalid fork name/);
  });
});

describe("openOrCreate", () => {
  it("creates a new repo", async () => {
    const artifacts = fakeArtifacts(fakeRepo());
    const result = await openOrCreate(artifacts, "thunderdome-sample", "d");
    expect(result).toMatchObject({ name: "thunderdome-sample", token: "token-thunderdome-sample", created: true });
    expect(artifacts.create).toHaveBeenCalledWith("thunderdome-sample", { description: "d", setDefaultBranch: "main" });
  });

  it("opens an existing repo with a fresh write token", async () => {
    const repo = fakeRepo();
    const artifacts = fakeArtifacts(repo, {
      create: vi.fn(async () => {
        throw artifactsError("ALREADY_EXISTS");
      }),
    });
    const result = await openOrCreate(artifacts, "thunderdome-sample", "d");
    expect(result).toMatchObject({ token: "fresh-token", created: false, remote: "https://git.test/thunderdome/thunderdome-sample.git" });
    expect(repo.createToken).toHaveBeenCalledWith("write");
  });

  it("passes other errors through", async () => {
    const artifacts = fakeArtifacts(fakeRepo(), {
      create: vi.fn(async () => {
        throw artifactsError("INVALID_REPO_NAME");
      }),
    });
    await expect(openOrCreate(artifacts, "bad name", "d")).rejects.toMatchObject({ code: "INVALID_REPO_NAME" });
  });
});

describe("forkFor", () => {
  it("forks the default branch and returns the fork token", async () => {
    const repo = fakeRepo();
    const result = await forkFor(fakeArtifacts(repo), "thunderdome-sample", "t1-zippy", "d");
    expect(repo.fork).toHaveBeenCalledWith("t1-zippy", { description: "d", defaultBranchOnly: true });
    expect(result).toEqual({ name: "t1-zippy", remote: "https://git.test/thunderdome/t1-zippy.git", token: "token-t1-zippy", defaultBranch: "main" });
  });
});

describe("revokeWriteTokens", () => {
  it("revokes only active write tokens", async () => {
    const repo = fakeRepo({
      listTokens: vi.fn(async () => ({
        total: 3,
        tokens: [
          { id: "w-live", scope: "write" as const, state: "active" as const, createdAt: "", expiresAt: "" },
          { id: "w-dead", scope: "write" as const, state: "revoked" as const, createdAt: "", expiresAt: "" },
          { id: "r-live", scope: "read" as const, state: "active" as const, createdAt: "", expiresAt: "" },
        ],
      })),
    });
    expect(await revokeWriteTokens(fakeArtifacts(repo), "t1-zippy")).toBe(1);
    expect(repo.revokeToken).toHaveBeenCalledTimes(1);
    expect(repo.revokeToken).toHaveBeenCalledWith("w-live");
  });
});

describe("latestCommit", () => {
  it("asks for one commit and returns it", async () => {
    const commit = { hash: "a".repeat(40) } as ArtifactsCommitMetadata;
    const repo = fakeRepo({ log: vi.fn(async () => [commit]) });
    expect(await latestCommit(fakeArtifacts(repo), "x", "main")).toBe(commit);
    expect(repo.log).toHaveBeenCalledWith({ ref: "main", limit: 1 });
  });
});

describe("deleteRepo", () => {
  it("passes the binding result through", async () => {
    const artifacts = fakeArtifacts(fakeRepo(), { delete: vi.fn(async () => false) });
    expect(await deleteRepo(artifacts, "gone")).toBe(false);
    expect(artifacts.delete).toHaveBeenCalledWith("gone");
  });
});
