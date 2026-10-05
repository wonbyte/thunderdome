import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentFromAuthor, commitMessage, isTestRun, shouldPush } from "../image/autopush.mjs";

const SCRIPT = fileURLToPath(new URL("../image/autopush.mjs", import.meta.url).href);
const SLOW = 30_000;

let tmp = "";
let env = { ...process.env };

function remoteDir(): string {
  return join(tmp, "remote.git");
}

function workDir(): string {
  return join(tmp, "work");
}

function statePath(): string {
  return join(tmp, "run", "autopush.json");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function remoteLog(): string[] {
  return git(tmp, ["--git-dir", remoteDir(), "log", "--format=%s", "main"]).split("\n");
}

function hookInput(toolName: string, command?: string): string {
  return JSON.stringify({ tool_name: toolName, tool_input: command === undefined ? { file_path: "x" } : { command } });
}

function runHook(cwd: string, input: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd, input, encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout };
}

function writeWork(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "autopush-"));
  env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Thunderdome tester",
    GIT_AUTHOR_EMAIL: "tester@thunderdome.local",
    GIT_COMMITTER_NAME: "Thunderdome tester",
    GIT_COMMITTER_EMAIL: "tester@thunderdome.local",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    AUTOPUSH_STATE: statePath(),
  };
  delete env.AUTOPUSH_MIN_INTERVAL_S;
  git(tmp, ["init", "--bare", "--quiet", "--initial-branch=main", "remote.git"]);
  git(tmp, ["clone", "--quiet", "remote.git", "work"]);
  writeWork(workDir(), "README.md", "hello\n");
  git(workDir(), ["add", "--all"]);
  git(workDir(), ["commit", "--quiet", "--message", "first"]);
  git(workDir(), ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("autopush hook", () => {
  it("P1: after a test-run Bash command with uncommitted changes, the hook commits and pushes them to the remote's main", () => {
    writeWork(workDir(), "src/a.ts", "export const a = 1;\n");
    expect(runHook(workDir(), hookInput("Bash", "npm test"))).toEqual({ status: 0, stdout: "" });
    expect(remoteLog()).toEqual(["Thunderdome tester: work in progress (src/a.ts)", "first"]);
    expect(git(workDir(), ["status", "--porcelain"])).toBe("");
    const state = JSON.parse(readFileSync(statePath(), "utf8")) as { lastPushAt: unknown };
    expect(typeof state.lastPushAt).toBe("number");
  }, SLOW);

  it("P2: after an edit, the hook pushes only when at least the minimum interval passed since the last auto-push", () => {
    const last = 1_000_000;
    expect(shouldPush({ toolName: "Edit", now: last + 5_000, lastPushAt: last, minIntervalS: 20 })).toBe(false);
    expect(shouldPush({ toolName: "Edit", now: last + 20_000, lastPushAt: last, minIntervalS: 20 })).toBe(true);
    expect(shouldPush({ toolName: "Write", now: last, minIntervalS: 20 })).toBe(true);
    expect(shouldPush({ toolName: "Bash", command: "npm test", now: last + 1_000, lastPushAt: last, minIntervalS: 20 })).toBe(true);
    expect(shouldPush({ toolName: "Bash", command: "ls", now: last + 1_000, lastPushAt: last, minIntervalS: 20 })).toBe(false);
    // The test-run exception is only for Bash.
    expect(shouldPush({ toolName: "Edit", command: "npm test", now: last + 1_000, lastPushAt: last, minIntervalS: 20 })).toBe(false);
  });

  it("P2: an edit right after an auto-push waits; one with no earlier push goes out", () => {
    writeWork(workDir(), "src/a.ts", "one\n");
    expect(runHook(workDir(), hookInput("Edit"))).toEqual({ status: 0, stdout: "" });
    expect(remoteLog()).toHaveLength(2);
    writeWork(workDir(), "src/b.ts", "two\n");
    expect(runHook(workDir(), hookInput("Edit"))).toEqual({ status: 0, stdout: "" });
    expect(remoteLog()).toHaveLength(2);
    // A test run pushes regardless.
    expect(runHook(workDir(), hookInput("Bash", "npm run build && npx vitest run"))).toEqual({ status: 0, stdout: "" });
    expect(remoteLog()[0]).toBe("Thunderdome tester: work in progress (src/b.ts)");
  }, SLOW);

  it("P3: with nothing new (clean tree, nothing unpushed) the hook makes no commit and no push", () => {
    const before = remoteLog();
    const head = git(workDir(), ["rev-parse", "HEAD"]);
    expect(runHook(workDir(), hookInput("Bash", "npm test"))).toEqual({ status: 0, stdout: "" });
    expect(remoteLog()).toEqual(before);
    expect(git(workDir(), ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(statePath())).toBe(false);
  }, SLOW);

  it("pushes commits the agent made itself", () => {
    writeWork(workDir(), "src/c.ts", "c\n");
    git(workDir(), ["add", "--all"]);
    git(workDir(), ["commit", "--quiet", "--message", "own commit"]);
    expect(runHook(workDir(), hookInput("Bash", "npm t"))).toEqual({ status: 0, stdout: "" });
    expect(remoteLog()).toEqual(["own commit", "first"]);
  }, SLOW);

  it("P5: bad stdin, a repo without a remote, or a failing push all exit 0 with nothing on stdout", () => {
    expect(runHook(workDir(), "not json")).toEqual({ status: 0, stdout: "" });
    expect(runHook(workDir(), "")).toEqual({ status: 0, stdout: "" });

    const lonely = join(tmp, "lonely");
    mkdirSync(lonely);
    git(lonely, ["init", "--quiet"]);
    writeWork(lonely, "a.txt", "a\n");
    expect(runHook(lonely, hookInput("Bash", "npm test"))).toEqual({ status: 0, stdout: "" });
    expect(existsSync(statePath())).toBe(false);

    git(workDir(), ["remote", "set-url", "origin", join(tmp, "missing.git")]);
    writeWork(workDir(), "src/a.ts", "a\n");
    expect(runHook(workDir(), hookInput("Bash", "npm test"))).toEqual({ status: 0, stdout: "" });
    expect(existsSync(statePath())).toBe(false);
    expect(remoteLog()).toEqual(["first"]);
  }, SLOW);
});

describe("autopush helpers", () => {
  it("isTestRun spots test runs, also in chains", () => {
    for (const command of ["npm test", "npm run test", "npm t", "node --test", "npx vitest run", "vitest", "cd x && npm test", "npm test | tail", "ls; npm t"]) {
      expect(isTestRun(command)).toBe(true);
    }
    for (const command of ["npm run testing", "git status", "ls", "npm run build", "echo npm test"]) {
      expect(isTestRun(command)).toBe(false);
    }
  });

  it("P4: the commit message names the agent and the changed files and is at most 120 characters", () => {
    expect(commitMessage("careful", ["src/a.ts", "src/b.ts"])).toBe("Thunderdome careful: work in progress (src/a.ts, src/b.ts)");
    expect(commitMessage("careful", [])).toBe("Thunderdome careful: work in progress");
    const files = Array.from({ length: 30 }, (_, i) => `src/some/deeply/nested/folder/file-${i}.ts`);
    const long = commitMessage("careful", files);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("Thunderdome careful: work in progress (")).toBe(true);
  });

  it("agentFromAuthor reads the agent from the author name", () => {
    expect(agentFromAuthor("Thunderdome careful")).toBe("careful");
    expect(agentFromAuthor("Thunderdome")).toBe("agent");
    expect(agentFromAuthor("someone else")).toBe("agent");
    expect(agentFromAuthor(undefined)).toBe("agent");
  });
});
