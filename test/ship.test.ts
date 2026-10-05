import { describe, expect, it } from "vitest";

import { mergeMessage, shipTask, SHIP_OUTPUT_LIMIT, type GitResult, type ShipDeps, type ShipInput } from "../src/ship/ship";

const input: ShipInput = {
  taskId: "t1",
  prompt: "Add a feature",
  source: { name: "source", remote: "https://git.test/git/thunderdome/source.git", defaultBranch: "main" },
  forks: [
    { agent: "alpha", name: "fork-alpha", remote: "https://git.test/git/thunderdome/fork-alpha.git", defaultBranch: "main" },
    { agent: "beta", name: "fork-beta", remote: "https://git.test/git/thunderdome/fork-beta.git", defaultBranch: "trunk" },
  ],
  winner: "beta",
  why: "  Beta passed every test.\n\nAlpha did not.\n",
};

type Answers = Record<string, GitResult | Error>;

const ok = (stdout = ""): GitResult => ({ exitCode: 0, stdout, stderr: "" });

// Fake deps: records git args and revoked repos, answers per subcommand.
function fakeDeps(answers: Answers = {}, revokeFails: string[] = []) {
  const calls: string[][] = [];
  const revoked: string[] = [];
  const deps: ShipDeps = {
    async git(args) {
      calls.push(args);
      const key = args[0] === "merge" && args[1] === "--abort" ? "abort" : (args[0] ?? "");
      const answer = answers[key] ?? (key === "rev-parse" ? ok("abc123\n") : ok());
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async revokeWriteTokens(repo) {
      revoked.push(repo);
      if (revokeFails.includes(repo)) throw new Error(`cannot revoke ${repo}`);
      return 2;
    },
  };
  return { deps, calls, revoked };
}

describe("mergeMessage", () => {
  it("R2: the merge commit message is a title line, a blank line, then the why", () => {
    expect(mergeMessage("t1", "Add a feature", "beta", input.why)).toBe(
      "Thunderdome: ship beta's fork for task t1\n\n  Beta passed every test.\n\nAlpha did not.\n",
    );
  });
});

describe("shipTask", () => {
  it("merges the winner with --no-ff and pushes the default branch", async () => {
    const { deps, calls } = fakeDeps();
    const result = await shipTask(deps, input);
    expect(calls).toEqual([
      ["checkout", "main"],
      ["fetch", "https://git.test/git/thunderdome/fork-beta.git", "trunk"],
      ["merge", "--no-ff", "--cleanup=verbatim", "-m", mergeMessage("t1", "Add a feature", "beta", input.why), "FETCH_HEAD"],
      ["rev-parse", "HEAD"],
      ["push", "origin", "HEAD:refs/heads/main"],
    ]);
    expect(result).toEqual({
      status: "merged",
      winner: "beta",
      commit: "abc123",
      locks: [
        { agent: "alpha", fork: "fork-alpha", revoked: 2 },
        { agent: "beta", fork: "fork-beta", revoked: 2 },
      ],
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("R3: a merge conflict aborts the merge, pushes nothing, and reports \"conflict\"", async () => {
    const { deps, calls } = fakeDeps({ merge: { exitCode: 1, stdout: "CONFLICT (content): a.ts", stderr: "Automatic merge failed" } });
    const result = await shipTask(deps, input);
    expect(calls.at(-1)).toEqual(["merge", "--abort"]);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(result.status).toBe("conflict");
    expect(result.output).toContain("CONFLICT (content): a.ts");
    expect(result.output).toContain("Automatic merge failed");
    expect(result.commit).toBeUndefined();
  });

  it("a fatal merge failure (exit 128) is an error, not a conflict, and pushes nothing", async () => {
    const { deps, calls } = fakeDeps({ merge: { exitCode: 128, stdout: "", stderr: "fatal: refusing to merge unrelated histories" } });
    const result = await shipTask(deps, input);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toContain("merge");
    expect(result.output).toContain("unrelated histories");
    expect(result.commit).toBeUndefined();
  });

  it("R4: no winner means no merge, and the forks are still locked", async () => {
    const { deps, calls, revoked } = fakeDeps();
    const result = await shipTask(deps, { ...input, winner: null });
    expect(calls).toEqual([]);
    expect(revoked).toEqual(["fork-alpha", "fork-beta"]);
    expect(result).toEqual({
      status: "no-winner",
      winner: null,
      locks: [
        { agent: "alpha", fork: "fork-alpha", revoked: 2 },
        { agent: "beta", fork: "fork-beta", revoked: 2 },
      ],
    });
  });

  it("R5: every fork's write tokens are revoked, the winner's too, even when the merge fails", async () => {
    const failures: Answers[] = [
      { merge: { exitCode: 1, stdout: "", stderr: "conflict" } },
      { merge: { exitCode: 128, stdout: "", stderr: "fatal" } },
      { fetch: { exitCode: 128, stdout: "", stderr: "not found" } },
      { checkout: new Error("clone failed") },
      { push: { exitCode: 1, stdout: "", stderr: "rejected" } },
    ];
    for (const answers of failures) {
      const { deps, revoked } = fakeDeps(answers, ["fork-alpha"]);
      const result = await shipTask(deps, input);
      expect(result.status).not.toBe("merged");
      expect(revoked).toEqual(["fork-alpha", "fork-beta"]);
      expect(result.locks).toEqual([
        { agent: "alpha", fork: "fork-alpha", error: "Error: cannot revoke fork-alpha" },
        { agent: "beta", fork: "fork-beta", revoked: 2 },
      ]);
    }
  });

  it("a revoke that throws synchronously is reported and does not stop the others", async () => {
    const { deps } = fakeDeps();
    const revoked: string[] = [];
    deps.revokeWriteTokens = (repo) => {
      revoked.push(repo);
      if (repo === "fork-alpha") throw new Error("sync boom");
      return Promise.resolve(1);
    };
    const result = await shipTask(deps, input);
    expect(revoked).toEqual(["fork-alpha", "fork-beta"]);
    expect(result.locks).toEqual([
      { agent: "alpha", fork: "fork-alpha", error: "Error: sync boom" },
      { agent: "beta", fork: "fork-beta", revoked: 1 },
    ]);
  });

  it("reports failed git commands and thrown errors as \"error\"", async () => {
    const push = await shipTask(fakeDeps({ push: { exitCode: 1, stdout: "", stderr: "x".repeat(5_000) } }).deps, input);
    expect(push.status).toBe("error");
    expect(push.error).toContain("push");
    expect(push.output).toHaveLength(SHIP_OUTPUT_LIMIT);

    const thrown = await shipTask(fakeDeps({ checkout: new Error("clone failed") }).deps, input);
    expect(thrown).toMatchObject({ status: "error", error: "clone failed" });
    expect("output" in thrown).toBe(false);
  });

  it("an unknown winner is an error with no git", async () => {
    const { deps, calls, revoked } = fakeDeps();
    const result = await shipTask(deps, { ...input, winner: "gamma" });
    expect(result.status).toBe("error");
    expect(calls).toEqual([]);
    expect(revoked).toEqual(["fork-alpha", "fork-beta"]);
  });
});
