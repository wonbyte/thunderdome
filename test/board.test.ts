import { describe, expect, it } from "vitest";

import { scoreForks, type ScoreResult } from "../src/judge/score";
import type { ClaimBoard, ClaimResult } from "../src/room/claims";
import type { LoggedStep, Task } from "../src/room/task";
import type { LiveEvent } from "../src/room/TaskRoom";
import {
  actionForStep,
  AGENT_COLORS,
  applyEvent,
  applyScores,
  bubbleFor,
  colorFor,
  decidedLine,
  displayName,
  emptyBoard,
  FALLBACK_COLOR,
  initBoard,
  STEP_TEXT_MAX,
  type Board,
  type BoardEvent,
  type WireTask,
  whyWithNames,
} from "../src/ui/board";

const id = "t-0123abcd";
const now = 1_000;
const later = 2_000;

function wireTask(status: WireTask["agents"][number]["status"] = "running"): WireTask {
  return {
    id,
    prompt: "Fix the bug",
    status: "running",
    startedAt: "2025-01-01T00:00:00.000Z",
    agents: ["careful", "fast", "tester"].map((name) => ({ name, status })),
  };
}

function fighter(board: Board, agent: string) {
  const found = board.fighters.find((f) => f.agent === agent);
  if (found === undefined) throw new Error(`no fighter ${agent}`);
  return found;
}

function step(seq: number, agent: string, kind: string, text: string) {
  return { seq, agent, at: "2025-01-01T00:00:01.000Z", kind, text };
}

function claim(agent: string, claimed: string[], shared: string[], clashes: { file: string; heldBy: string[] }[]): BoardEvent {
  return { kind: "claim", taskId: id, agent, result: { ok: true, claimed, shared, clashes } };
}

describe("board", () => {
  it("U3: a step maps to the robot action", () => {
    const cases: [string, string, string][] = [
      ["tool", "Read src/a.ts", "scan"],
      ["tool", "Grep foo", "scan"],
      ["tool", "Glob **/*.ts", "scan"],
      ["tool", "LS src", "scan"],
      ["tool", "Edit src/a.ts", "hammer"],
      ["tool", "Write src/b.ts", "hammer"],
      ["tool", "MultiEdit src/a.ts", "hammer"],
      ["tool", "NotebookEdit nb.ipynb", "hammer"],
      ["tool", "Bash npm test", "charge"],
      ["tool", "Bash npm t", "charge"],
      ["tool", "Bash npm run test -- --run", "charge"],
      ["tool", "Bash npx vitest run", "charge"],
      ["tool", "Bash jest src", "charge"],
      ["tool", "Bash pytest -q", "charge"],
      ["tool", "Bash node --test", "charge"],
      ["tool", "Bash ls test/", "work"],
      ["tool", "Bash git status", "work"],
      ["tool", "TodoWrite {}", "work"],
      ["tool", "Readme", "work"],
      ["text", "I will read the code", "think"],
      ["claim", "claimed src/a.ts", "flag"],
      ["error", "DONE (failed)", "hurt"],
      ["init", "started", "idle"],
      ["result", "DONE (done)", "finished"],
      ["mystery", "?", "idle"],
    ];
    for (const [kind, text, action] of cases) {
      expect(actionForStep({ kind, text }), `${kind} ${text}`).toBe(action);
    }
    expect(colorFor("careful")).toBe("#d97757");
    expect(colorFor("tidy")).toBe(AGENT_COLORS.tidy);
    expect(colorFor("someone")).toBe(FALLBACK_COLOR);
    expect(colorFor("toString")).toBe(FALLBACK_COLOR);
  });

  it("U4: events update the fighters (steps, push, preview, agent-end, base-preview)", () => {
    const task = wireTask();
    const board = initBoard(task, [], { active: [], history: [] }, now);
    expect(board.fighters.map((f) => [f.agent, f.color, f.action, f.status])).toEqual([
      ["careful", "#d97757", "idle", "running"],
      ["fast", "#e5484d", "idle", "running"],
      ["tester", "#3e8ed0", "idle", "running"],
    ]);
    const frozen = JSON.stringify(board);

    const long = `Bash npm test ${"x ".repeat(100)}`;
    let next = applyEvent(board, { kind: "steps", taskId: id, agent: "careful", steps: [step(1, "careful", "tool", "Read a.ts"), step(2, "careful", "tool", long)] }, later);
    expect(fighter(next, "careful")).toMatchObject({ action: "charge", actionAt: later });
    expect(fighter(next, "careful").lastStep).toHaveLength(STEP_TEXT_MAX);
    expect(fighter(next, "careful").lastStep?.endsWith("…")).toBe(true);
    expect(next.lastSeq).toBe(2);
    expect(JSON.stringify(board)).toBe(frozen);

    // A replayed step is ignored.
    const again = applyEvent(next, { kind: "steps", taskId: id, agent: "careful", steps: [step(2, "careful", "text", "old")] }, 3_000);
    expect(again).toEqual(next);

    next = applyEvent(next, { kind: "push", taskId: id, agent: "fast", push: { commits: 3 } }, 3_000);
    expect(fighter(next, "fast")).toMatchObject({ action: "push", actionAt: 3_000, commits: 3 });

    const preview = { url: "https://fast.example.dev", commit: "abc", at: "2025-01-01T00:01:00.000Z" };
    next = applyEvent(next, { kind: "preview", taskId: id, agent: "fast", preview }, 3_000);
    expect(fighter(next, "fast").preview).toEqual(preview);

    next = applyEvent(next, { kind: "agent-end", taskId: id, agent: "careful", outcome: { end: "done" }, status: "running" }, 4_000);
    expect(fighter(next, "careful")).toMatchObject({ status: "done", action: "finished", actionAt: 4_000 });
    next = applyEvent(next, { kind: "agent-end", taskId: id, agent: "fast", outcome: { end: "timeout" }, status: "running" }, 4_000);
    expect(fighter(next, "fast")).toMatchObject({ status: "timeout", action: "down" });
    next = applyEvent(next, { kind: "agent-end", taskId: id, agent: "tester", outcome: { end: "failed" }, status: "finished" }, 5_000);
    expect(fighter(next, "tester")).toMatchObject({ status: "failed", action: "down" });
    expect(next.task?.status).toBe("finished");
    expect(next.task?.finishedAt).toBe(new Date(5_000).toISOString());
    expect(next.task?.agents.map((slot) => slot.status)).toEqual(["done", "timeout", "failed"]);
    expect(task.agents.map((slot) => slot.status)).toEqual(["running", "running", "running"]);

    // An ended robot keeps its final action but still shows its last words.
    next = applyEvent(next, { kind: "steps", taskId: id, agent: "careful", steps: [step(3, "careful", "tool", "Edit a.ts")] }, 6_000);
    expect(fighter(next, "careful")).toMatchObject({ action: "finished", lastStep: "Edit a.ts" });

    const base = { url: "https://base.example.dev", commit: "b0", at: "2025-01-01T00:00:30.000Z" };
    next = applyEvent(next, { kind: "base-preview", taskId: id, preview: base }, 6_000);
    expect(next.basePreview).toEqual(base);

    // Another task's events are ignored.
    expect(applyEvent(next, { kind: "push", taskId: "t-ffffffff", agent: "tester", push: { commits: 9 } }, 7_000)).toBe(next);
  });

  it("U5: a claim clash marks both robots as clashing on the file and the grid marks it red", () => {
    let board = initBoard(wireTask(), [], { active: [], history: [] }, now);
    board = applyEvent(board, claim("careful", ["src/b.ts", "src/a.ts"], [], []), now);
    expect(board.grid.clashes).toEqual([]);
    const before = JSON.stringify(board);
    board = applyEvent(board, claim("fast", ["src/a.ts"], ["src/a.ts"], [{ file: "src/a.ts", heldBy: ["careful"] }]), later);
    expect(JSON.parse(before).grid.cells["src/a.ts"]).toEqual({ careful: "own" });

    expect(board.grid.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(board.grid.cells["src/a.ts"]).toEqual({ careful: "own", fast: "shared" });
    expect(board.grid.clashes).toEqual(["src/a.ts"]);
    for (const agent of ["careful", "fast"]) {
      expect(fighter(board, agent)).toMatchObject({ action: "clash", actionAt: later, clashFile: "src/a.ts" });
    }
    expect(fighter(board, "careful").files).toEqual(["src/b.ts", "src/a.ts"]);
    expect(fighter(board, "tester").clashFile).toBeUndefined();

    board = applyEvent(board, { kind: "release", taskId: id, agent: "fast", released: ["src/a.ts"] }, 3_000);
    expect(board.grid.clashes).toEqual([]);
    expect(board.grid.cells["src/a.ts"]).toEqual({ careful: "own" });
    expect(fighter(board, "careful").clashFile).toBeUndefined();
    expect(fighter(board, "fast")).toMatchObject({ files: [], action: "clash" });

    // An ended agent's files are freed.
    board = applyEvent(board, { kind: "agent-end", taskId: id, agent: "careful", outcome: { end: "done" }, status: "running" }, 4_000);
    expect(board.grid).toEqual({ files: [], cells: {}, clashes: [] });
  });

  it("U6: the verdict crowns the winner, the rest lose, scores rank the fighters with their parts, and a null winner crowns nobody", () => {
    const board = initBoard(wireTask(), [], { active: [], history: [] }, now);
    const won = applyEvent(board, { kind: "verdict", taskId: id, verdict: { winner: "fast", why: "Passed every test." } }, later);
    expect(won.fighters.map((f) => f.action)).toEqual(["lost", "won", "lost"]);
    expect(won).toMatchObject({ winner: "fast", why: "Passed every test.", ended: true });
    expect(won.task?.verdict).toEqual({ winner: "fast", why: "Passed every test." });
    expect(board.ended).toBe(false);

    const fork = { testsTotal: 4, linesChanged: 5, filesChanged: ["a.ts"], filesClaimed: ["a.ts"] };
    const ranked: ScoreResult["ranked"] = scoreForks([
      { ...fork, agent: "careful", testsPassed: 2, taskFit: 0.5, clarity: 0.5 },
      { ...fork, agent: "fast", testsPassed: 4, taskFit: 1, clarity: 1 },
      { ...fork, agent: "tester", testsPassed: 0, taskFit: 1, clarity: 1 },
    ]).ranked;
    const scored = applyScores(won, ranked);
    expect(scored.fighters.map((f) => f.agent)).toEqual(["careful", "fast", "tester"]);
    expect(fighter(scored, "fast").score).toEqual({ total: 100, parts: { tests: 50, taskFit: 25, clarity: 15, claim: 10 }, eligible: true, place: 1 });
    expect(fighter(scored, "careful").score).toMatchObject({ place: 2, eligible: true, parts: { tests: 25 } });
    expect(fighter(scored, "tester").score).toMatchObject({ place: 3, eligible: false });
    expect(fighter(won, "fast").score).toBeUndefined();

    let none = applyEvent(board, { kind: "agent-end", taskId: id, agent: "tester", outcome: { end: "failed" }, status: "running" }, later);
    none = applyEvent(none, { kind: "verdict", taskId: id, verdict: { winner: null, why: "Nobody passed." } }, later);
    expect(none.fighters.map((f) => f.action)).toEqual(["finished", "finished", "down"]);
    expect(none).toMatchObject({ winner: null, ended: true });
    expect(none.fighters.some((f) => f.action === "won")).toBe(false);
  });

  it("U7: initBoard equals replaying snapshot, steps and claim events, and real LiveEvents type-check as board events", () => {
    const task: Task = {
      id,
      repo: "demo",
      prompt: "Fix the bug",
      status: "running",
      createdAt: "2025-01-01T00:00:00.000Z",
      startedAt: "2025-01-01T00:00:01.000Z",
      agents: (["careful", "fast", "tester"] as const).map((name) => ({
        name,
        fork: `${id}-${name}`,
        remote: `https://example.dev/${name}.git`,
        defaultBranch: "main",
        status: "running" as const,
      })),
      baseCommit: "b0",
    };
    const steps: LoggedStep[] = [
      step(1, "careful", "tool", "Read src/a.ts"),
      step(2, "careful", "claim", "claimed src/a.ts, src/b.ts"),
      step(3, "fast", "tool", "Edit src/a.ts"),
    ];
    const first: ClaimResult = { ok: true, claimed: ["src/a.ts", "src/b.ts"], already: [], shared: [], clashes: [] };
    const second: ClaimResult = { ok: true, claimed: ["src/a.ts"], already: [], shared: ["src/a.ts"], clashes: [{ file: "src/a.ts", heldBy: ["careful"] }] };
    const at = "2025-01-01T00:00:02.000Z";
    const claims: ClaimBoard = {
      active: [
        { agent: "careful", file: "src/a.ts", shared: false, at },
        { agent: "careful", file: "src/b.ts", shared: false, at },
        { agent: "fast", file: "src/a.ts", shared: true, at },
      ],
      history: [],
    };
    const replay: LiveEvent[] = [
      { kind: "snapshot", taskId: id, task },
      { kind: "steps", taskId: id, agent: "careful", steps: steps.slice(0, 2) },
      { kind: "steps", taskId: id, agent: "fast", steps: steps.slice(2) },
      { kind: "claim", taskId: id, agent: "careful", result: first },
      { kind: "claim", taskId: id, agent: "fast", result: second },
    ];
    let replayed = emptyBoard(id);
    for (const event of replay) replayed = applyEvent(replayed, event, now);
    const built = initBoard(task, steps, claims, now);
    expect(built).toEqual(replayed);
    expect(built.grid.clashes).toEqual(["src/a.ts"]);
    expect(fighter(built, "fast")).toMatchObject({ action: "clash", clashFile: "src/a.ts", lastStep: "Edit src/a.ts" });

    const preview = { url: "https://p.example.dev", commit: "c1", at };
    const rest: LiveEvent[] = [
      { kind: "status", taskId: id, task },
      { kind: "steps", taskId: id, agent: "tester", steps: [step(4, "tester", "tool", "Bash npm test")] },
      { kind: "claim", taskId: id, agent: "tester", result: { ok: false, status: 409, error: "Task is finished" } },
      { kind: "release", taskId: id, agent: "fast", released: ["src/a.ts"] },
      { kind: "push", taskId: id, agent: "fast", push: { commits: 2, pushes: 1, lastPushAt: at, head: "c1" } },
      { kind: "preview", taskId: id, agent: "fast", preview },
      { kind: "agent-end", taskId: id, agent: "fast", outcome: { end: "done", pushed: true, commit: "c1" }, status: "running" },
      { kind: "base-preview", taskId: id, preview: { url: "https://b.example.dev", commit: "b0", at } },
      {
        kind: "verdict",
        taskId: id,
        verdict: { winner: "fast", why: "Best fix.", judgedAt: at, ship: { status: "merged", winner: "fast", commit: "m1", locks: [] } },
      },
    ];
    let board = built;
    for (const event of rest) board = applyEvent(board, event, later);
    expect(fighter(board, "tester")).toMatchObject({ lastStep: "Bash npm test", action: "lost" });
    expect(fighter(board, "fast")).toMatchObject({ commits: 2, preview, status: "done", action: "won", files: [] });
    expect(board.grid.clashes).toEqual([]);
    expect(board.basePreview?.commit).toBe("b0");
    expect(board).toMatchObject({ winner: "fast", why: "Best fix.", ended: true, lastSeq: 4 });
    expect(task.agents.map((slot) => slot.status)).toEqual(["running", "running", "running"]);
  });
});

describe("U8 names: each fighter has a display name", () => {
  it("U8 names careful, fast and tester, and falls back to the agent id", () => {
    expect(["careful", "fast", "tester"].map(displayName)).toEqual(["Dillion", "Sam", "Leo"]);
    expect(displayName("lean")).toBe("lean");
    expect(displayName("constructor")).toBe("constructor");
  });
});

describe("U9 names: the why uses the names and keeps the table aligned", () => {
  it("U9 swaps whole agent ids and keeps each table column at the same offset", () => {
    const why = [
      "Winner: careful (98.47/100)",
      "",
      "agent    tests     total",
      "careful  6/6 (50)  98.47",
      "tester   6/6 (50)  89.49",
      "fast     6/6 (50)  86.05",
      "",
      "Why careful won:",
      "- A carefully kept claim; fast was faster.",
    ].join("\n");
    const out = whyWithNames(why, ["careful", "tester", "fast"]).split("\n");
    expect(out[0]).toBe("Winner: Dillion (98.47/100)");
    for (const row of out.slice(2, 6)) expect(row.indexOf("6/6") === -1 ? row.indexOf("tests") : row.indexOf("6/6")).toBe(9);
    expect(out[4]).toBe("Leo      6/6 (50)  89.49");
    expect(out[7]).toBe("Why Dillion won:");
    expect(out[8]).toBe("- A carefully kept claim; Sam was faster.");
  });
});

describe("U10 claims: the claimed grid keeps the race's claim record", () => {
  it("U10 keeps released and ended agents' claims, and their clashes, in claimed", () => {
    const task = wireTask();
    let board = initBoard(task, [], { active: [], history: [] }, now);
    board = applyEvent(board, { kind: "claim", taskId: id, agent: "careful", result: { ok: true, claimed: ["src/a.ts"], shared: [], clashes: [] } }, now);
    board = applyEvent(board, { kind: "claim", taskId: id, agent: "fast", result: { ok: true, claimed: ["src/a.ts"], shared: ["src/a.ts"], clashes: [{ file: "src/a.ts", heldBy: ["careful"] }] } }, now);
    board = applyEvent(board, { kind: "release", taskId: id, agent: "careful", released: ["src/a.ts"] }, now);
    board = applyEvent(board, { kind: "agent-end", taskId: id, agent: "fast", outcome: { end: "done" }, status: "running" }, now);
    expect(board.grid.files).toEqual([]);
    expect(board.claimed.cells).toEqual({ "src/a.ts": { careful: "own", fast: "shared" } });
    expect(board.claimed.clashes).toEqual(["src/a.ts"]);
  });

  it("U10 builds claimed from the claim history on load, even when nothing is held", () => {
    const history = [
      { agent: "careful", file: "src/a.ts", shared: false, at: "t" },
      { agent: "fast", file: "src/a.ts", shared: true, at: "t" },
      { agent: "tester", file: "src/b.ts", shared: false, at: "t" },
    ];
    const board = initBoard(wireTask(), [], { active: [], history }, now);
    expect(board.grid.files).toEqual([]);
    expect(board.claimed.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(board.claimed.clashes).toEqual(["src/a.ts"]);
  });
});

describe("U11 bubbles: short labels instead of raw steps", () => {
  it("U11 labels tools, shell commands, text and results", () => {
    const tool = (text: string) => bubbleFor({ kind: "tool", text });
    expect(tool("Read /workspace/repo/src/cart.ts")).toBe("reading cart.ts");
    expect(tool("Edit src/reviews.ts")).toBe("editing reviews.ts");
    expect(tool("Grep reviews")).toBe("searching the code");
    expect(tool("Bash cd /workspace/repo; npm test 2>&1 | tail -40")).toBe("running the tests");
    expect(tool("Bash cd /workspace/repo; claim src/a.ts src/b.ts")).toBe("claiming files");
    expect(tool("Bash cd /workspace/repo; git add -A && git commit -qm x")).toBe("committing");
    expect(tool("Bash cd /workspace/repo && git push origin HEAD")).toBe("pushing");
    expect(tool("Bash cd /workspace/repo; cat >> src/reviews.ts <<'EOF' export")).toBe("writing reviews.ts");
    expect(tool("Bash cd /workspace/repo; cat src/routes.ts")).toBe("reading the code");
    expect(tool("Bash node scripts/x.mjs")).toBe("running node");
    expect(tool("Bash cd /workspace/repo; for f in src/*.ts; do cat $f; done")).toBe("running a script");
    expect(bubbleFor({ kind: "result", text: "DONE (done) pushed 44c72df644762c6b7450e1a4a22509942836b63a" })).toBe("done");
    expect(bubbleFor({ kind: "text", text: "**Done.** All 6 tests pass now, and more." })).toBe("Done.");
    expect(bubbleFor({ kind: "claim", text: "shared claim src/a.ts; clash: src/a.ts (also held by careful)" })).toBe("clash on a claim!");
    expect(bubbleFor({ kind: "init", text: "started" })).toBeUndefined();
    expect((bubbleFor({ kind: "text", text: "x".repeat(200) }) ?? "").length).toBe(64);
  });
});

describe("U14 decided: the page shows the judge's deciding line", () => {
  it("U14 finds the Decided by line in the why, and nothing when there is none", () => {
    const why = "Winner: fast (91.82/100)\n\nagent  total\nfast   91.82\n\nDecided by claims: the fixes were within 0.55 points on code; fast claimed the files first (10 vs 8 claim points).\n\nWhy fast won:\n- x";
    expect(decidedLine(why)).toBe("Decided by claims: the fixes were within 0.55 points on code; fast claimed the files first (10 vs 8 claim points).");
    expect(decidedLine("Winner: a (1/100)")).toBeUndefined();
    expect(decidedLine(undefined)).toBeUndefined();
  });
});
