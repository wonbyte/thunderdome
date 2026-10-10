import { describe, expect, it } from "vitest";

import type { WireClaimBoard, WireStep, WireTask } from "../src/ui/board";
import { applyPlatform, emptyPlatform, formatMs, type PlatformHit } from "../src/ui/platform";
import { boardAt, buildTimeline, recordAt, stepsAt } from "../src/ui/timeline";

const id = "t-0123abcd";
const T0 = Date.parse("2026-10-05T05:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

// A finished race: ponder claims first, zippy clashes on a.ts and releases it, ponder wins.
function recordedTask(): WireTask {
  return {
    id,
    prompt: "Fix the cart",
    status: "finished",
    createdAt: iso(0),
    startedAt: iso(5),
    finishedAt: iso(60),
    basePreview: { url: "https://base.example", commit: "b0", at: iso(15) },
    agents: [
      { name: "ponder", status: "done", startedAt: iso(5), endedAt: iso(60), push: { commits: 2, pushes: 2, lastPushAt: iso(50), seen: ["c1", "c2"], preview: { url: "https://ponder.example", commit: "c2", at: iso(56) } } },
      { name: "zippy", status: "done", startedAt: iso(5), endedAt: iso(40), push: { commits: 1, pushes: 1, lastPushAt: iso(35), seen: ["f1"], preview: { url: "https://zippy.example", commit: "f1", at: iso(39) } } },
    ],
    verdict: { winner: "ponder", why: "Best fix.", judgedAt: iso(75), ship: { status: "merged", commit: "abcdef1234567" } },
  };
}

const steps: WireStep[] = [
  { seq: 1, agent: "ponder", at: iso(10), kind: "init", text: "started" },
  { seq: 2, agent: "zippy", at: iso(12), kind: "init", text: "started" },
  { seq: 3, agent: "ponder", at: iso(20), kind: "tool", text: "Edit src/a.ts" },
  { seq: 4, agent: "zippy", at: iso(22), kind: "claim", text: "shared claim src/a.ts; clash: src/a.ts (also held by ponder)" },
  { seq: 5, agent: "zippy", at: iso(30), kind: "claim", text: "released src/a.ts" },
];

const claims: WireClaimBoard = {
  active: [],
  history: [
    { agent: "ponder", file: "src/a.ts", shared: false, at: iso(18) },
    { agent: "ponder", file: "src/b.ts", shared: false, at: iso(18) },
    { agent: "zippy", file: "src/a.ts", shared: true, at: iso(22) },
  ],
};

describe("U12 replay: a recorded race becomes a timeline", () => {
  it("U12 orders the events and estimates only earlier pushes", () => {
    const timeline = buildTimeline(recordedTask(), steps, claims);
    expect(timeline.start).toBe(T0);
    expect(timeline.end).toBe(T0 + 75_000);
    const kinds = timeline.events.map((e) => e.event.kind);
    expect(kinds[0]).toBe("snapshot");
    expect(kinds[1]).toBe("status");
    expect(kinds.at(-1)).toBe("verdict");
    expect(timeline.events.map((e) => e.at)).toEqual(timeline.events.map((e) => e.at).toSorted((a, b) => a - b));
    const pushes = timeline.events.filter((e) => e.event.kind === "push");
    expect(pushes).toHaveLength(3);
    expect(pushes.filter((e) => e.approx)).toHaveLength(1);
    const ends = timeline.events.filter((e) => e.event.kind === "agent-end").map((e) => (e.event.kind === "agent-end" ? e.event.status : ""));
    expect(ends).toEqual(["running", "finished"]);
    expect(kinds).toContain("release");
  });

  it("U12 rebuilds the board at any moment, with clashes and releases", () => {
    const timeline = buildTimeline(recordedTask(), steps, claims);
    const atStart = boardAt(timeline, T0);
    expect(atStart.task?.status).toBe("ready");
    expect(atStart.fighters.map((f) => f.action)).toEqual(["idle", "idle"]);
    const clash = boardAt(timeline, T0 + 23_000);
    expect(clash.claimed.clashes).toEqual(["src/a.ts"]);
    expect(clash.fighters.find((f) => f.agent === "zippy")?.clashFile).toBe("src/a.ts");
    const released = boardAt(timeline, T0 + 31_000);
    expect(released.grid.cells["src/a.ts"]).toEqual({ ponder: "own" });
    const end = boardAt(timeline, timeline.end);
    expect(end).toMatchObject({ ended: true, winner: "ponder" });
    expect(end.task?.verdict?.ship?.commit).toBe("abcdef1234567");
    expect(stepsAt(steps, T0 + 21_000).map((s) => s.seq)).toEqual([1, 2, 3]);
  });
});

describe("U13 platform: each event names the Cloudflare product and its latency", () => {
  it("U13 maps a race's events to stages with real timings", () => {
    const timeline = buildTimeline(recordedTask(), steps, claims);
    let state = emptyPlatform();
    const hits: PlatformHit[] = [];
    for (const { at, event } of timeline.events) {
      const out = applyPlatform(state, event, at);
      state = out.state;
      hits.push(...out.hits);
    }
    const find = (text: string) => hits.find((h) => h.text === text);
    expect(find("forked the repo 2 times")).toEqual({ stage: "fork", text: "forked the repo 2 times" });
    expect(find("Ponder's sandbox is up")).toMatchObject({ stage: "containers", ms: 5000 });
    expect(find("Ponder claimed 2 files")?.stage).toBe("claims");
    expect(find("Zippy's preview is live")).toMatchObject({ stage: "previews", ms: 4000 });
    expect(find("Ponder's preview is live")).toMatchObject({ stage: "previews", ms: 6000 });
    expect(find(`the "before" preview is live`)).toMatchObject({ ms: 10_000 });
    expect(find("judge started: tests in every fork")?.stage).toBe("workflows");
    expect(find("Clef scored 2 diffs")).toMatchObject({ stage: "ai", ms: 15_000 });
    expect(find("merged Ponder's fork (abcdef1)")?.stage).toBe("merge");
    expect(hits.filter((h) => h.stage === "events")).toHaveLength(3);
    expect(hits.filter((h) => h.stage === "fork")).toHaveLength(1);
  });

  it("U13 formats latencies", () => {
    expect(formatMs(820)).toBe("820 ms");
    expect(formatMs(6100)).toBe("6.1 s");
    expect(formatMs(65_000)).toBe("1 m 05 s");
  });
});

describe("U14 recordAt: the record as it stood at a replay's time", () => {
  it("U14 keeps only what had happened, and an agent's meter once it ended", () => {
    const task = recordedTask();
    task.agents[0]!.push!.log = [{ at: iso(30), commit: "c1", commits: 1, previewAt: iso(38) }, { at: iso(50), commit: "c2", commits: 1, previewAt: iso(56) }];
    task.agents[1]!.usage = { calls: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.01 };
    task.judging = [{ name: "fork ponder", state: "done", startedAt: iso(61), endedAt: iso(70) }, { name: "ship", state: "done", startedAt: iso(72), endedAt: iso(74) }];
    const mid = recordAt(task, T0 + 45_000);
    expect(mid.agents[0]).toMatchObject({ startedAt: iso(5), push: { log: [{ commit: "c1", previewAt: iso(38) }] } });
    expect(mid.agents[0]!.endedAt).toBeUndefined();
    expect(mid.agents[0]!.push?.preview).toBeUndefined();
    expect(mid.agents[1]).toMatchObject({ endedAt: iso(40), usage: { usd: 0.01 } });
    expect([mid.basePreview?.commit, mid.judging, mid.verdict, mid.finishedAt]).toEqual(["b0", [], undefined, undefined]);
    const judging = recordAt(task, T0 + 65_000);
    expect(judging.judging).toEqual([{ name: "fork ponder", state: "running", startedAt: iso(61) }]);
    // Before the run started there is no start, so the bill card stays hidden as it does live.
    expect(recordAt(task, T0 + 2_000).startedAt).toBeUndefined();
    // After the verdict it is the whole record.
    expect(recordAt(task, T0 + 80_000)).toEqual(task);
  });
});
