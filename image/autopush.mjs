#!/usr/bin/env node
// autopush: a Claude Code PostToolUse hook that commits and pushes the agent's work as it goes.
// Installed in the sandbox image as /usr/local/bin/autopush.
//
// Reads the hook JSON from stdin and works in the current directory. After a test run it always
// pushes; after any other tool at most every AUTOPUSH_MIN_INTERVAL_S seconds (default 20).
// It always exits 0 and never writes to stdout; diagnostics go to stderr.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STATE = "/workspace/run/autopush.json";
const DEFAULT_INTERVAL_S = 20;
const MAX_MESSAGE = 120;
const TEST_RUN = /^(npm (test|t|run test)\b|node --test\b|(npx )?vitest\b)/;

// True if any segment of a shell command runs the tests.
export function isTestRun(command) {
  if (typeof command !== "string") return false;
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .some((segment) => TEST_RUN.test(segment));
}

// A test run always may push; anything else only once the interval has passed.
export function shouldPush({ toolName, command, now, lastPushAt, minIntervalS }) {
  if (toolName === "Bash" && isTestRun(command)) return true;
  if (lastPushAt === undefined) return true;
  return now - lastPushAt >= minIntervalS * 1000;
}

// The commit message, clipped to MAX_MESSAGE characters.
export function commitMessage(agent, files) {
  const base = `Thunderdome ${agent}: work in progress`;
  const message = files.length === 0 ? base : `${base} (${files.join(", ")})`;
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
}

// "Thunderdome careful" -> "careful"; anything else -> "agent".
export function agentFromAuthor(authorName) {
  const match = typeof authorName === "string" ? /^Thunderdome (\S+)$/.exec(authorName) : null;
  return match?.[1] ?? "agent";
}

function git(args, timeoutMs = 10_000) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function readLastPushAt(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))?.lastPushAt;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function minInterval() {
  const raw = process.env.AUTOPUSH_MIN_INTERVAL_S;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_INTERVAL_S;
}

function run() {
  let hook;
  try {
    hook = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const toolName = typeof hook?.tool_name === "string" ? hook.tool_name : "";
  const command = typeof hook?.tool_input?.command === "string" ? hook.tool_input.command : undefined;
  const statePath = process.env.AUTOPUSH_STATE || DEFAULT_STATE;
  const lastPushAt = readLastPushAt(statePath);
  if (!shouldPush({ toolName, command, now: Date.now(), lastPushAt, minIntervalS: minInterval() })) return;

  if (!git(["add", "--all"]).ok) return;
  const staged = git(["diff", "--cached", "--name-only"]);
  if (!staged.ok) return;
  const files = staged.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (files.length > 0) {
    const message = commitMessage(agentFromAuthor(process.env.GIT_AUTHOR_NAME), files);
    if (!git(["commit", "--quiet", "--message", message]).ok) return;
  }

  const head = git(["rev-parse", "HEAD"]);
  if (!head.ok) return;
  const remote = git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
  if (remote.ok && remote.stdout.trim() === head.stdout.trim()) return;

  if (!git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], 20_000).ok) {
    console.error("autopush: push failed");
    return;
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ lastPushAt: Date.now() }));
}

function main() {
  try {
    run();
  } catch (cause) {
    console.error(`autopush: ${cause?.message ?? cause}`);
  }
  process.exit(0);
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
