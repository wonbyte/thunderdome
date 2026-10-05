import { describe, expect, it } from "vitest";

import { clip, resultOf, splitLines, stepsOf } from "../src/agents/events";
import { AGENT_NAMES, AGENT_STYLES, isAgentName, systemPrompt } from "../src/agents/prompt";
import {
  agentCommand,
  AUTOPUSH_HOOK_PATH,
  AUTOPUSH_STATE_PATH,
  autopushSettings,
  gitIdentity,
  PLACEHOLDER_API_KEY,
  type AgentSpec,
  type HookSettings,
} from "../src/agents/runner";

const encode = (text: string) => new TextEncoder().encode(text);

describe("splitLines", () => {
  it("returns complete lines and leaves a partial line unread", () => {
    expect(splitLines(encode('{"a":1}\n{"b":2}\n{"c"'))).toEqual({ lines: ['{"a":1}', '{"b":2}'], consumed: 16 });
  });

  it("reads nothing without a newline", () => {
    expect(splitLines(encode('{"a"'))).toEqual({ lines: [], consumed: 0 });
  });

  it("counts bytes, not characters", () => {
    const { lines, consumed } = splitLines(encode("é\n"));
    expect(lines).toEqual(["é"]);
    expect(consumed).toBe(3);
  });
});

describe("clip", () => {
  it("flattens whitespace and cuts long text", () => {
    expect(clip("a\n  b")).toBe("a b");
    expect(clip("x".repeat(10), 5)).toBe("xxxx…");
  });
});

describe("stepsOf", () => {
  it("reads init, text, and tool calls", () => {
    expect(stepsOf({ type: "system", subtype: "init", model: "m" })).toEqual([{ kind: "init", text: "started (m)" }]);
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me run the tests." },
          { type: "tool_use", name: "Bash", input: { command: "npm test", description: "run tests" } },
          { type: "tool_use", name: "Edit", input: { file_path: "src/text.ts", old_string: "a" } },
          { type: "tool_use", name: "TodoWrite", input: { todos: [] } },
        ],
      },
    };
    expect(stepsOf(event)).toEqual([
      { kind: "text", text: "Let me run the tests." },
      { kind: "tool", text: "Bash npm test" },
      { kind: "tool", text: "Edit src/text.ts" },
      { kind: "tool", text: 'TodoWrite {"todos":[]}' },
    ]);
  });

  it("reads the result with its cost", () => {
    expect(stepsOf({ type: "result", subtype: "success", is_error: false, result: "Fixed.", total_cost_usd: 0.5 })).toEqual([
      { kind: "result", text: "Fixed. [$0.5000]" },
    ]);
  });

  it("ignores other events", () => {
    expect(stepsOf({ type: "user", message: { content: [] } })).toEqual([]);
    expect(stepsOf(undefined)).toEqual([]);
    expect(stepsOf("x")).toEqual([]);
  });
});

describe("resultOf", () => {
  it("reads is_error, not subtype", () => {
    expect(resultOf({ type: "result", subtype: "success", is_error: true, result: "API Error: 401" })).toEqual({
      isError: true,
      text: "API Error: 401",
      costUsd: undefined,
      turns: undefined,
    });
    expect(resultOf({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9 })).toMatchObject({ text: "error_max_turns", turns: 9 });
    expect(resultOf({ type: "assistant" })).toBeUndefined();
  });
});

describe("prompts", () => {
  it("has a style for every agent", () => {
    for (const name of AGENT_NAMES) expect(AGENT_STYLES[name]).toBeTruthy();
    expect(new Set(Object.values(AGENT_STYLES)).size).toBe(AGENT_NAMES.length);
    expect(isAgentName("careful")).toBe(true);
    expect(isAgentName("bold")).toBe(false);
  });

  it("puts the style, the time limit, and the commit rule in the system prompt", () => {
    const prompt = systemPrompt("tester", 8);
    expect(prompt).toContain(AGENT_STYLES.tester);
    expect(prompt).toContain("8 minutes");
    expect(prompt).toContain("commit your work");
    expect(prompt).toContain("Claim first");
    expect(prompt).toContain("lowers your score");
  });

  it("R8: the agent prompt tells agents to commit and push after each working step", () => {
    for (const name of AGENT_NAMES) {
      const prompt = systemPrompt(name, 8);
      expect(prompt).toContain("after each working step");
      expect(prompt).toContain("git push origin HEAD:refs/heads/main");
      expect(prompt).toContain("live preview");
      // The runner still pushes what is left, so the old rule stays true.
      expect(prompt).toContain("commit your work");
      expect(prompt).toContain("the runner also commits and pushes whatever is left at the end");
    }
  });
});

describe("agentCommand", () => {
  const spec: AgentSpec = {
    taskId: "t-0123abcd",
    agent: "fast",
    fork: "t-0123abcd-fast",
    remote: "https://git.test/thunderdome/t-0123abcd-fast.git",
    token: "secret-token",
    defaultBranch: "main",
    prompt: "Fix the tests",
    deadline: Date.now() + 8 * 60_000,
    model: "",
  };

  it("runs Claude Code headless with the task prompt last", () => {
    const { argv, env } = agentCommand(spec);
    expect(argv.slice(0, 2)).toEqual(["claude", "--print"]);
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--model");
    expect(argv.slice(-2)).toEqual(["--", "Fix the tests"]);
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("8 minutes");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("git push origin HEAD:refs/heads/main");
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY,
      IS_SANDBOX: "1",
      GIT_AUTHOR_NAME: "Thunderdome fast",
      THUNDERDOME_API: "https://git.test/_thunderdome",
    });
  });

  it("never puts the fork token in the command or its env", () => {
    const { argv, env } = agentCommand(spec);
    expect(JSON.stringify({ argv, env })).not.toContain("secret-token");
  });

  it("passes a model when one is set", () => {
    const { argv } = agentCommand({ ...spec, model: "some-model" });
    expect(argv[argv.indexOf("--model") + 1]).toBe("some-model");
  });

  it("names the agent in git commits", () => {
    expect(gitIdentity("careful")).toEqual({
      GIT_AUTHOR_NAME: "Thunderdome careful",
      GIT_AUTHOR_EMAIL: "careful@thunderdome.local",
      GIT_COMMITTER_NAME: "Thunderdome careful",
      GIT_COMMITTER_EMAIL: "careful@thunderdome.local",
    });
  });

  it("P6: the agent command installs the autopush hook with --settings, and the prompt tells agents the runner pushes their work as they go", () => {
    const { argv, env } = agentCommand(spec);
    const at = argv.indexOf("--settings");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(argv.indexOf("--"));
    const settings = JSON.parse(argv[at + 1] ?? "") as HookSettings;
    expect(settings).toEqual(autopushSettings());
    const entry = settings.hooks.PostToolUse[0];
    expect(entry?.matcher).toContain("Bash");
    expect(entry?.matcher).toContain("Edit");
    expect(entry?.hooks[0]?.command).toBe(AUTOPUSH_HOOK_PATH);
    expect(env.AUTOPUSH_STATE).toBe(AUTOPUSH_STATE_PATH);
    for (const name of AGENT_NAMES) {
      expect(systemPrompt(name, 8)).toContain("commits and pushes your work after each test run and as you edit");
    }
  });
});
