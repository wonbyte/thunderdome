// Fakes for judge tests: forks, input and injected deps.
import { vi } from "vitest";

import type { ForkDiff, JudgeDeps, JudgeFork, JudgeInput, TestRun } from "../src/judge/judge";
import { fakeScorer } from "../src/judge/scorer";

export const TASK_ID = "t-0123abcd";
export const DEFAULT_AGENTS = ["ponder", "zippy", "snip"];

// Default test results per agent; other agents pass 5/10.
const TESTS: Record<string, TestRun> = {
  ponder: { passed: 10, total: 10 },
  zippy: { passed: 7, total: 10 },
  snip: { passed: 4, total: 10 },
};

export function fakeFork(agent: string, overrides: Partial<JudgeFork> = {}): JudgeFork {
  const fork = `${TASK_ID}-${agent}`;
  return {
    agent,
    fork,
    remote: `https://git.test/thunderdome/${fork}.git`,
    defaultBranch: "main",
    filesClaimed: [`src/${agent}.ts`],
    ...overrides,
  };
}

export function fakeInput(agents: string[] = DEFAULT_AGENTS): JudgeInput {
  return { taskId: TASK_ID, repo: "thunderdome-sample", task: "Add a /health route", forks: agents.map((a) => fakeFork(a)) };
}

// One claimed file changed, with a diff text that names the agent.
export function fakeDiff(agent: string): ForkDiff {
  return { diff: `+// change by ${agent}\n`, filesChanged: [`src/${agent}.ts`], linesAdded: 2, linesRemoved: 1 };
}

export function fakeDeps(overrides: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    runTests: vi.fn(async (fork: JudgeFork) => TESTS[fork.agent] ?? { passed: 5, total: 10 }),
    getDiff: vi.fn(async (fork: JudgeFork) => fakeDiff(fork.agent)),
    scorer: fakeScorer(),
    sleep: vi.fn(async (_ms: number) => {}),
    ...overrides,
  };
}
