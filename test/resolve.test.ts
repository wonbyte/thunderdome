import { describe, expect, it } from "vitest";

import {
  BUNDLE_PATH,
  pickResolution,
  raceConflict,
  RESOLVE_DIR,
  RESOLVE_REF_PREFIX,
  resolvedMessage,
  resolverCommand,
  type CommandResult,
  type ConflictRequest,
  type RaceDeps,
  type ResolveAttempt,
  type ResolverName,
} from "../src/ship/resolve";

const req: ConflictRequest = {
  taskId: "t1",
  prompt: "Add a discount code",
  winner: "fast",
  winnerRemote: "https://git.test/git/thunderdome/t1-fast.git",
  winnerBranch: "main",
  base: "base0",
  theirs: "their1",
  message: "Thunderdome: ship fast's fork for task t1\n\nFast passed every test.",
  files: ["src/cart.ts"],
};

// How one fake resolver behaves.
interface Plan {
  leaves?: "done" | "markers" | "grepFails" | "aborted" | "committed";
  tests?: [number, number] | "none";
  finishAt?: number; // ms after the race start when the resolver ends
  lines?: number;
  claudeThrows?: boolean;
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const exit = (exitCode: number, stdout = ""): CommandResult => ({ exitCode, stdout, stderr: "" });

function fakeRace(plans: Partial<Record<ResolverName, Plan>>, setup: Record<string, CommandResult> = {}) {
  const calls: { argv: string[]; cwd: string; env?: Record<string, string> }[] = [];
  // Resolvers run at once, so time is real: 1 ms of waiting stands for 1 s of race.
  const t0 = performance.now();
  const committed = new Set<string>();
  const nameOf = (cwd: string) => cwd.slice(RESOLVE_DIR.length + 1) as ResolverName;
  const deps: RaceDeps = {
    now: () => (performance.now() - t0) * 1_000,
    async exec(argv, cwd, env) {
      calls.push({ argv, cwd, ...(env === undefined ? {} : { env }) });
      const key = argv.slice(0, 2).join(" ");
      if (setup[key] !== undefined) return setup[key];
      const name = nameOf(cwd);
      const plan = plans[name] ?? {};
      const leaves = plan.leaves ?? "done";
      if (argv.includes("claude")) {
        if (plan.claudeThrows === true) throw new Error("container gone");
        await new Promise((resolve) => setTimeout(resolve, (plan.finishAt ?? 30_000) / 1_000));
        return ok();
      }
      if (argv[0] === "tail") return ok(`{"type":"system","subtype":"init"}\n{"type":"result","is_error":false,"result":"done","total_cost_usd":0.05}\n`);
      if (key === "git merge") return exit(1, "CONFLICT (content): src/cart.ts");
      if (key === "git rev-parse") {
        if (argv[2] === "-q") return leaves === "aborted" ? exit(1) : ok(`${req.theirs}\n`);
        if (argv[2] === "HEAD^1") return ok(`${req.base}\n${req.theirs}\n`);
        if (committed.has(name)) return ok(`merge-${name}\n`);
        return ok(`${leaves === "committed" ? "other" : req.base}\n`);
      }
      if (key === "git diff" && argv[2] === "--numstat") return ok(`${plan.lines ?? 10}\t0\tsrc/cart.ts\n`);
      if (key === "git grep") return leaves === "markers" ? ok("src/cart.ts\n") : leaves === "grepFails" ? { exitCode: 2, stdout: "", stderr: "bad" } : exit(1);
      if (argv.includes("npm")) {
        const tests = plan.tests ?? [3, 3];
        return tests === "none" ? exit(1, "boom") : exit(tests[0] === tests[1] ? 0 : 1, `# tests ${tests[1]}\n# pass ${tests[0]}\n`);
      }
      if (key === "git commit") {
        committed.add(name);
        return ok();
      }
      if (argv[0] === "base64") return ok("QlVORExF\n");
      return ok();
    },
  };
  return { deps, calls };
}

describe("raceConflict", () => {
  it("gives each resolver its own worktree at the source head with the merge in progress", async () => {
    const { deps, calls } = fakeRace({});
    await raceConflict(deps, req);
    // Claude Code's output goes to a log outside the worktree, so it is never committed.
    const claude = calls.find((c) => c.argv.includes("claude"));
    expect(claude?.argv.slice(0, 5)).toEqual(["/bin/sh", "-c", 'log="$1"; shift; "$@" > "$log" 2>&1', "resolve", "/workspace/resolve-logs/careful.jsonl"]);
    for (const name of ["careful", "fast", "tester"]) {
      const dir = `${RESOLVE_DIR}/${name}`;
      expect(calls).toContainEqual({ argv: ["git", "worktree", "add", "--detach", dir, "base0"], cwd: "/workspace/repo" });
      expect(calls.find((c) => c.cwd === dir && c.argv[1] === "merge")?.argv).toEqual(["git", "merge", "--no-ff", "--no-commit", "their1"]);
    }
    // The winner fork is fetched first, so the merge commit exists in the clone.
    expect(calls.find((c) => c.argv[1] === "fetch")?.argv).toEqual(["git", "fetch", "--", req.winnerRemote, "main"]);
  });

  it("ships the first green resolution and bundles every committed attempt", async () => {
    const { deps, calls } = fakeRace({ careful: { finishAt: 90_000 }, fast: { finishAt: 40_000, tests: [2, 3] }, tester: { finishAt: 60_000 } });
    const race = await raceConflict(deps, req);
    expect(race.chosen).toBe("tester");
    expect(race.bundle).toBe("QlVORExF");
    const byName = Object.fromEntries(race.attempts.map((a) => [a.agent, a]));
    expect(byName.fast).toMatchObject({ status: "red", commit: "merge-fast", tests: { passed: 2, total: 3 } });
    expect(byName.tester).toMatchObject({ status: "green", commit: "merge-tester", costUsd: 0.05 });
    const bundle = calls.find((c) => c.argv[1] === "bundle")?.argv;
    expect(bundle).toEqual([
      "git", "bundle", "create", BUNDLE_PATH,
      `${RESOLVE_REF_PREFIX}careful`, `${RESOLVE_REF_PREFIX}fast`, `${RESOLVE_REF_PREFIX}tester`,
      "^base0", "^their1",
    ]);
    expect(JSON.parse(JSON.stringify(race))).toEqual(race);
  });

  it("does not commit a resolution with markers, a failed marker check, an aborted merge or a commit of its own", async () => {
    const { deps, calls } = fakeRace({ careful: { leaves: "markers" }, fast: { leaves: "grepFails" }, tester: { leaves: "aborted" } });
    const race = await raceConflict(deps, req);
    expect(race.chosen).toBeUndefined();
    expect(race.bundle).toBeUndefined();
    expect(race.attempts.map((a) => a.status)).toEqual(["unresolved", "unresolved", "unresolved"]);
    expect(race.attempts.map((a) => a.note)).toEqual([
      "conflict markers left in: src/cart.ts",
      "checking for conflict markers failed: bad",
      "the merge was aborted",
    ]);
    expect(calls.some((c) => c.argv[1] === "commit" || c.argv[1] === "bundle")).toBe(false);

    const own = await raceConflict(fakeRace({ careful: { leaves: "committed" } }).deps, req);
    expect(own.attempts[0]).toMatchObject({ status: "unresolved", note: "HEAD moved: the resolver committed or switched branches" });
  });

  it("a broken attempt does not stop the others", async () => {
    const race = await raceConflict(fakeRace({ careful: { claudeThrows: true }, fast: { tests: "none" } }).deps, req);
    expect(race.attempts.map((a) => a.status)).toEqual(["failed", "red", "green"]);
    expect(race.attempts[0]?.note).toBe("container gone");
    expect(race.attempts[1]?.note).toBe("the tests printed no summary");
    expect(race.chosen).toBe("tester");
  });

  it("throws when the shared setup fails", async () => {
    const { deps } = fakeRace({}, { "git fetch": exit(128) });
    await expect(raceConflict(deps, req)).rejects.toThrow("git fetch");
  });
});

describe("pickResolution", () => {
  const a = (agent: ResolverName, status: ResolveAttempt["status"], seconds: number, lines = 10): ResolveAttempt => ({ agent, status, seconds, lines });

  it("takes the earliest green, then the smaller change, then RESOLVERS order", () => {
    expect(pickResolution([a("careful", "green", 50), a("fast", "red", 10), a("tester", "green", 40)])).toBe("tester");
    expect(pickResolution([a("careful", "green", 40, 30), a("fast", "green", 40, 12), a("tester", "green", 40, 12)])).toBe("fast");
    expect(pickResolution([a("careful", "red", 1), a("fast", "unresolved", 1), a("tester", "failed", 1)])).toBeUndefined();
  });
});

describe("resolver messages", () => {
  it("adds how the conflict was resolved under the merge message", () => {
    expect(resolvedMessage(req.message, "tester", 41, ["src/cart.ts", "test/cart.test.ts"], { passed: 5, total: 5 })).toBe(
      "Thunderdome: ship fast's fork for task t1\n\nFast passed every test.\n\n" +
        "The source changed during the race, so the merge conflicted in src/cart.ts, test/cart.test.ts. tester resolved it in 41 s; tests 5/5.\n",
    );
  });

  it("runs Claude Code under a hard timeout with the placeholder key, told not to commit or push", () => {
    const { argv, env } = resolverCommand("careful", req, "claude-sonnet-5-5");
    expect(argv.slice(0, 4)).toEqual(["timeout", "--kill-after=10", "300", "claude"]);
    expect(argv).toContain("--model");
    expect(argv.at(-1)).toContain("src/cart.ts");
    expect(env.ANTHROPIC_API_KEY).toBe("provided-by-worker");
    expect(argv.find((s) => s.includes("Do not commit, push"))).toBeDefined();
  });
});
