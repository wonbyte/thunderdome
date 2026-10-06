// The fusion round against real git: real repos, fetches, checkouts and commits. Only `npm test`
// and Clef are stand-ins.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BETTER_QUESTION, FUSE_THRESHOLD, fusionCandidates, fusionWhy, runFusion, type CommandResult, type FuseDeps } from "../src/judge/fusion";
import type { JudgedFork } from "../src/judge/judge";
import { scoreForks, type ForkInput } from "../src/judge/score";

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
        const additions = (body as { state: { additions: string } }).state.additions;
        const agent = Object.keys(yes).find((a) => additions.includes(`by ${a}`)) ?? "";
        return { answers: { better: { type: "noul", noul: yes[agent] ?? 0.9 } } };
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
    ponder: (d) => writeFileSync(join(d, "app.txt"), "fixed by ponder\n"),
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
      testsPassed: 1,
      candidates: [
        { agent: "zippy", remote: forks.zippy!, branch: "main", files: ["broken.txt"] },
        { agent: "testy", remote: forks.testy!, branch: "main", files: ["test-cart.txt", "old.txt"] },
      ],
    });
    expect(result.tried).toEqual([
      { agent: "zippy", files: ["broken.txt"], status: "rejected", tests: { passed: 0, total: 1 }, note: "not every test passed (0/1)" },
      { agent: "testy", files: ["test-cart.txt", "old.txt"], status: "added", tests: { passed: 2, total: 2 }, better: 0.9 },
    ]);
    // One fusion commit on the winner, authored by testy: its new test is in, the file it removed is gone,
    // the winner's own fix is kept, and the rejected file left nothing behind.
    expect(result.commit).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(await git(repo, "rev-parse", "HEAD^")).toBe(before);
    expect(await git(repo, "log", "-1", "--format=%an|%cn|%s")).toBe("Thunderdome testy|Thunderdome|Thunderdome fusion: add testy's test-cart.txt, old.txt to ponder's fix");
    expect(await git(repo, "show", "HEAD:app.txt")).toBe("fixed by ponder");
    expect(await git(repo, "ls-files")).toBe("app.txt\ntest-app.txt\ntest-cart.txt");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, "broken.txt"))).toBe(false);
    // The judge saw the winner's change and only the additions.
    const asked = deps.asked[0] as { state: { change: string; additions: string }; questions: unknown };
    expect(asked.questions).toBe(BETTER_QUESTION);
    expect(asked.state.change).toContain("+fixed by ponder");
    expect(asked.state.additions).toContain("+a new test by testy");
    expect(asked.state.additions).not.toContain("fixed by testy");
  });

  it("adds nothing when the judge does not find the additions better", async () => {
    const { forks } = await setup();
    const repo = join(root, "workspace/repo");
    const before = await git(repo, "rev-parse", "HEAD");
    const result = await runFusion(fuseDeps({ testy: FUSE_THRESHOLD - 0.1 }), {
      task: "Fix the app",
      winner: "ponder",
      testsPassed: 1,
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
      testsPassed: 1,
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
  it("takes each eligible loser's files the winner did not change, best loser first", () => {
    const inputs = [
      fork({ agent: "ponder", taskFit: 1, filesChanged: ["src/a.ts"], fix: "f1" }),
      fork({ agent: "testy", filesChanged: ["src/a.ts", "test/a.test.ts"], filesClaimed: ["src/a.ts", "test/a.test.ts"], fix: "f2" }),
      fork({ agent: "zippy", taskFit: 0.5, filesChanged: ["src/a.ts", "src/b.ts"], filesClaimed: ["src/a.ts", "src/b.ts"], fix: "f3" }),
      fork({ agent: "snip", testsPassed: 0, filesChanged: ["src/c.ts"], filesClaimed: ["src/c.ts"] }), // not eligible
      fork({ agent: "sparkle", taskFit: 0.9, filesChanged: ["src/a.ts"], fix: "f4" }), // nothing new
    ];
    const { ranked } = scoreForks(inputs);
    const remotes = Object.fromEntries(inputs.map((i) => [i.agent, { remote: `https://git.test/${i.agent}.git`, branch: "main" }]));
    expect(fusionCandidates(ranked, inputs.map(judged), "ponder", remotes)).toEqual([
      { agent: "testy", remote: "https://git.test/testy.git", branch: "main", files: ["test/a.test.ts"] },
      { agent: "zippy", remote: "https://git.test/zippy.git", branch: "main", files: ["src/b.ts"] },
    ]);
  });

  it("skips a loser that wrote the winner's exact fix", () => {
    const inputs = [fork({ agent: "ponder", fix: "same" }), fork({ agent: "testy", filesChanged: ["src/a.ts", "x.ts"], filesClaimed: ["src/a.ts", "x.ts"], fix: "same" })];
    const { ranked } = scoreForks(inputs);
    expect(fusionCandidates(ranked, inputs.map(judged), "ponder", { testy: { remote: "r", branch: "main" } })).toEqual([]);
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
      "\n\nFusion (the losers' files the winner did not change, tried on top of its fix):\n" +
        "- Added testy's test/a.test.ts: every test passes (8/8) and the judge says it makes the change better (yes 0.83).\n" +
        "- Left out zippy's src/b.ts: not every test passed (6/8).",
    );
  });
});
