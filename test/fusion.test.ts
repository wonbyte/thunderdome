// The fusion round against real git: real repos, fetches, checkouts and commits. Only `npm test`
// and Clef are stand-ins.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BETTER_QUESTION,
  COVERAGE_QUESTION,
  FUSE_BUNDLE_PATH,
  FUSE_REF,
  FUSE_THRESHOLD,
  fusedAgents,
  fusionBundle,
  fusionCandidates,
  fusionProblem,
  fusionWhy,
  dropFusion,
  FUSE_HUNKS_PER_AGENT,
  fusedScore,
  hunkLabel,
  hunkName,
  isTestFile,
  isTrivialHunk,
  runFusion,
  scoreFusion,
  scoreLine,
  splitHunks,
  withoutPatches,
  type FusionResult,
  type CommandResult,
  type FuseDeps,
} from "../src/judge/fusion";
import type { JudgedFork } from "../src/judge/judge";
import { scoreForks, WEIGHTS, type ForkInput } from "../src/judge/score";
import type { Scorer } from "../src/judge/scorer";

const run = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };

let root: string;

async function exec(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(argv[0] ?? "", argv.slice(1), { cwd, env: { ...process.env, ...IDENTITY, ...env } });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof e.code === "number" ? e.code : 127, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec(["git", ...args], cwd);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const local = (path: string) => (path.startsWith("/workspace") ? join(root, path) : path);

// npm test stand-in: one passing test per test-*.txt file, and every test fails when broken.txt exists.
function npmTest(dir: string): CommandResult {
  const tests = readdirSync(dir).filter((f) => /^test-.*\.txt$/.test(f)).length;
  const pass = existsSync(join(dir, "broken.txt")) ? 0 : tests;
  return { exitCode: pass === tests ? 0 : 1, stdout: `# tests ${tests}\n# pass ${pass}\n`, stderr: "" };
}

// Clef stand-in: yes per agent, found by a marker in the additions.
function fuseDeps(yes: Record<string, number> = {}): FuseDeps & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    sleep: async () => {},
    async exec(argv, cwd, env) {
      const dir = local(cwd);
      if (argv.includes("npm")) return npmTest(dir);
      return exec(argv.map((a) => (a.startsWith("/workspace") ? local(a) : a)), dir, env);
    },
    ai: {
      async run(_model, body) {
        asked.push(body);
        const state = (body as { state: { additions?: string; added_tests?: string } }).state;
        const additions = state.additions ?? state.added_tests ?? "";
        const agent = Object.keys(yes).find((a) => additions.includes(`by ${a}`)) ?? "";
        const noul = { type: "noul", noul: yes[agent] ?? 0.9 };
        return { answers: { better: noul, covers: noul } };
      },
    },
  };
}

// A source with one test, and forks: the winner changes app.txt; others add files.
async function setup(): Promise<{ forks: Record<string, string> }> {
  const source = join(root, "source");
  mkdirSync(source);
  await git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "app.txt"), "base\n");
  writeFileSync(join(source, "test-app.txt"), "app test\n");
  writeFileSync(join(source, "old.txt"), "to be removed\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-q", "-m", "base");
  const forks: Record<string, string> = {};
  const edits: Record<string, (dir: string) => void> = {
    ponder: (d) => {
      writeFileSync(join(d, "app.txt"), "fixed by ponder\n");
      writeFileSync(join(d, "test-ponder.test.txt"), "ponder's own test\n");
    },
    snip: (d) => writeFileSync(join(d, "test-snip.test.txt"), "an edge case test by snip\n"),
    testy: (d) => {
      writeFileSync(join(d, "app.txt"), "fixed by testy\n");
      writeFileSync(join(d, "test-cart.txt"), "a new test by testy\n");
      rmSync(join(d, "old.txt"));
    },
    zippy: (d) => writeFileSync(join(d, "broken.txt"), "breaks every test, by zippy\n"),
  };
  for (const [agent, edit] of Object.entries(edits)) {
    const dir = join(root, `fork-${agent}`);
    await git(root, "clone", "-q", source, dir);
    edit(dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", `${agent}'s work`);
    forks[agent] = dir;
  }
  // The fusion sandbox's clone of the winner's fork.
  mkdirSync(join(root, "workspace"));
  await git(root, "clone", "-q", forks.ponder!, join(root, "workspace/repo"));
  return { forks };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fusion-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runFusion", () => {
  it("adds a loser's new files when every test passes and the judge says yes, and leaves out a loser that breaks the tests", async () => {
    const { forks } = await setup();
    const deps = fuseDeps();
    const repo = join(root, "workspace/repo");
    const before = await git(repo, "rev-parse", "HEAD");
    const result = await runFusion(deps, {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [
        { agent: "zippy", remote: forks.zippy!, branch: "main", files: ["broken.txt"] },
        { agent: "testy", remote: forks.testy!, branch: "main", files: ["test-cart.txt", "old.txt"] },
      ],
    });
    expect(result.tried).toEqual([
      { agent: "zippy", files: ["broken.txt"], kind: "file", status: "rejected", tests: { passed: 0, total: 2 }, note: "not every test passed (0/2)" },
      { agent: "testy", files: ["test-cart.txt", "old.txt"], kind: "file", status: "added", tests: { passed: 3, total: 3 }, better: 0.9, question: "better" },
    ]);
    // One fusion commit on the winner, authored by testy: its new test is in, the file it removed is gone,
    // the winner's own fix is kept, and the rejected file left nothing behind.
    expect(result.commit).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(await git(repo, "rev-parse", "HEAD^")).toBe(before);
    expect(await git(repo, "log", "-1", "--format=%an|%cn|%s")).toBe("Thunderdome testy|Thunderdome|Thunderdome fusion: add testy's test-cart.txt, old.txt to ponder's fix");
    expect(await git(repo, "show", "HEAD:app.txt")).toBe("fixed by ponder");
    expect(await git(repo, "ls-files")).toBe("app.txt\ntest-app.txt\ntest-cart.txt\ntest-ponder.test.txt");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, "broken.txt"))).toBe(false);
    // The judge saw the winner's change and only the additions.
    const asked = deps.asked[0] as { state: { change: string; additions: string }; questions: unknown };
    expect(asked.questions).toBe(BETTER_QUESTION);
    expect(asked.state.change).toContain("+fixed by ponder");
    expect(asked.state.additions).toContain("+a new test by testy");
    expect(asked.state.additions).not.toContain("fixed by testy");
  });

  it("asks the coverage question for test files, with the winner's code and tests apart, and says so in the commit", async () => {
    const { forks } = await setup();
    const deps = fuseDeps();
    const repo = join(root, "workspace/repo");
    const result = await runFusion(deps, {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [{ agent: "snip", remote: forks.snip!, branch: "main", files: ["test-snip.test.txt"] }],
    });
    expect(result.tried[0]).toMatchObject({ status: "added", question: "coverage", tests: { passed: 3, total: 3 } });
    const asked = deps.asked[0] as { state: Record<string, string>; questions: unknown };
    expect(asked.questions).toBe(COVERAGE_QUESTION);
    expect(asked.state.winner_code).toContain("+fixed by ponder");
    expect(asked.state.winner_code).not.toContain("ponder's own test");
    expect(asked.state.winner_tests).toContain("+ponder's own test");
    expect(asked.state.added_tests).toContain("+an edge case test by snip");
    expect(await git(repo, "log", "-1", "--format=%b")).toContain("the judge says they check something the task asks that ponder's tests do not (yes 0.9)");
  });

  it("says when the judge finds nothing new in the added tests", async () => {
    const { forks } = await setup();
    const result = await runFusion(fuseDeps({ snip: 0.3 }), {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [{ agent: "snip", remote: forks.snip!, branch: "main", files: ["test-snip.test.txt"] }],
    });
    expect(result.tried[0]).toMatchObject({ status: "rejected", question: "coverage", note: "the judge found nothing new that the task asks for (yes 0.3)" });
    expect(result.commit).toBeUndefined();
  });

  it("adds nothing when the judge does not find the additions better", async () => {
    const { forks } = await setup();
    const repo = join(root, "workspace/repo");
    const before = await git(repo, "rev-parse", "HEAD");
    const result = await runFusion(fuseDeps({ testy: FUSE_THRESHOLD - 0.1 }), {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [{ agent: "testy", remote: forks.testy!, branch: "main", files: ["test-cart.txt"] }],
    });
    expect(result.commit).toBeUndefined();
    expect(result.tried[0]).toMatchObject({ status: "rejected", better: 0.5, note: "the judge did not find it better (yes 0.5)" });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("marks a try that breaks as failed and still runs the next one", async () => {
    const { forks } = await setup();
    const result = await runFusion(fuseDeps(), {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [
        { agent: "snip", remote: join(root, "missing"), branch: "main", files: ["x.txt"] },
        { agent: "testy", remote: forks.testy!, branch: "main", files: ["test-cart.txt"] },
      ],
    });
    expect(result.tried[0]).toMatchObject({ agent: "snip", status: "failed" });
    expect(result.tried[0]?.note).toContain("git fetch");
    expect(result.tried[1]).toMatchObject({ agent: "testy", status: "added" });
  });
});

function fork(over: Partial<ForkInput> & { agent: string }): ForkInput {
  return { testsPassed: 5, testsTotal: 5, taskFit: 0.8, clarity: 0.8, linesChanged: 10, filesChanged: ["src/a.ts"], filesClaimed: ["src/a.ts"], ...over };
}

function judged(input: ForkInput): JudgedFork {
  return {
    agent: input.agent,
    fork: `t-${input.agent}`,
    tests: { passed: input.testsPassed, total: input.testsTotal },
    diff: { filesChanged: input.filesChanged, linesAdded: 5, linesRemoved: 5 },
    input,
  };
}

describe("fusionCandidates", () => {
  it("takes each eligible loser's files the winner did not change and the files both changed, best loser first", () => {
    const inputs = [
      fork({ agent: "ponder", taskFit: 1, filesChanged: ["src/a.ts"], fix: "f1" }),
      fork({ agent: "testy", filesChanged: ["src/a.ts", "test/a.test.ts"], filesClaimed: ["src/a.ts", "test/a.test.ts"], fix: "f2" }),
      fork({ agent: "zippy", taskFit: 0.5, filesChanged: ["src/a.ts", "src/b.ts"], filesClaimed: ["src/a.ts", "src/b.ts"], fix: "f3" }),
      fork({ agent: "snip", testsPassed: 0, filesChanged: ["src/c.ts"], filesClaimed: ["src/c.ts"] }), // not eligible
      fork({ agent: "sparkle", taskFit: 0.9, filesChanged: ["src/a.ts"], fix: "f4" }), // only hunks in the winner's file
    ];
    const { ranked } = scoreForks(inputs);
    const remotes = Object.fromEntries(inputs.map((i) => [i.agent, { remote: `https://git.test/${i.agent}.git`, branch: "main" }]));
    expect(fusionCandidates(ranked, inputs.map(judged), "ponder", remotes)).toEqual([
      { agent: "sparkle", remote: "https://git.test/sparkle.git", branch: "main", files: [], shared: ["src/a.ts"] },
      { agent: "testy", remote: "https://git.test/testy.git", branch: "main", files: ["test/a.test.ts"], shared: ["src/a.ts"] },
      { agent: "zippy", remote: "https://git.test/zippy.git", branch: "main", files: ["src/b.ts"], shared: ["src/a.ts"] },
    ]);
  });

  it("skips a loser that wrote the winner's exact fix", () => {
    const inputs = [fork({ agent: "ponder", fix: "same" }), fork({ agent: "testy", filesChanged: ["src/a.ts", "x.ts"], filesClaimed: ["src/a.ts", "x.ts"], fix: "same" })];
    const { ranked } = scoreForks(inputs);
    expect(fusionCandidates(ranked, inputs.map(judged), "ponder", { testy: { remote: "r", branch: "main" } })).toEqual([]);
  });
});

describe("fusedAgents", () => {
  it("names each agent with an added try once, and none when no fusion commit was pushed", () => {
    const tried = [
      { agent: "testy", files: ["a.test.ts"], status: "added" as const },
      { agent: "zippy", files: ["b.ts"], status: "rejected" as const },
      { agent: "testy", files: ["c.test.ts"], status: "added" as const },
    ];
    expect(fusedAgents({ tried, commit: "f".repeat(40) })).toEqual(["testy"]);
    expect(fusedAgents({ tried })).toEqual([]);
  });
});

describe("fusionWhy", () => {
  it("lists every try, and says nothing when nothing was tried", () => {
    expect(fusionWhy({ tried: [] })).toBe("");
    expect(
      fusionWhy({
        tried: [
          { agent: "testy", files: ["test/a.test.ts"], status: "added", tests: { passed: 8, total: 8 }, better: 0.834 },
          { agent: "zippy", files: ["src/b.ts"], status: "rejected", note: "not every test passed (6/8)" },
        ],
      }),
    ).toBe(
      "\n\nFusion (the losers' files the winner did not change, and their hunks in files it did, tried on top of its fix):\n" +
        "- Added testy's test/a.test.ts: every test passes (8/8) and the judge says it makes the change better (yes 0.83).\n" +
        "- Left out zippy's src/b.ts: not every test passed (6/8).",
    );
  });
});

describe("isTestFile", () => {
  it("knows test files by folder or name", () => {
    for (const f of ["test/a.ts", "src/test/a.ts", "tests/x.py", "__tests__/a.js", "src/a.test.ts", "a.spec.js", "test/zippy.test.ts"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["src/a.ts", "testing.md", "src/latest/a.ts", "contest/a.ts", "README.md"]) expect(isTestFile(f), f).toBe(false);
  });
});

describe("the fusion push", () => {
  // Runs a fusion that keeps testy's test, bundles it, then makes a fresh clone of the winner
  // (the push sandbox) and loads the bundle into it, as the workflow does.
  async function fusedAndLoaded(tamper?: (repo: string) => Promise<void>) {
    const { forks } = await setup();
    const deps = fuseDeps();
    const fused = await runFusion(deps, {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [{ agent: "testy", remote: forks.testy!, branch: "main", files: ["test-cart.txt"] }],
    });
    const repo = join(root, "workspace/repo");
    if (tamper !== undefined) await tamper(repo);
    const commit = await git(repo, "rev-parse", "HEAD");
    const bundle = await fusionBundle(deps, fused.base!, commit);
    const saved = join(root, "saved.bundle");
    writeFileSync(saved, Buffer.from(bundle, "base64"));
    rmSync(repo, { recursive: true, force: true });
    await git(root, "clone", "-q", forks.ponder!, repo);
    copyFileSync(saved, local(FUSE_BUNDLE_PATH));
    await git(repo, "fetch", "-q", local(FUSE_BUNDLE_PATH), `+${FUSE_REF}:${FUSE_REF}`);
    return { deps, fused: { ...fused, commit }, repo, forks };
  }

  it("passes a bundle that only adds the kept files on top of the winner's head", async () => {
    const { deps, fused, repo } = await fusedAndLoaded();
    expect(fused.base).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(await fusionProblem(deps, fused)).toBeUndefined();
    expect(await git(repo, "log", "-1", "--format=%an", FUSE_REF)).toBe("Thunderdome testy");
  });

  it("refuses a bundle whose commits change a file no gate passed", async () => {
    const { deps, fused } = await fusedAndLoaded(async (repo) => {
      writeFileSync(join(repo, "app.txt"), "sneaky\n");
      await git(repo, "commit", "-qam", "sneaky");
    });
    expect(await fusionProblem(deps, fused)).toBe("the fusion changes files no gate passed: app.txt");
  });

  it("refuses when the winner's fork moved, or the bundle does not hold the fused commit", async () => {
    const { deps, fused, repo } = await fusedAndLoaded();
    expect(await fusionProblem(deps, { ...fused, commit: "0".repeat(40) })).toBe("the fusion bundle does not hold the fused commit");
    writeFileSync(join(repo, "app.txt"), "moved\n");
    await git(repo, "commit", "-qam", "moved");
    expect(await fusionProblem(deps, fused)).toMatch(/^the winner's fork moved during the fusion round/);
  });

  it("skips candidates once the round is out of time", async () => {
    const { forks } = await setup();
    const deps = { ...fuseDeps(), now: () => 100, deadline: 50 };
    const result = await runFusion(deps, {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [{ agent: "testy", remote: forks.testy!, branch: "main", files: ["test-cart.txt"] }],
    });
    expect(result.tried).toEqual([{ agent: "testy", files: ["test-cart.txt"], status: "rejected", note: "the fusion round ran out of time" }]);
    expect(result.commit).toBeUndefined();
  });
});

// A shop file with three functions far apart, so each edit is its own hunk.
const FUNCS = ["badge", "sort", "cart", "round", "empty"];
function shop(bodies: Record<string, string> = {}, note = ""): string {
  const filler = Array.from({ length: 8 }, (_, i) => `// filler ${i}`).join("\n");
  return `${note}${FUNCS.map((f) => `function ${f}() {\n  return ${bodies[f] ?? '""'};\n}\n${filler}`).join("\n")}\n`;
}

// The winner (ponder) writes badge; testy writes badge differently (conflicts), plus cart and a
// comment; snip writes the exact badge ponder wrote, plus round.
async function hunkSetup(): Promise<{ forks: Record<string, string> }> {
  const source = join(root, "source");
  mkdirSync(source);
  await git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "shop.js"), shop());
  writeFileSync(join(source, "test-app.txt"), "app test\n");
  await git(source, "add", "-A");
  await git(source, "commit", "-q", "-m", "base");
  const edits: Record<string, string> = {
    ponder: shop({ badge: '"Sale by ponder"' }),
    testy: shop({ badge: '"SALE by testy"', cart: '"Your cart is empty, by testy"' }, "// A note by testy\n"),
    snip: shop({ badge: '"Sale by ponder"', round: "Math.round(1) // by snip" }),
    zippy: shop({ badge: '"z"', sort: '"s by zippy"', cart: '"c by zippy"', round: '"r by zippy"', empty: '"e by zippy"' }),
  };
  const forks: Record<string, string> = {};
  for (const [agent, text] of Object.entries(edits)) {
    const dir = join(root, `fork-${agent}`);
    await git(root, "clone", "-q", source, dir);
    writeFileSync(join(dir, "shop.js"), text);
    await git(dir, "commit", "-qam", `${agent}'s work`);
    forks[agent] = dir;
  }
  mkdirSync(join(root, "workspace"));
  await git(root, "clone", "-q", forks.ponder!, join(root, "workspace/repo"));
  return { forks };
}

const hunkInput = (forks: Record<string, string>, agents: string[]) => ({
  task: "Finish the shop",
  winner: "ponder",
  testsPassed: 1,
  candidates: agents.map((agent) => ({ agent, remote: forks[agent]!, branch: "main", files: [], shared: ["shop.js"] })),
});

describe("hunk fusion", () => {
  it("adds a loser's hunk that applies cleanly, and skips its conflicting, comment-only and already-there hunks", async () => {
    const { forks } = await hunkSetup();
    const deps = fuseDeps();
    const repo = join(root, "workspace/repo");
    const result = await runFusion(deps, hunkInput(forks, ["testy", "snip"]));
    expect(result.tried.map((t) => [t.agent, t.kind, t.status, t.hunk?.name])).toEqual([
      ["testy", "hunk", "added", "cart"],
      ["snip", "hunk", "added", "round"],
    ]);
    const shipped = await git(repo, "show", "HEAD:shop.js");
    expect(shipped).toContain('"Sale by ponder"'); // the winner's badge stays
    expect(shipped).toContain('"Your cart is empty, by testy"');
    expect(shipped).toContain("Math.round(1) // by snip");
    expect(shipped).not.toContain("A note by testy");
    expect(await git(repo, "log", "-2", "--format=%an|%s")).toBe(
      "Thunderdome snip|Thunderdome fusion: add snip's round in shop.js to ponder's fix\nThunderdome testy|Thunderdome fusion: add testy's cart in shop.js to ponder's fix",
    );
    expect(await git(repo, "status", "--porcelain")).toBe("");
    // Clef saw only the hunk as the additions.
    const asked = deps.asked[0] as { state: { additions: string } };
    expect(asked.state.additions).toContain('+  return "Your cart is empty, by testy";');
    expect(asked.state.additions).not.toContain("SALE by testy");
    // Each kept hunk records the exact patch of its commit.
    const kept = result.tried[0]!;
    expect(kept.patch).toBe((await exec(["git", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--full-index", "HEAD~2", "HEAD~1"], repo)).stdout);
  });

  it("tries at most FUSE_HUNKS_PER_AGENT hunks of one loser", async () => {
    const { forks } = await hunkSetup();
    const result = await runFusion(fuseDeps(), hunkInput(forks, ["zippy"]));
    expect(result.tried).toHaveLength(FUSE_HUNKS_PER_AGENT);
    expect(result.tried.map((t) => t.hunk?.name)).toEqual(["sort", "cart", "round"]);
  });

  it("a hunk that breaks the tests or that the judge turns down is left out, and the next hunk still runs", async () => {
    const { forks } = await hunkSetup();
    const deps = fuseDeps({ testy: 0.2 });
    const result = await runFusion(deps, hunkInput(forks, ["testy", "snip"]));
    expect(result.tried[0]).toMatchObject({ agent: "testy", kind: "hunk", status: "rejected", note: "the judge did not find it better (yes 0.2)" });
    expect(result.tried[0]?.patch).toBeUndefined();
    expect(result.tried[1]).toMatchObject({ agent: "snip", status: "added" });
  });

  it("the push check passes a hunk bundle as built, and refuses one whose hunk commit was changed", async () => {
    const { forks } = await hunkSetup();
    const deps = fuseDeps();
    const fused = await runFusion(deps, hunkInput(forks, ["testy"]));
    const repo = join(root, "workspace/repo");
    // Reload the bundle into a fresh clone, as the push sandbox does.
    const load = async (commit: string) => {
      const bundle = await fusionBundle(deps, fused.base!, commit);
      const saved = join(root, "saved.bundle");
      writeFileSync(saved, Buffer.from(bundle, "base64"));
      const fresh = join(root, "fresh");
      rmSync(fresh, { recursive: true, force: true });
      await git(root, "clone", "-q", forks.ponder!, fresh);
      await git(fresh, "fetch", "-q", saved, `+${FUSE_REF}:${FUSE_REF}`);
      const pushDeps = { exec: (argv: string[], _cwd: string) => exec(argv, fresh) };
      return (r: FusionResult) => fusionProblem(pushDeps, r);
    };
    expect(await (await load(fused.commit!))(fused)).toBeUndefined();
    // Same file, other content: the path check alone would pass it.
    writeFileSync(join(repo, "shop.js"), (await git(repo, "show", "HEAD:shop.js")).replace("Your cart is empty", "Sneaky") + "\n");
    await git(repo, "commit", "-q", "--amend", "-am", "amended");
    const amended = await git(repo, "rev-parse", "HEAD");
    expect(await (await load(amended))({ ...fused, commit: amended })).toMatch(/^the fusion commit [0-9a-f]{7} is not the hunk the gates passed$/);
  });
});

describe("hunk parsing", () => {
  const diff = [
    "diff --git a/src/cart.ts b/src/cart.ts",
    "index 1111111..2222222 100644",
    "--- a/src/cart.ts",
    "+++ b/src/cart.ts",
    "@@ -1,3 +1,4 @@ export function total(items) {",
    " const a = 1;",
    "+export function cartMessage(items) {",
    " const b = 2;",
    "@@ -10,2 +11,2 @@ export function total(items) {",
    "-  return 1;",
    "+  return 2;",
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1 @@",
    "+x",
    "",
  ].join("\n");

  it("splits a diff into one patch per hunk with its file header, leaving out new files", () => {
    const hunks = splitHunks(diff);
    expect(hunks.map((h) => [h.file, h.header, h.name])).toEqual([
      ["src/cart.ts", "@@ -1,3 +1,4 @@", "cartMessage"],
      ["src/cart.ts", "@@ -10,2 +11,2 @@", "total"],
    ]);
    expect(hunks[1]?.patch).toBe("diff --git a/src/cart.ts b/src/cart.ts\nindex 1111111..2222222 100644\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -10,2 +11,2 @@ export function total(items) {\n-  return 1;\n+  return 2;\n");
  });

  it("names hunks by their declaration or test title, and labels them", () => {
    expect(hunkName(['+  it("shows the empty cart", () => {'], "")).toBe("shows the empty cart");
    expect(hunkName(["+const SALE = 0.2;"], "")).toBe("SALE");
    expect(hunkName(["+  if (x) {", "+  return y;"], "function sortProducts(list) {")).toBe("sortProducts");
    // The declaration just above the change inside the hunk beats git's @@ context.
    expect(hunkName([" function cart() {", "-  return 1;", "+  return 2;"], "function sort() {")).toBe("cart");
    // A hunk inside a function is named for the function, not a local it renames.
    expect(hunkName([" export function formatPrice(cents) {", "-  const dollars = 1;", "+  const whole = 1;"], "")).toBe("formatPrice");
    // Seen live (t-8c79c7ce): the hunk edits the comment above the function first.
    expect(hunkName([" // Part 4", "-// old note", "+// new note", " export function formatPrice(cents) {", "-  const dollars = 1;", "+  const whole = 1;"], "export function cartMessage(count) {")).toBe("formatPrice");
    expect(hunkName(["+  return y;"], "")).toBeUndefined();
    expect(hunkLabel({ file: "a.ts", header: "@@ -1 +12,7 @@" })).toBe("lines 12-18 of a.ts");
    expect(hunkLabel({ file: "a.ts", header: "@@ -1 +3 @@", name: "x" })).toBe("x in a.ts");
  });

  it("knows a hunk that changes only whitespace or comments", () => {
    expect(isTrivialHunk({ added: ["// new note", "  "], removed: [] })).toBe(true);
    expect(isTrivialHunk({ added: ["return  1;"], removed: ["return 1;"] })).toBe(true);
    expect(isTrivialHunk({ added: ["return 2;"], removed: ["return 1;"] })).toBe(false);
  });
});

describe("the fused score", () => {
  const ranked = scoreForks([
    fork({ agent: "ponder", testsPassed: 20, testsTotal: 20, taskFit: 0.8, clarity: 0.8 }),
    fork({ agent: "testy", taskFit: 0.5 }),
  ]).ranked;
  const winner = ranked[0]!;

  it("fusedScore measures tests, task fit and clarity again, and keeps the winner's claim and look", () => {
    const score = fusedScore({ ...winner, parts: { ...winner.parts, claim: 8 } }, WEIGHTS, { tests: { passed: 26, total: 26 }, taskFit: 1, clarity: 0.8, linesChanged: 30 });
    expect(score.before).toMatchObject({ total: winner.total, tests: { passed: 20, total: 20 } });
    expect(score.after).toEqual({ total: 50 + 25 + 12 + 8, tests: { passed: 26, total: 26 }, parts: { tests: 50, taskFit: 25, clarity: 12, claim: 8 } });
    expect(scoreLine("Ponder", score)).toBe(`Ponder alone ${winner.total.toFixed(1)} -> fused 95.0 (tests 20/20 -> 26/26)`);
  });

  async function scored(taskFit: number, scorer?: Scorer, agent: "testy" | "snip" = "testy") {
    const { forks } = await setup();
    const deps = fuseDeps();
    const files = agent === "testy" ? ["test-cart.txt"] : ["test-snip.test.txt"];
    const fused = await runFusion(deps, {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 2,
      candidates: [{ agent, remote: forks[agent]!, branch: "main", files }],
    });
    const forkBase = await git(forks.ponder!, "rev-parse", "HEAD^");
    const rate: Scorer = scorer ?? { score: async () => ({ taskFit, clarity: 0.8, raw: {} as never }) };
    return { fused, result: await scoreFusion({ ...deps, scorer: rate }, fused, { task: "Fix the app", winner, weights: WEIGHTS, forkBase }) };
  }

  it("scoreFusion keeps a fusion that scores at least the winner alone", async () => {
    const { fused, result } = await scored(1);
    expect(result.commit).toBe(fused.commit);
    expect(result.score?.after).toMatchObject({ total: 97, tests: { passed: 3, total: 3 } });
    expect(fusionWhy(result, "ponder")).toContain(`Scored the same way as the forks: ponder alone ${winner.total.toFixed(1)} -> fused 97.0 (tests 20/20 -> 3/3), so the fusion is kept.`);
  });

  it("scoreFusion drops a fusion that scores below the winner, and says why", async () => {
    const { result } = await scored(0.2);
    expect(result.commit).toBeUndefined();
    expect(result.score?.after.total).toBeLessThan(result.score!.before.total);
    expect(result.tried[0]).toMatchObject({ status: "rejected", note: `the fused change scored ${result.score!.after.total.toFixed(1)}, below ${winner.total.toFixed(1)} for the winner alone` });
    expect(fusionWhy(result, "ponder")).toContain("so the fusion is dropped.");
  });

  it("scoreFusion keeps a tests-only fusion that scores lower, since tests cannot raise the score", async () => {
    const { fused, result } = await scored(0.2, undefined, "snip");
    expect(result.commit).toBe(fused.commit);
    expect(result.score!.after.total).toBeLessThan(result.score!.before.total);
    expect(result.tried[0]).toMatchObject({ status: "added" });
    expect(fusionWhy(result, "ponder")).toContain("so the fusion is kept anyway: it adds only tests, which cannot raise the score.");
  });

  it("scoreFusion keeps the fusion unscored when the scorer fails", async () => {
    const { fused, result } = await scored(1, { score: () => Promise.reject(new Error("Clef is down")) });
    expect(result.commit).toBe(fused.commit);
    expect(result.score).toBeUndefined();
    expect(result.scoreNote).toBe("the fused change could not be scored: Clef is down");
    expect(fusionWhy(result)).toContain("Not scored: the fused change could not be scored: Clef is down; the fusion is kept on its gates.");
  });

  it("withoutPatches drops the hunk patches and keeps the rest", () => {
    expect(withoutPatches({ tried: [{ agent: "a", files: ["x"], status: "added", kind: "hunk", patch: "diff" }], commit: "c" })).toEqual({ tried: [{ agent: "a", files: ["x"], status: "added", kind: "hunk" }], commit: "c" });
  });

  it("dropFusion turns every kept try down and removes the commit", () => {
    const dropped = dropFusion({ tried: [{ agent: "a", files: ["x"], status: "added" }, { agent: "b", files: ["y"], status: "failed" }], commit: "c" }, "why");
    expect(dropped).toEqual({ tried: [{ agent: "a", files: ["x"], status: "rejected", note: "why" }, { agent: "b", files: ["y"], status: "failed" }] });
  });
});
