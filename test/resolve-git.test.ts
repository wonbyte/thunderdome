// The conflict race against real git: real repos, worktrees, merges, a bundle and a push.
// Only Claude Code and `npm test` are stand-ins.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { raceConflict, type CommandResult, type RaceDeps, type ResolverName } from "../src/ship/resolve";
import { shipTask, type ShipDeps, type ShipInput } from "../src/ship/ship";

const run = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
const BASE_TEXT = "one\ntwo\nthree\n";
const RESOLVED = "one\ntwo from source\ntwo from winner\nthree\n";

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

// Sandbox paths (/workspace/...) live under the test's temp dir.
const local = (path: string) => (path.startsWith("/workspace") ? join(root, path) : path);

// How each stand-in resolver behaves: write the resolution after a delay (ms), or leave the conflict.
type Behavior = { resolveAfter: number } | "leave";

function resolveDeps(behaviors: Record<ResolverName, Behavior>): RaceDeps {
  const t0 = performance.now();
  return {
    now: () => (performance.now() - t0) * 1_000,
    async exec(argv, cwd, env) {
      const dir = local(cwd);
      if (argv.includes("claude")) {
        const behavior = behaviors[dir.split("/").at(-1) as ResolverName];
        if (behavior !== "leave") {
          await new Promise((r) => setTimeout(r, behavior.resolveAfter));
          writeFileSync(join(dir, "app.txt"), RESOLVED);
        }
        return { exitCode: 0, stdout: '{"type":"result","is_error":false,"result":"ok","total_cost_usd":0.01}\n', stderr: "" };
      }
      if (argv.includes("npm")) {
        const pass = readFileSync(join(dir, "app.txt"), "utf8") === RESOLVED ? 1 : 0;
        return { exitCode: pass === 1 ? 0 : 1, stdout: `# tests 1\n# pass ${pass}\n`, stderr: "" };
      }
      return exec(argv.map(local), dir, env);
    },
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "thunderdome-resolve-"));
  const seed = join(root, "seed");
  await git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "app.txt"), BASE_TEXT);
  await git(seed, "add", "app.txt");
  await git(seed, "commit", "-q", "-m", "seed");
  await git(root, "clone", "-q", "--bare", seed, join(root, "source.git"));
  await git(root, "clone", "-q", "--bare", seed, join(root, "fork.git"));
  // The winner's change, pushed to the fork.
  await git(seed, "remote", "add", "fork", join(root, "fork.git"));
  writeFileSync(join(seed, "app.txt"), "one\ntwo from winner\nthree\n");
  await git(seed, "commit", "-q", "-am", "winner");
  await git(seed, "push", "-q", "fork", "HEAD:main");
  // The source moves on during the race, on the same line.
  await git(seed, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(seed, "app.txt"), "one\ntwo from source\nthree\n");
  await git(seed, "commit", "-q", "-am", "source moved");
  await git(seed, "push", "-q", join(root, "source.git"), "HEAD:main");
  // The ship clone and the resolve clone, like the two sandboxes.
  await git(root, "clone", "-q", join(root, "source.git"), join(root, "ship"));
  await git(root, "clone", "-q", join(root, "source.git"), join(root, "workspace", "repo"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function shipInput(): ShipInput {
  return {
    taskId: "t1",
    prompt: "Say where two comes from",
    source: { name: "source", remote: join(root, "source.git"), defaultBranch: "main" },
    forks: [{ agent: "fast", name: "fork", remote: join(root, "fork.git"), defaultBranch: "main" }],
    winner: "fast",
    why: "Fast won.",
  };
}

function shipDeps(behaviors: Record<ResolverName, Behavior>): ShipDeps {
  return {
    git: (args) => exec(["git", ...args], join(root, "ship"), IDENTITY),
    revokeWriteTokens: async () => 1,
    resolver: {
      race: (req) => raceConflict(resolveDeps(behaviors), req),
      async importBundle(bundle) {
        const path = join(root, "ship.bundle");
        writeFileSync(path, Buffer.from(bundle, "base64"));
        return path;
      },
    },
  };
}

describe("conflict race with real git", () => {
  it("ships the first green resolution as a merge of the source head and the winner", async () => {
    const sourceHead = await git(join(root, "source.git"), "rev-parse", "main");
    const winnerHead = await git(join(root, "fork.git"), "rev-parse", "main");
    const result = await shipTask(shipDeps({ careful: { resolveAfter: 150 }, fast: "leave", tester: { resolveAfter: 20 } }), shipInput());

    expect(result.status).toBe("merged");
    expect(result.resolve?.files).toEqual(["app.txt"]);
    expect(result.resolve?.chosen).toBe("tester");
    const status = Object.fromEntries((result.resolve?.attempts ?? []).map((a) => [a.agent, a.status]));
    expect(status).toEqual({ careful: "green", fast: "unresolved", tester: "green" });

    const source = join(root, "source.git");
    expect(await git(source, "rev-parse", "main")).toBe(result.commit);
    expect(await git(source, "rev-parse", "main^1", "main^2")).toBe(`${sourceHead}\n${winnerHead}`);
    expect(await git(source, "show", "main:app.txt")).toBe(RESOLVED.trimEnd());
    const message = await git(source, "log", "-1", "--format=%B", "main");
    expect(message).toMatch(/^Thunderdome: ship fast's fork for task t1\n\nFast won\.\n\nThe source changed during the race, so the merge conflicted in app\.txt\. tester resolved it in \d+ s; tests 1\/1\.$/);
    // careful's resolution is kept as a branch; fast made no commit.
    expect(result.resolve?.kept).toEqual(["thunderdome/t1/resolve-careful"]);
    expect(await git(source, "show", "thunderdome/t1/resolve-careful:app.txt")).toBe(RESOLVED.trimEnd());
    expect(await git(source, "branch", "--list")).not.toContain("resolve-fast");
  });

  it("stays \"conflict\" and pushes nothing when no resolver passes", async () => {
    const before = await git(join(root, "source.git"), "rev-parse", "main");
    const result = await shipTask(shipDeps({ careful: "leave", fast: "leave", tester: "leave" }), shipInput());
    expect(result.status).toBe("conflict");
    expect(result.resolve?.attempts.map((a) => a.status)).toEqual(["unresolved", "unresolved", "unresolved"]);
    expect(result.resolve?.attempts[0]?.note).toBe("conflict markers left in: app.txt");
    expect(await git(join(root, "source.git"), "rev-parse", "main")).toBe(before);
    expect(await git(join(root, "source.git"), "branch", "--list")).toBe("* main");
  });
});
