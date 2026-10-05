import { describe, expect, it } from "vitest";

import type { ConflictRequest, RaceOutcome } from "../src/ship/resolve";
import { mergeMessage, shipTask, SHIP_OUTPUT_LIMIT, type GitResult, type ShipDeps, type ShipInput, type ShipResolver } from "../src/ship/ship";

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

describe("shipTask with a conflict race", () => {
  const conflict: GitResult = { exitCode: 1, stdout: "CONFLICT (content): a.ts", stderr: "" };
  const green: RaceOutcome = {
    attempts: [
      { agent: "careful", status: "red", seconds: 50, commit: "m-careful", tests: { passed: 1, total: 2 } },
      { agent: "fast", status: "unresolved", seconds: 20, note: "conflict markers left in: a.ts" },
      { agent: "tester", status: "green", seconds: 41, commit: "m-tester", tests: { passed: 2, total: 2 } },
    ],
    chosen: "tester",
    bundle: "QlVORExF",
  };

  // Git answers for the ship clone: HEAD is the source head, FETCH_HEAD the winner's head.
  function raceDeps(race: RaceOutcome | Error, parents = "base0\ntheir1\n", keepPush: GitResult = ok()) {
    const calls: string[][] = [];
    const requests: ConflictRequest[] = [];
    const imported: string[] = [];
    const resolver: ShipResolver = {
      async race(req) {
        requests.push(req);
        if (race instanceof Error) throw race;
        return race;
      },
      async importBundle(bundle) {
        imported.push(bundle);
        return "/workspace/resolve.bundle";
      },
    };
    const deps: ShipDeps = {
      async git(args) {
        calls.push(args);
        if (args[0] === "merge" && args[1] !== "--abort") return conflict;
        if (args[0] === "diff") return ok("a.ts\n");
        if (args[0] === "rev-parse") return ok(args[1] === "HEAD" ? "base0\n" : args[1] === "FETCH_HEAD" ? "their1\n" : parents);
        if (args[0] === "push" && args[2]?.startsWith("refs/resolve/")) return keepPush;
        return ok();
      },
      revokeWriteTokens: async () => 1,
      resolver,
    };
    return { deps, calls, requests, imported };
  }

  it("races resolvers on the conflict and pushes the chosen merge commit", async () => {
    const { deps, calls, requests, imported } = raceDeps(green);
    const result = await shipTask(deps, input);
    expect(requests).toEqual([
      {
        taskId: "t1",
        prompt: "Add a feature",
        winner: "beta",
        winnerRemote: "https://git.test/git/thunderdome/fork-beta.git",
        winnerBranch: "trunk",
        base: "base0",
        theirs: "their1",
        message: mergeMessage("t1", "Add a feature", "beta", input.why),
        files: ["a.ts"],
      },
    ]);
    expect(imported).toEqual(["QlVORExF"]);
    // The conflicted files are read before the merge is aborted.
    const diffAt = calls.findIndex((c) => c[0] === "diff");
    const abortAt = calls.findIndex((c) => c[0] === "merge" && c[1] === "--abort");
    expect(diffAt).toBeGreaterThan(-1);
    expect(diffAt).toBeLessThan(abortAt);
    expect(calls).toContainEqual(["fetch", "/workspace/resolve.bundle", "+refs/resolve/*:refs/resolve/*"]);
    expect(calls).toContainEqual(["push", "origin", "m-tester:refs/heads/main"]);
    expect(calls).toContainEqual(["push", "origin", "refs/resolve/careful:refs/heads/thunderdome/t1/resolve-careful"]);
    expect(result).toMatchObject({
      status: "merged",
      commit: "m-tester",
      resolve: { files: ["a.ts"], chosen: "tester", kept: ["thunderdome/t1/resolve-careful"], attempts: green.attempts },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("stays \"conflict\" with the attempts when no resolution is green", async () => {
    const red: RaceOutcome = { attempts: green.attempts.map((a) => ({ ...a, status: "red" as const })) };
    const { deps, calls } = raceDeps(red);
    const result = await shipTask(deps, input);
    expect(result.status).toBe("conflict");
    expect(result.output).toContain("CONFLICT");
    expect(result.resolve).toEqual({ files: ["a.ts"], attempts: red.attempts });
    expect(calls.some((c) => c[0] === "push")).toBe(false);
  });

  it("stays \"conflict\" when the race itself fails, and still locks every fork", async () => {
    const { deps, calls } = raceDeps(new Error("no sandbox"));
    const result = await shipTask(deps, input);
    expect(result).toMatchObject({ status: "conflict", resolve: { files: ["a.ts"], attempts: [], error: "no sandbox" } });
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(result.locks).toHaveLength(2);
  });

  it("refuses a bundled commit that is not a merge of the source head and the winner", async () => {
    const { deps, calls } = raceDeps(green, "elsewhere\ntheir1\n");
    const result = await shipTask(deps, input);
    expect(result.status).toBe("conflict");
    expect(result.resolve?.error).toContain("not a merge of base0 and their1");
    expect(calls.some((c) => c[0] === "push")).toBe(false);
  });

  it("keeps the attempts when the push is rejected because the source moved again", async () => {
    const { deps } = raceDeps(green);
    const git = deps.git;
    deps.git = async (args) => (args[0] === "push" && args[2] === "m-tester:refs/heads/main" ? { exitCode: 1, stdout: "", stderr: "non-fast-forward" } : git(args));
    const result = await shipTask(deps, input);
    expect(result).toMatchObject({ status: "error", resolve: { files: ["a.ts"], attempts: green.attempts } });
    expect(result.output).toContain("non-fast-forward");
    expect(result.resolve?.chosen).toBeUndefined();
  });

  it("keeps the attempts when the push is rejected because the source moved again", async () => {
    const { deps } = raceDeps(green);
    const git = deps.git;
    deps.git = async (args) => (args[0] === "push" && args[2] === "m-tester:refs/heads/main" ? { exitCode: 1, stdout: "", stderr: "non-fast-forward" } : git(args));
    const result = await shipTask(deps, input);
    expect(result).toMatchObject({ status: "error", resolve: { files: ["a.ts"], attempts: green.attempts } });
    expect(result.output).toContain("non-fast-forward");
    expect(result.resolve?.chosen).toBeUndefined();
  });

  it("ships even when keeping the other attempts fails", async () => {
    const { deps } = raceDeps(green, undefined, { exitCode: 1, stdout: "", stderr: "rejected" });
    const result = await shipTask(deps, input);
    expect(result.status).toBe("merged");
    expect(result.resolve?.kept).toBeUndefined();
  });
});
