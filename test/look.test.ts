import { describe, expect, it } from "vitest";

import { applyLook, type JudgedFork } from "../src/judge/judge";
import {
  combineLook,
  DESKTOP,
  judgeLook,
  LOOK_QUESTIONS,
  lookRequest,
  PHONE,
  readyPreviews,
  VISUAL_THRESHOLD,
  type LookDeps,
  type LookResult,
  type Viewport,
} from "../src/judge/look";
import { LOOK_WEIGHTS, scoreForks, WEIGHTS, type ForkInput } from "../src/judge/score";
import { buildWhy, headline, scoresTable } from "../src/judge/why";
import type { Task } from "../src/room/task";

const noSleep = async (): Promise<void> => {};

// Fake Clef: the visual yes, and look scores (0..4 levels) per screenshot of a fork's page.
function fakeDeps(opts: { visual?: number; levels?: Record<string, [number, number]>; broken?: string[]; aiFails?: boolean } = {}) {
  const shots: { url: string; viewport: Viewport }[] = [];
  const bodies: Record<string, unknown>[] = [];
  const deps: LookDeps = {
    sleep: noSleep,
    async shoot(url, viewport) {
      shots.push({ url, viewport });
      if (opts.broken?.some((b) => url.includes(b))) throw new Error("answered 500");
      return `jpeg:${url}:${viewport.width}`;
    },
    ai: {
      async run(_model, input) {
        const body = input as Record<string, unknown>;
        bodies.push(body);
        if (opts.aiFails === true) throw new Error("AI down");
        const questions = body.questions as Record<string, unknown>;
        if ("visual" in questions) return { result: { answers: { visual: { type: "noul", noul: opts.visual ?? 0.9 } } } };
        const images = body.images as { base64: string }[];
        const page = images.at(-1)?.base64 ?? "";
        const [fit, quality] = Object.entries(opts.levels ?? {}).find(([agent]) => page.includes(agent))?.[1] ?? [2, 2];
        return { answers: { look_fit: { type: "score", score: fit, confidence: 0.5 }, look_quality: { type: "score", score: quality, confidence: 0.5 } } };
      },
    },
  };
  return { deps, shots, bodies };
}

const input = {
  task: "Make the shop page a dark grid",
  before: "https://base.test",
  forks: [
    { agent: "ponder", preview: "https://ponder.test" },
    { agent: "zippy", preview: "https://zippy.test" },
    { agent: "testy" },
  ],
};

describe("judgeLook", () => {
  it("skips screenshots when the task is not visual", async () => {
    const { deps, shots } = fakeDeps({ visual: VISUAL_THRESHOLD - 0.01 });
    expect(await judgeLook(deps, input)).toEqual({ visual: 0.49, judged: false, forks: [] });
    expect(shots).toEqual([]);
  });

  it("screenshots the before page once and each fork at desktop and phone width, then scores each fork", async () => {
    const { deps, shots, bodies } = fakeDeps({ levels: { ponder: [4, 3], zippy: [2, 4] } });
    const result = await judgeLook(deps, input);
    // The before page first, then the forks at once.
    expect(shots[0]).toEqual({ url: "https://base.test", viewport: DESKTOP });
    expect(shots.slice(1)).toEqual(expect.arrayContaining([
      { url: "https://ponder.test", viewport: DESKTOP },
      { url: "https://ponder.test", viewport: PHONE },
      { url: "https://zippy.test", viewport: DESKTOP },
      { url: "https://zippy.test", viewport: PHONE },
    ]));
    expect(shots).toHaveLength(5);
    expect(result.judged).toBe(true);
    expect(result.forks).toEqual([
      { agent: "ponder", look: combineLook(1, 0.75), fit: 1, quality: 0.75 },
      { agent: "zippy", look: combineLook(0.5, 1), fit: 0.5, quality: 1 },
      { agent: "testy", look: 0, error: "no preview of its final commit" },
    ]);
    // The look request carries before, desktop and phone, and says which is which.
    const ponder = bodies.find((b) => (b.images as { base64: string }[] | undefined)?.some((i) => i.base64.includes("ponder")))!;
    expect((ponder.images as { base64: string }[]).map((i) => i.base64)).toEqual([
      "jpeg:https://base.test:1280",
      "jpeg:https://ponder.test:1280",
      "jpeg:https://ponder.test:390",
    ]);
    expect((ponder.state as { screenshots: string[] }).screenshots[0]).toBe("Image 1 is the page before the change, at desktop width.");
    expect(ponder.questions).toBe(LOOK_QUESTIONS);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("gives a fork whose page does not load 0 look points, and still judges the others", async () => {
    const { deps } = fakeDeps({ broken: ["zippy"] });
    const result = await judgeLook(deps, input);
    expect(result.judged).toBe(true);
    expect(result.forks[1]).toMatchObject({ agent: "zippy", look: 0 });
    expect(result.forks[1]?.error).toContain("the preview did not load");
  });

  it("judges without a before screenshot when the before page fails, and says why", async () => {
    const { deps, bodies } = fakeDeps({ broken: ["base"] });
    const result = await judgeLook(deps, input);
    expect(result.judged).toBe(true);
    expect(result.before).toContain("the before preview did not load");
    expect((bodies[1]!.images as unknown[]).length).toBe(2);
    expect(lookRequest("t", undefined, "d", "p")).toMatchObject({ state: { screenshots: ["Image 1 is the page after the change, at desktop width.", "Image 2 is the page after the change, at phone width."] } });
  });

  it("does not judge on look when no fork could be judged", async () => {
    const result = await judgeLook(fakeDeps({ broken: ["ponder", "zippy"] }).deps, input);
    expect(result.judged).toBe(false);
    expect(result.forks.every((f) => f.look === 0)).toBe(true);
  });

  it("judges without look when time runs out, instead of giving the forks 0", async () => {
    const { deps } = fakeDeps();
    let clock = 0;
    const slow: LookDeps = { ...deps, now: () => clock, deadline: 50, shoot: async (url, vp) => { clock += 60; return deps.shoot(url, vp); } };
    const result = await judgeLook(slow, input);
    expect(result.judged).toBe(false);
    expect(result.error).toBe("out of time before judging 3 forks");
    expect(result.forks).toEqual([]);
  });

  it("uses a visual answer it is given instead of asking again", async () => {
    const { deps, bodies } = fakeDeps();
    expect(await judgeLook(deps, { ...input, visual: 0.2 })).toEqual({ visual: 0.2, judged: false, forks: [] });
    expect(bodies).toEqual([]);
    const judged = await judgeLook(deps, { ...input, visual: 0.8 });
    expect(judged.judged).toBe(true);
    expect(bodies.some((b) => "visual" in (b.questions as object))).toBe(false);
  });

  it("throws when the visual question fails", async () => {
    await expect(judgeLook(fakeDeps({ aiFails: true }).deps, input)).rejects.toThrow("AI down");
  });
});

describe("readyPreviews", () => {
  const task = {
    baseCommit: "b0",
    basePreview: { url: "https://base.test", commit: "b0", at: "x" },
    agents: [
      { name: "ponder", push: { head: "c2", preview: { url: "https://ponder.test", commit: "c2", at: "x" } } },
      { name: "zippy", push: { head: "f2", preview: { url: "https://zippy.test", commit: "f1", at: "x" } } },
      { name: "testy" },
    ],
  } as unknown as Task;

  it("uses only previews built from each fork's final commit, and names the forks still waiting", () => {
    expect(readyPreviews(task)).toEqual({
      before: "https://base.test",
      forks: [{ agent: "ponder", preview: "https://ponder.test" }, { agent: "zippy" }, { agent: "testy" }],
      waiting: ["zippy"],
    });
    const stale = { ...task, basePreview: { url: "https://old.test", commit: "zz", at: "x" } } as Task;
    expect(readyPreviews(stale).before).toBeUndefined();
  });
});

function fork(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    agent: "a",
    testsPassed: 10,
    testsTotal: 10,
    taskFit: 1,
    clarity: 1,
    linesChanged: 10,
    filesChanged: ["src/a.ts"],
    filesClaimed: ["src/a.ts"],
    ...overrides,
  };
}

describe("scoring with look", () => {
  it("uses the look weights when any fork has a look, and a missing look scores 0", () => {
    const result = scoreForks([fork({ agent: "pretty", look: 1 }), fork({ agent: "plain", look: 0.2 }), fork({ agent: "none" })]);
    expect(result.weights).toEqual(LOOK_WEIGHTS);
    expect(result.ranked.map((s) => [s.agent, s.parts.look, s.total])).toEqual([
      ["pretty", 15, 100],
      ["plain", 3, 88],
      ["none", 0, 85],
    ]);
    expect(scoreForks([fork()]).weights).toEqual(WEIGHTS);
    expect(scoreForks([fork()]).ranked[0]?.parts.look).toBeUndefined();
  });

  it("breaks a close race on code by the look, and the why shows a look column and reason", () => {
    const result = scoreForks([
      fork({ agent: "plain", look: 0.4, taskFit: 1 }),
      fork({ agent: "pretty", look: 0.9, taskFit: 0.97, filesChanged: ["src/b.ts"], filesClaimed: ["src/b.ts"] }),
    ]);
    expect(result.winner).toBe("pretty");
    expect(headline(result)).toBe("Decided by code: pretty's fix scored 6.9 more points on tests, task fit, clarity and look than plain's.");
    expect(scoresTable(result.ranked).split("\n")[0]).toBe("agent   tests       task fit  clarity  look  claim  total");
    expect(buildWhy(result)).toContain("- Look: 13.5 points vs 6 for the best other fork.");
  });

  it("names a broken preview where the loser lost on look", () => {
    const result = scoreForks([fork({ agent: "w", look: 0.8 }), fork({ agent: "l", look: 0, lookError: "the preview did not load: answered 500" })]);
    expect(buildWhy(result)).toContain("- l (85/100): lost most on look (0 vs 12): the preview did not load: answered 500.");
  });
});

describe("applyLook", () => {
  const judged = (agent: string): JudgedFork => ({
    agent,
    fork: `t-${agent}`,
    tests: { passed: 1, total: 1 },
    diff: { filesChanged: ["a"], linesAdded: 1, linesRemoved: 0 },
    input: fork({ agent }),
  });

  it("sets look on every fork when judged, 0 with a reason for a fork missing from the result", () => {
    const look: LookResult = { visual: 0.9, judged: true, forks: [{ agent: "a", look: 0.7, fit: 0.75, quality: 0.625 }] };
    const [a, b] = applyLook([judged("a"), judged("b")], look);
    expect(a?.input.look).toBe(0.7);
    expect(a?.look).toEqual(look.forks[0]);
    expect(b?.input).toMatchObject({ look: 0, lookError: "not judged" });
  });

  it("changes nothing when the race is not judged on look", () => {
    const forks = [judged("a")];
    expect(applyLook(forks, { visual: 0.1, judged: false, forks: [] })).toBe(forks);
  });
});
