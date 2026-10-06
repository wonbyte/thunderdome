// Who wrote main: git blame over a real merge, with agent, fusion and Thunderdome commits.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitIdentity } from "../src/agents/runner";
import { parseBlame, shipBlame, type GitResult } from "../src/ship/ship";

const run = promisify(execFile);
const HUMAN = { GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com" };
const SHIP = { GIT_AUTHOR_NAME: "Thunderdome", GIT_AUTHOR_EMAIL: "thunderdome@thunderdome.local", GIT_COMMITTER_NAME: "Thunderdome", GIT_COMMITTER_EMAIL: "thunderdome@thunderdome.local" };

let dir: string;

async function git(args: string[], env: Record<string, string> = HUMAN): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, { cwd: dir, env: { ...process.env, ...env } });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function commit(env: Record<string, string>, files: Record<string, string>, message: string): Promise<void> {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  await git(["add", "-A"], env);
  await git(["commit", "-q", "-m", message], env);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blame-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("shipBlame", () => {
  it("counts the shipped change's lines by robot: the winner, a fused loser and none from before the race", async () => {
    await git(["init", "-q", "-b", "main"]);
    await commit(HUMAN, { "shop.js": "a\nb\nc\n", "old.js": "kept\n" }, "base");
    await git(["checkout", "-q", "-b", "fork"]);
    await commit(gitIdentity("ponder"), { "shop.js": "a\nb by ponder\nc\nd by ponder\ne by ponder\n\n" }, "ponder's fix");
    await commit(gitIdentity("testy"), { "cart.test.js": "t1\nt2\n" }, "Thunderdome fusion: add testy's cart.test.js");
    await git(["checkout", "-q", "main"]);
    await git(["merge", "-q", "--no-ff", "-m", "ship", "fork"], SHIP);
    const merge = (await git(["rev-parse", "HEAD"])).stdout.trim();
    expect(await shipBlame((args) => git(args), merge)).toEqual({ ponder: 3, testy: 2 });
  });

  it("is undefined when git fails", async () => {
    await git(["init", "-q", "-b", "main"]);
    expect(await shipBlame((args) => git(args), "0".repeat(40))).toBeUndefined();
    expect(await shipBlame(() => Promise.reject(new Error("sandbox down")), "abc")).toBeUndefined();
  });

  it("parseBlame names Thunderdome's own lines and anyone else as other, and adds to a running count", () => {
    const line = (mail: string, text: string, boundary = false) => `abc 1 1 1\nauthor X\nauthor-mail <${mail}>\n${boundary ? "boundary\n" : ""}filename f\n\t${text}\n`;
    const porcelain = line("thunderdome@thunderdome.local", "fix") + line("dev@example.com", "x") + line("zippy@thunderdome.local", "y", true) + line("zippy@thunderdome.local", "z");
    expect(parseBlame(porcelain, { zippy: 1 })).toEqual({ thunderdome: 1, other: 1, zippy: 2 });
  });
});
