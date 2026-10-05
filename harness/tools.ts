// File tools Opus may call, and the checks code runs. Opus cannot run arbitrary commands.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ToolResult } from "./llm.ts";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MAX_READ = 60_000;
const MAX_OUTPUT = 12_000;

// Never readable, never writable: secrets, git internals, dependencies.
const DENY = [/^\.env/, /^\.dev\.vars/, /^\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /^harness\/.*\.log$/];

export function safePath(path: unknown): string | null {
  if (typeof path !== "string" || path === "" || path.startsWith("/")) return null;
  const clean = normalize(path).replace(/\/$/, "");
  if (clean.startsWith("..") || DENY.some((re) => re.test(clean))) return null;
  return clean;
}

export function sh(cmd: string, args: string[], signal: AbortSignal, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, signal, timeout: timeoutMs, env: { ...process.env, FORCE_COLOR: "0" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: -1, out: out + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

export function tail(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : `…(cut)…\n${text.slice(-max)}`;
}

export interface CheckResult {
  ok: boolean;
  output: string; // what failed, for Opus and for the fork questions
  missing: string[]; // required test ids that did not pass
}

interface VitestJson {
  testResults: { name: string; status: string; message?: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
}

// Typecheck the whole repo, then run the given test files. Required ids must pass as `<id>: ...` titles.
export async function runCheck(testFiles: string[], required: string[], signal: AbortSignal): Promise<CheckResult> {
  const sample = await sh("npm", ["run", "build:sample"], signal);
  if (sample.code !== 0) return { ok: false, output: tail(sample.out), missing: required };
  for (const project of [[], ["-p", "test"]]) {
    const tsc = await sh("npx", ["tsc", "--noEmit", ...project], signal);
    if (tsc.code !== 0) return { ok: false, output: `Typecheck failed:\n${tail(tsc.out)}`, missing: required };
  }
  const present = testFiles.filter((f) => existsSync(join(ROOT, f)));
  if (testFiles.length > 0 && present.length === 0) {
    return { ok: false, output: `No test file exists yet: ${testFiles.join(", ")}`, missing: required };
  }
  const report = join(ROOT, "harness/.vitest.json");
  const vitest = await sh("npx", ["vitest", "run", ...present, "--reporter=json", `--outputFile=${report}`], signal);
  let json: VitestJson;
  try {
    json = JSON.parse(readFileSync(report, "utf8")) as VitestJson;
  } catch {
    return { ok: false, output: `vitest gave no report:\n${tail(vitest.out)}`, missing: required };
  }
  const failures: string[] = [];
  const passed = new Set<string>();
  for (const file of json.testResults) {
    const rel = file.name.replace(`${ROOT}/`, "");
    if (file.assertionResults.length === 0 && file.status === "failed") failures.push(`${rel}: ${file.message ?? "suite failed to load"}`);
    for (const t of file.assertionResults) {
      if (t.status === "passed") passed.add(t.title);
      else failures.push(`${rel} > ${t.title}: ${t.status}\n${t.failureMessages.join("\n")}`);
    }
  }
  const missing = required.filter((id) => ![...passed].some((title) => title.startsWith(`${id}:`)));
  const ok = vitest.code === 0 && failures.length === 0 && missing.length === 0;
  const lines = [...failures];
  if (missing.length > 0) lines.push(`Required tests missing or not passing (title must start with "<id>:"): ${missing.join(", ")}`);
  return { ok, output: tail(lines.join("\n\n")), missing };
}

const str = { type: "string" as const };

export function toolDefs(writable: string[], extra: BetaToolUnion[] = []): BetaToolUnion[] {
  const tools: BetaToolUnion[] = [
    {
      name: "read_file",
      description: "Read a repo file (path relative to the repo root). Secrets and node_modules cannot be read.",
      input_schema: { type: "object", properties: { path: str }, required: ["path"] },
      eager_input_streaming: true,
    },
    {
      name: "list_dir",
      description: "List a repo directory (path relative to the repo root; '.' for the root).",
      input_schema: { type: "object", properties: { path: str }, required: ["path"] },
      eager_input_streaming: true,
    },
  ];
  if (writable.length > 0) {
    tools.push(
      {
        name: "write_file",
        description: `Write a whole file. Only these paths are allowed: ${writable.join(", ")}`,
        input_schema: { type: "object", properties: { path: str, content: str }, required: ["path", "content"] },
        eager_input_streaming: true,
      },
      {
        name: "run_check",
        description: "Run this step's check: build the sample, typecheck the repo, run this step's tests. Returns what failed.",
        input_schema: { type: "object", properties: {} },
        eager_input_streaming: true,
      },
    );
  }
  return [...tools, ...extra];
}

// Executes a tool call. Inputs are validated here because eager streaming skips API validation.
export function toolRunner(writable: string[], check: () => Promise<CheckResult>, onWrite: (path: string) => void) {
  return async (name: string, input: unknown): Promise<ToolResult> => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (name === "read_file") {
      const path = safePath(args.path);
      if (!path || !existsSync(join(ROOT, path)) || !statSync(join(ROOT, path)).isFile()) {
        return { content: `Cannot read ${String(args.path)}`, is_error: true };
      }
      return { content: tail(readFileSync(join(ROOT, path), "utf8"), MAX_READ) };
    }
    if (name === "list_dir") {
      const path = args.path === "." ? "." : safePath(args.path);
      if (!path || !existsSync(join(ROOT, path)) || !statSync(join(ROOT, path)).isDirectory()) {
        return { content: `Cannot list ${String(args.path)}`, is_error: true };
      }
      const entries = readdirSync(join(ROOT, path), { withFileTypes: true })
        .filter((e) => safePath(path === "." ? e.name : `${path}/${e.name}`) !== null)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { content: entries.join("\n") };
    }
    if (name === "write_file") {
      const path = safePath(args.path);
      if (!path || !writable.includes(path)) return { content: `Not allowed to write ${String(args.path)}. Allowed: ${writable.join(", ")}`, is_error: true };
      if (typeof args.content !== "string") return { content: "content must be a string", is_error: true };
      mkdirSync(dirname(join(ROOT, path)), { recursive: true });
      writeFileSync(join(ROOT, path), args.content);
      onWrite(path);
      return { content: `Wrote ${path} (${args.content.length} chars)` };
    }
    if (name === "run_check") {
      const result = await check();
      return { content: result.ok ? "Check passed." : `Check failed:\n${result.output}` };
    }
    return { content: `Unknown tool ${name}`, is_error: true };
  };
}
