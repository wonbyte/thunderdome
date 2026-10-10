import { describe, expect, it, vi } from "vitest";

import { crossPath, isNodeTestFile, runCrossTests, takeTurns, usesNodeTest, type CrossDeps } from "../src/judge/crosstests";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const summary = (pass: number, tests: number) => ok(`ℹ tests ${tests}\nℹ pass ${pass}\n`);

/** A fake clone: answers by the command's first words. */
function clone(overrides: Record<string, (argv: string[]) => { exitCode: number; stdout: string; stderr: string }> = {}): CrossDeps & { exec: ReturnType<typeof vi.fn> } {
  const answers: Record<string, (argv: string[]) => { exitCode: number; stdout: string; stderr: string }> = {
    cat: () => ok(JSON.stringify({ scripts: { test: "node --test test/*.test.ts" } })),
    "git ls-tree": () => ok("src/cart.ts\ntest/cart.test.ts\nREADME.md\n"),
    "git diff": (argv) => ok(argv.at(-1) === "HEAD" ? "test/mine.test.ts\nsrc/x.ts\n" : "test/theirs.test.ts\n"),
    "git fetch": () => ok(),
    "git rev-parse": () => ok("abc123\n"),
    "/bin/sh": () => ok(),
    timeout: (argv) => (argv.at(-1)?.includes("from-zippy") ? summary(1, 3) : summary(2, 2)),
    ...overrides,
  };
  return {
    exec: vi.fn(async (argv: string[]) => {
      // A test file run as the tester (asTester) answers as "timeout"; base1's package.json as "cat".
      const line = argv[3] === "tester" ? ["timeout", ...argv.slice(6)].join(" ") : argv.join(" ") === "git show base1:package.json" ? "cat" : argv.join(" ");
      const key = Object.keys(answers).find((k) => line.startsWith(k));
      return key === undefined ? { exitCode: 1, stdout: "", stderr: "unknown" } : answers[key]!(argv);
    }),
  };
}

describe("cross tests", () => {
  it("T1: runs the base test files, the fork's own added files and each other fork's added files, one by one", async () => {
    const deps = clone();
    const results = await runCrossTests(deps, "ponder", "base1", [{ agent: "zippy", remote: "https://git.test/z.git", branch: "main" }]);
    expect(results).toEqual([
      { author: "base", file: "test/cart.test.ts", passed: 2, total: 2 },
      { author: "ponder", file: "test/mine.test.ts", passed: 2, total: 2 },
      { author: "zippy", file: "test/theirs.test.ts", passed: 1, total: 3 },
    ]);
    // Each copy goes next to the original under its own name, by argv only.
    const copies = deps.exec.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === "/bin/sh" && a[3] === "copy");
    expect(copies.map((c) => c.slice(-2))).toEqual([
      ["base1:test/cart.test.ts", "test/cart.from-base.test.ts"],
      ["abc123:test/theirs.test.ts", "test/theirs.from-zippy.test.ts"],
    ]);
  });

  it("T6: base test files run from the base commit, not as the fork edited them", async () => {
    const deps = clone();
    await runCrossTests(deps, "ponder", "base1", []);
    const runs = deps.exec.mock.calls.map((c) => c[0] as string[]).filter((a) => a[3] === "tester").map((a) => a.at(-1));
    expect(runs).toEqual(["test/cart.from-base.test.ts", "test/mine.test.ts"]);
  });

  it("T9: added files take turns by author, so one robot's many files can't push the others' past the budget", () => {
    const f = (author: string, file: string) => ({ author, file });
    const files = [f("zippy", "z2"), f("snip", "s1"), f("zippy", "z1"), f("zippy", "z3"), f("ponder", "p1")];
    expect(takeTurns(files).map((x) => x.file)).toEqual(["p1", "s1", "z1", "z2", "z3"]);
    const flood = [...Array.from({ length: 6 }, (_, i) => f("aaa", `a${i}`)), f("snip", "s1")];
    expect(takeTurns(flood).map((x) => x.file).slice(0, 2)).toEqual(["a0", "s1"]);
  });

  it("T7: every fork runs the added files in one order (in turns by author, files sorted), so the file cap drops the same files", async () => {
    const order = async (agent: string, other: string) => {
      const deps = clone({ "git diff": (argv) => ok(argv.at(-1) === "HEAD" ? `test/${agent}.test.ts\n` : `test/${other}.test.ts\n`) });
      const results = await runCrossTests(deps, agent, "base1", [{ agent: other, remote: "r", branch: "main" }]);
      return results?.map((r) => r.author);
    };
    expect(await order("zippy", "ponder")).toEqual(["base", "ponder", "zippy"]);
    expect(await order("ponder", "zippy")).toEqual(["base", "ponder", "zippy"]);
  });

  it("T2: a repo whose npm test is not node --test gets no cross tests", async () => {
    const deps = clone({ cat: () => ok(JSON.stringify({ scripts: { test: "vitest run" } })) });
    expect(await runCrossTests(deps, "ponder", "base1", [])).toBeUndefined();
  });

  it("T3: a fork that cannot be fetched adds no files; a file with no summary counts as 0 of 0", async () => {
    const deps = clone({ "git fetch": () => ({ exitCode: 128, stdout: "", stderr: "denied" }), timeout: () => ok("SyntaxError") });
    const results = await runCrossTests(deps, "ponder", "base1", [{ agent: "zippy", remote: "r", branch: "main" }]);
    expect(results?.map((r) => r.author)).toEqual(["base", "ponder"]);
    expect(results?.every((r) => r.passed === 0 && r.total === 0)).toBe(true);
  });

  it("T10: a file run that throws gets one more try, then counts as 0 of 0, and the other files still run", async () => {
    let baseTries = 0;
    const deps = clone({
      timeout: (argv) => {
        const file = argv.at(-1) ?? "";
        if (file.includes("mine")) throw new Error("output too large");
        if (file.includes("from-base") && ++baseTries === 1) throw new Error("sandbox hiccup");
        return summary(2, 2);
      },
    });
    const results = await runCrossTests(deps, "ponder", "base1", [{ agent: "zippy", remote: "r", branch: "main" }]);
    expect(results?.map((r) => [r.author, r.passed, r.total])).toEqual([["base", 2, 2], ["ponder", 0, 0], ["zippy", 2, 2]]);
    expect(baseTries).toBe(2);
  });

  it("T4: helpers: node test files, the npm test check and the copied path", () => {
    expect(isNodeTestFile("test/a.test.ts")).toBe(true);
    expect(isNodeTestFile("test/helpers.ts")).toBe(false);
    expect(usesNodeTest('{"scripts":{"test":"node --test test/*.test.ts"}}')).toBe(true);
    expect(usesNodeTest("not json")).toBe(false);
    expect(crossPath("test/cart.test.ts", "snip")).toBe("test/cart.from-snip.test.ts");
  });
});

describe("cross test budget", () => {
  it("T5: a fork whose cross tests would run past the budget stops and reports the files it ran", async () => {
    // Review finding: reporting none turned the shared suite off for every fork, so slow added files could switch it off.
    let t = 0;
    const deps = clone();
    const timed = { exec: async (argv: string[]) => {
      if (argv[3] === "tester") t += 200_000;
      return deps.exec(argv);
    }, now: () => t };
    const results = await runCrossTests(timed, "ponder", "base1", [{ agent: "zippy", remote: "r", branch: "main" }]);
    expect(results?.map((r) => r.author)).toEqual(["base", "ponder"]);
  });

  it("T8: the fork step's deadline cuts the cross tests short even inside the budget", async () => {
    const deps = { ...clone(), now: () => 0, deadline: 10_000 };
    expect(await runCrossTests(deps, "ponder", "base1", [])).toEqual([]);
    expect(await runCrossTests({ ...deps, deadline: 10 * 60_000 }, "ponder", "base1", [])).toHaveLength(2);
  });
});
