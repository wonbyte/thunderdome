import { describe, expect, it } from "vitest";

import { applyScores, initBoard, type WireJudgeStep, type WireScore, type WireTask } from "../src/ui/board";
import { guessView } from "../src/ui/guess";
import { phaseOf, phaseStarts, railStates } from "../src/ui/phases";
import { boardAt, buildTimeline } from "../src/ui/timeline";

const T0 = Date.parse("2026-10-07T18:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const noClaims = { active: [], history: [] };

function task(over: Partial<WireTask> = {}): WireTask {
  return {
    id: "t-0123abcd",
    prompt: "Fix the cart",
    status: "running",
    createdAt: iso(0),
    startedAt: iso(5),
    agents: [
      { name: "ponder", status: "running", startedAt: iso(5) },
      { name: "zippy", status: "running", startedAt: iso(5) },
    ],
    ...over,
  };
}

const step = (name: string, state: WireJudgeStep["state"], s: number, e?: number): WireJudgeStep => ({ name, state, startedAt: iso(s), ...(e === undefined ? {} : { endedAt: iso(e) }) });

const board = (t: WireTask) => initBoard(t, [], noClaims, T0);

/** A finished race: forks judged, fused, merged; ponder won. */
function finished(over: Partial<WireTask> = {}): WireTask {
  return task({
    status: "finished",
    finishedAt: iso(60),
    agents: [
      { name: "ponder", status: "done", startedAt: iso(5), endedAt: iso(60) },
      { name: "zippy", status: "done", startedAt: iso(5), endedAt: iso(40) },
    ],
    judging: [step("fork ponder", "done", 61, 70), step("fork zippy", "done", 61, 70), step("fuse", "done", 71, 80), step("ship", "done", 81, 85)],
    verdict: { winner: "ponder", why: "Winner: ponder", judgedAt: iso(86), ship: { status: "merged", commit: "abc" } },
    ...over,
  });
}

const scores: WireScore[] = [
  { agent: "ponder", total: 87.24, eligible: true, parts: { tests: 45, taskFit: 13.64, clarity: 8.41, look: 10.19, claim: 10 } },
  { agent: "zippy", total: 85.34, eligible: true, parts: { tests: 45, taskFit: 12.17, clarity: 8.19, look: 9.98, claim: 10 } },
  { agent: "testy", total: 85.28, eligible: true, parts: { tests: 45, taskFit: 14.26, clarity: 8.54, look: 7.48, claim: 10 } },
];

describe("phase rail", () => {
  it("P1: creating and ready are the fork phase, running is the race", () => {
    expect(phaseOf(board(task({ status: "creating", startedAt: undefined })))).toEqual({ phase: "fork", state: "current" });
    expect(phaseOf(board(task({ status: "ready", startedAt: undefined })))).toEqual({ phase: "fork", state: "current" });
    expect(phaseOf(board(task()))).toEqual({ phase: "race", state: "current" });
  });

  it("P2: while judging, the judge's steps tell judge, fuse and merge apart", () => {
    const judging = (steps: WireJudgeStep[]) => board(task({ status: "finished", finishedAt: iso(60), judging: steps }));
    expect(phaseOf(judging([])).phase).toBe("judge");
    expect(phaseOf(judging([step("fork ponder", "running", 61)])).phase).toBe("judge");
    expect(phaseOf(judging([step("fork ponder", "done", 61, 70), step("fuse", "running", 71)])).phase).toBe("fuse");
    expect(phaseOf(judging([step("fuse", "done", 71, 80), step("ship", "running", 81)]))).toEqual({ phase: "merge", state: "current" });
  });

  it("P3: a verdict ends the race: merged is all done, a failed ship is a failed merge", () => {
    const done = phaseOf(board(finished()));
    expect(done).toEqual({ phase: "merge", state: "done" });
    expect(Object.values(railStates(done))).toEqual(["done", "done", "done", "done", "done"]);
    const conflict = finished({ verdict: { winner: "ponder", why: "", ship: { status: "conflict" } } });
    expect(phaseOf(board(conflict))).toEqual({ phase: "merge", state: "failed" });
  });

  it("P4: no winner stops at the judge, and fuse and merge are skipped", () => {
    const at = phaseOf(board(finished({ verdict: { winner: null, why: "no fork passed" } })));
    expect(at).toEqual({ phase: "judge", state: "done", skipRest: true });
    expect(railStates(at)).toEqual({ fork: "done", race: "done", judge: "done", fuse: "skipped", merge: "skipped" });
  });

  it("P5: a failed task fails the phase it was in", () => {
    expect(phaseOf(board(task({ status: "failed", startedAt: undefined })))).toEqual({ phase: "fork", state: "failed" });
    expect(phaseOf(board(task({ status: "failed" })))).toEqual({ phase: "race", state: "failed" });
    expect(railStates({ phase: "race", state: "current" })).toEqual({ fork: "done", race: "current", judge: "waiting", fuse: "waiting", merge: "waiting" });
  });

  it("P6: a replay reaches each phase at its recorded time, judge steps included", () => {
    const timeline = buildTimeline(finished(), [], noClaims);
    expect(phaseOf(boardAt(timeline, T0 + 75_000)).phase).toBe("fuse");
    const starts = phaseStarts(timeline);
    expect(starts.race).toBe(T0 + 5_000);
    expect(starts.judge).toBe(T0 + 60_000);
    expect(starts.fuse).toBe(T0 + 71_000);
    expect(starts.merge).toBe(T0 + 81_000);
  });
});

describe("guess the winner", () => {
  it("G1: open while the robots race, with or without a pick", () => {
    expect(guessView(board(task()), undefined, true)).toEqual({ kind: "open" });
    expect(guessView(board(task()), "zippy", true)).toEqual({ kind: "open", pick: "zippy" });
  });

  it("G2: locked while the judge works, hidden with no pick", () => {
    const judging = board(task({ status: "finished", finishedAt: iso(60) }));
    expect(guessView(judging, "zippy", true)).toEqual({ kind: "locked", pick: "zippy" });
    expect(guessView(judging, undefined, true)).toEqual({ kind: "hidden" });
    expect(guessView(judging, "sparkle", true)).toEqual({ kind: "hidden" });
  });

  it("G3: the reveal waits for the page's reveal, then says how the pick did", () => {
    const ended = applyScores(board(finished()), scores);
    expect(guessView(ended, "zippy", false)).toEqual({ kind: "locked", pick: "zippy" });
    expect(guessView(ended, "ponder", true)).toEqual({ kind: "reveal", pick: "ponder", hit: true, text: "You called it 🎯 Ponder won." });
    expect(guessView(ended, "zippy", true)).toEqual({ kind: "reveal", pick: "zippy", hit: false, text: "Ponder beat your pick by 1.9 points." });
  });

  it("G4: no winner, or an unscored pick, still gets an answer", () => {
    const none = board(finished({ verdict: { winner: null, why: "" } }));
    expect(guessView(none, "zippy", true)).toMatchObject({ kind: "reveal", hit: false, text: "No winner this time, so no one called it." });
    const lone = applyScores(board(finished()), scores.slice(0, 1));
    expect(guessView(lone, "zippy", true)).toMatchObject({ text: "Ponder won; your pick Zippy was not scored." });
  });
});

describe("moment links", () => {
  it("M1: t reads m:ss, plain seconds and a fraction; anything else is no moment", async () => {
    const { momentLink, momentText, parseMoment } = await import("../src/ui/moment");
    expect(parseMoment("?replay&t=1:42")).toBe(102_000);
    expect(parseMoment("?replay&t=102")).toBe(102_000);
    expect(parseMoment("?t=0:05.5")).toBe(5_500);
    expect(parseMoment("?replay")).toBeUndefined();
    expect(parseMoment("?t=1:75")).toBeUndefined();
    expect(parseMoment("?t=abc")).toBeUndefined();
    expect(parseMoment("?t=-3")).toBeUndefined();
    expect(momentText(102_000)).toBe("1:42");
    expect(momentText(102_440)).toBe("1:42.4");
    expect(momentLink("https://x.test", "t-0123abcd", 102_000)).toBe("https://x.test/race/t-0123abcd?replay&t=1:42");
    // Round trip to the tenth: a link copied just before the verdict does not reopen before it.
    expect(parseMoment(new URL(momentLink("https://x.test", "t-0123abcd", 103_940)).search)).toBe(103_900);
  });
});
