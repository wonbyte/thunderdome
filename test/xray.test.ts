import { describe, expect, it } from "vitest";

import type { BoardEvent, WireTask } from "../src/ui/board";
import { applyPlatform, emptyPlatform, type PlatformHit } from "../src/ui/platform";
import { busyNodes, circuit, edgeFor, route, traceLine, traceOf, xrayStats } from "../src/ui/xray";

const taskId = "t-0123abcd";
const agents = ["ponder", "zippy"];
const T0 = Date.parse("2026-10-10T05:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

const task: WireTask = { id: taskId, prompt: "p", status: "running", startedAt: iso(0), agents: agents.map((name) => ({ name, status: "running" })) };
const judge = (name: string, state: "running" | "done"): BoardEvent => ({ kind: "judge", taskId, step: { name, state, startedAt: iso(70) } });

// One real event of every kind that reaches a product, in race order.
const race: BoardEvent[] = [
  { kind: "snapshot", taskId, task: { ...task, status: "ready", startedAt: undefined } },
  { kind: "status", taskId, task },
  { kind: "steps", taskId, agent: "ponder", steps: [{ seq: 1, agent: "ponder", at: iso(5), kind: "init", text: "up" }] },
  { kind: "claim", taskId, agent: "ponder", result: { ok: true, claimed: ["a.ts"], shared: [], clashes: [] } },
  { kind: "claim", taskId, agent: "zippy", result: { ok: true, claimed: ["a.ts"], shared: ["a.ts"], clashes: [{ file: "a.ts", heldBy: ["ponder"] }] } },
  { kind: "release", taskId, agent: "ponder", released: ["a.ts"] },
  { kind: "base-preview", taskId, preview: { url: "https://b.example", commit: "b0", at: iso(15) } },
  { kind: "push", taskId, agent: "ponder", push: { commits: 1, lastPushAt: iso(30) } },
  { kind: "preview", taskId, agent: "ponder", preview: { url: "https://p.example", commit: "c1", at: iso(40) } },
  { kind: "agent-end", taskId, agent: "ponder", outcome: { end: "done" }, status: "running" },
  { kind: "agent-end", taskId, agent: "zippy", outcome: { end: "done" }, status: "finished" },
  judge("fork ponder", "running"),
  judge("fork ponder", "done"),
  judge("look", "running"),
  judge("split", "done"),
  judge("compare", "done"),
  judge("fuse", "running"),
  {
    kind: "verdict",
    taskId,
    verdict: {
      winner: "ponder",
      why: "w",
      judgedAt: iso(90),
      ship: { status: "merged", commit: "abcdef1" },
      fusion: { tried: [{ agent: "zippy", files: ["b.ts"], status: "added" }], commit: "f00d" },
    },
  },
];

function hitsOf(events: BoardEvent[]): PlatformHit[] {
  let state = emptyPlatform();
  return events.flatMap((event, i) => {
    const out = applyPlatform(state, event, T0 + i * 1000);
    state = out.state;
    return out.hits;
  });
}

describe("xray", () => {
  it("X1: every hit of a race sends a packet along wires the circuit has", () => {
    const c = circuit(agents);
    const hits = hitsOf(race);
    expect(new Set(hits.map((h) => h.stage))).toEqual(new Set(["fork", "containers", "claims", "events", "workflows", "previews", "ai", "fusion", "merge"]));
    for (const h of hits) {
      const paths = edgeFor(h, agents);
      expect(paths.length, h.text).toBeGreaterThan(0);
      for (const path of paths) expect(route(c, path), `${h.text}: ${path.join(" > ")}`).toBeDefined();
    }
  });

  it("X2: the push and the judge take their real routes", () => {
    const at = (text: string) => edgeFor(hitsOf(race).find((h) => h.text.startsWith(text))!, agents);
    expect(at("Ponder pushed")).toEqual([["sandbox:ponder", "artifacts", "events"]]);
    expect(at("building")).toEqual([["events", "pushwf", "build"]]);
    expect(at("judge sandbox")).toEqual([["judge", "tests"]]);
    expect(at("screenshots")).toEqual([["judge", "browser", "clef"]]);
    expect(at("starting")).toEqual([["room", "sandbox:ponder"], ["room", "sandbox:zippy"]]);
  });

  it("X3: a hit for a robot not in the race, or one X-ray does not know, sends nothing", () => {
    expect(edgeFor({ stage: "claims", text: "Snip claimed 1 file", agent: "snip" }, agents)).toEqual([]);
    expect(edgeFor({ stage: "workflows", text: "something new" }, agents)).toEqual([]);
    expect(route(circuit(agents), ["room", "clef"])).toBeUndefined();
  });

  it("X5: busy nodes are what the timeline shows running: robots, a build in progress, the judge's parts", () => {
    const racing: WireTask = { ...task, agents: [{ name: "ponder", status: "running", startedAt: iso(0), push: { commits: 1, log: [{ at: iso(30), commit: "c1", commits: 1 }] } }, { name: "zippy", status: "done", startedAt: iso(0), endedAt: iso(20) }] };
    expect([...busyNodes(racing, T0 + 40_000)].toSorted()).toEqual(["build", "pushwf", "sandbox:ponder"]);
    const judging: WireTask = { ...racing, status: "finished", agents: racing.agents.map((a) => ({ ...a, status: "done", endedAt: iso(50), push: undefined })), judging: [{ name: "fork ponder", state: "done", startedAt: iso(60), endedAt: iso(70) }, { name: "look", state: "running", startedAt: iso(60) }] };
    expect([...busyNodes(judging, T0 + 75_000)].toSorted()).toEqual(["browser", "clef", "judge"]);
    // A replay reads the finished record at the scrub's time: the fork step ran from 60 s to 70 s.
    const done: WireTask = { ...judging, judging: judging.judging!.map((s) => ({ ...s, state: "done", endedAt: iso(80) })), verdict: { winner: "ponder", why: "w", judgedAt: iso(90) } };
    expect([...busyNodes(done, T0 + 65_000)].toSorted()).toEqual(["browser", "clef", "judge", "tests"]);
    expect(busyNodes(done, T0 + 95_000).size).toBe(0);
  });

  // Four builds (one slow, one with no saved preview), five fork checks (one slow), a robot out of time.
  function measured(): WireTask {
    const build = (name: string, at: number, previewAt?: number) => ({ at: iso(at), commit: `${name}${at}`, commits: 1, ...(previewAt === undefined ? {} : { previewAt: iso(previewAt) }) });
    return {
      ...task,
      status: "finished",
      agents: [
        { name: "ponder", status: "done", startedAt: iso(0), endedAt: iso(100), push: { commits: 2, log: [build("p", 10, 20), build("p", 30, 40)], preview: { url: "u", commit: "p30", at: iso(40) } } },
        { name: "zippy", status: "timeout", startedAt: iso(0), endedAt: iso(110), push: { commits: 2, log: [build("z", 10, 21), build("z", 50, 80), build("z", 90)], preview: { url: "u", commit: "z50", at: iso(80) } } },
      ],
      judging: [10, 11, 12, 30, 10].map((s, i) => ({ name: `fork f${i}`, state: "done", startedAt: iso(120), endedAt: iso(120 + s) })),
      verdict: { winner: "ponder", why: "w", judgedAt: iso(200) },
    };
  }

  it("X6: boxes show each node's latest and average time from the timeline's finished bars", () => {
    const { stats } = xrayStats(measured(), T0 + 300_000);
    expect(stats.get("build")).toEqual({ last: 30_000, avg: (10_000 + 10_000 + 11_000 + 30_000) / 4, n: 4 });
    expect(stats.get("tests")).toMatchObject({ n: 5 });
    expect(stats.get("judge")).toEqual({ last: 30_000, avg: 30_000, n: 1 });
    // Before the judge ran, nothing judge-side is measured yet.
    expect(xrayStats(measured(), T0 + 115_000).stats.has("tests")).toBe(false);
  });

  it("X7: notes are facts: over twice the median with three or more to compare, no saved end, out of time", () => {
    expect(xrayStats(measured(), T0 + 300_000).notes).toEqual([
      "Zippy's preview z50 took 30.0 s, 2.9× this race's median build (10.5 s).",
      "f3's tests and Clef scoring took 30.0 s, 2.7× this race's median fork check (11.0 s).",
      "Zippy's preview z90 has no saved preview: it did not finish within 80 s, or before the verdict.",
    ]);
    // 5 s after that push, in a replay of the full record, it may still be building: no note yet.
    expect(xrayStats(measured(), T0 + 95_000).notes.some((n) => n.includes("z90"))).toBe(false);
    // The cap keeps three; the fourth fact is there underneath.
    const early = measured();
    early.judging = [];
    expect(xrayStats(early, T0 + 300_000).notes).toContain("Zippy ran out of time.");
  });

  it("X8: a trace is the newest push by the scrub's time, its preview only once saved", () => {
    const t = measured();
    expect(traceOf(t, "ponder", T0 + 5_000)).toBeUndefined();
    const mid = traceOf(t, "ponder", T0 + 35_000)!;
    expect(mid).toMatchObject({ commit: "p30", at: T0 + 30_000 });
    expect(mid.previewAt).toBeUndefined();
    expect(traceLine(mid, T0)).toContain("No preview saved for it yet");
    const end = traceOf(t, "ponder", T0 + 300_000)!;
    expect(end.path).toEqual(["sandbox:ponder", "artifacts", "events", "pushwf", "build", "previews"]);
    expect(traceLine(end, T0)).toBe("Ponder's push p30, recorded 30.0 s into the race: sandbox → Artifacts → Event Subscriptions → Push Workflow → build container → Workers Preview, live 10.0 s after the push was recorded. The hops between are not timed one by one.");
  });

  it("X9: a packet changing wires passes through the box's center and keeps every point of each wire", () => {
    const c = circuit(agents);
    const wire = (from: string, to: string) => c.edges.find((e) => e.from === from && e.to === to)!.points;
    const artifacts = c.nodes.find((n) => n.id === "artifacts")!;
    // A push enters Artifacts on its left and leaves from its top: no diagonal across the box.
    expect(route(c, ["sandbox:ponder", "artifacts", "events"])).toEqual([...wire("sandbox:ponder", "artifacts"), [artifacts.x + artifacts.w / 2, artifacts.y + artifacts.h / 2], ...wire("artifacts", "events")]);
  });

  it("X4: a wire walked backwards is the same polyline reversed", () => {
    const c = circuit(agents);
    expect(route(c, ["sandbox:zippy", "room"])).toEqual(route(c, ["room", "sandbox:zippy"])?.toReversed());
  });
});
