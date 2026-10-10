import { describe, expect, it } from "vitest";

import type { BoardEvent, WireTask } from "../src/ui/board";
import { applyPlatform, emptyPlatform, type PlatformHit } from "../src/ui/platform";
import { circuit, edgeFor, route } from "../src/ui/xray";

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

  it("X4: a wire walked backwards is the same polyline reversed", () => {
    const c = circuit(agents);
    expect(route(c, ["sandbox:zippy", "room"])).toEqual(route(c, ["room", "sandbox:zippy"])?.toReversed());
  });
});
