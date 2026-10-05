// How one agent runs in one sandbox: its command line, its time limit, and what it reports.
import { thunderdomeApiBase, MODEL_API_HOST } from "../sandbox/policy";
import { systemPrompt, type AgentName } from "./prompt";

export const AGENT_TIME_LIMIT_MS = 8 * 60 * 1_000;
// Each check is a request to the container, which keeps it awake, and flushes new steps.
export const POLL_INTERVAL_MS = 10 * 1_000;
export { MODEL_API_HOST };
// Claude Code needs a key to start. The Outbound Worker replaces it with the real key.
export const PLACEHOLDER_API_KEY = "provided-by-worker";

// The hook that commits and pushes the agent's work as it goes (image/autopush.mjs).
export const AUTOPUSH_HOOK_PATH = "/usr/local/bin/autopush";
// Outside the repo, so it stays out of the diff (same dir as ThunderdomeSandbox's RUN_DIR).
export const AUTOPUSH_STATE_PATH = "/workspace/run/autopush.json";

export interface HookSettings {
  hooks: { PostToolUse: { matcher: string; hooks: { type: "command"; command: string }[] }[] };
}

// Claude Code settings that run the autopush hook after tool calls that can change files.
export function autopushSettings(): HookSettings {
  return {
    hooks: {
      PostToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit", hooks: [{ type: "command", command: AUTOPUSH_HOOK_PATH }] }],
    },
  };
}

// Everything a sandbox needs to run one agent on one fork.
export interface AgentSpec {
  taskId: string;
  agent: AgentName;
  fork: string;
  remote: string;
  token: string;
  defaultBranch: string;
  prompt: string;
  deadline: number;
  // Empty means Claude Code picks its default model.
  model: string;
}

export type AgentEnd = "done" | "failed" | "timeout";

export interface AgentOutcome {
  end: AgentEnd;
  // The fork head after the run, and whether the run added commits to it.
  commit?: string;
  pushed: boolean;
  summary?: string;
  error?: string;
  costUsd?: number;
  turns?: number;
}

export function agentCommand(spec: AgentSpec): { argv: string[]; env: Record<string, string> } {
  const minutes = Math.max(1, Math.round((spec.deadline - Date.now()) / 60_000));
  const model = spec.model === "" ? [] : ["--model", spec.model];
  return {
    argv: [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      ...model,
      "--append-system-prompt",
      systemPrompt(spec.agent, minutes),
      "--settings",
      JSON.stringify(autopushSettings()),
      "--",
      spec.prompt,
    ],
    env: {
      ...gitIdentity(spec.agent),
      // The claim CLI calls the Thunderdome API here.
      THUNDERDOME_API: thunderdomeApiBase(new URL(spec.remote).hostname),
      ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // The container runs as root, where skipping permissions needs this.
      IS_SANDBOX: "1",
      // The autopush hook keeps its last push time here.
      AUTOPUSH_STATE: AUTOPUSH_STATE_PATH,
    },
  };
}

// Commits made in a fork name the agent that made them.
export function gitIdentity(agent: AgentName): Record<string, string> {
  const name = `Thunderdome ${agent}`;
  const email = `${agent}@thunderdome.local`;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}
