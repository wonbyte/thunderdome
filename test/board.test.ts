import { describe, expect, it } from "vitest";

import { stepsOf } from "../src/agents/events";
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
  PROGRESS_LABELS,
  PROGRESS_STEPS,
  progressOf,
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
    agents: ["ponder", "zippy", "testy"].map((name) => ({ name, status })),
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
    expect(colorFor("ponder")).toBe("#d97757");
    expect(colorFor("sparkle")).toBe(AGENT_COLORS.sparkle);
    expect(colorFor("someone")).toBe(FALLBACK_COLOR);
    expect(colorFor("toString")).toBe(FALLBACK_COLOR);
  });

  it("U4: events update the fighters (steps, push, preview, agent-end, base-preview)", () => {
    const task = wireTask();
    const board = initBoard(task, [], { active: [], history: [] }, now);
    expect(board.fighters.map((f) => [f.agent, f.color, f.action, f.status])).toEqual([
      ["ponder", "#d97757", "idle", "running"],
      ["zippy", "#e5484d", "idle", "running"],
      ["testy", "#3e8ed0", "idle", "running"],
    ]);
    const frozen = JSON.stringify(board);

    const long = `Bash npm test ${"x ".repeat(100)}`;
    let next = applyEvent(board, { kind: "steps", taskId: id, agent: "ponder", steps: [step(1, "ponder", "tool", "Read a.ts"), step(2, "ponder", "tool", long)] }, later);
    expect(fighter(next, "ponder")).toMatchObject({ action: "charge", actionAt: later });
    expect(fighter(next, "ponder").lastStep).toHaveLength(STEP_TEXT_MAX);
    expect(fighter(next, "ponder").lastStep?.endsWith("…")).toBe(true);
    expect(next.lastSeq).toBe(2);
    expect(JSON.stringify(board)).toBe(frozen);

    // A replayed step is ignored.
    const again = applyEvent(next, { kind: "steps", taskId: id, agent: "ponder", steps: [step(2, "ponder", "text", "old")] }, 3_000);
    expect(again).toEqual(next);

    next = applyEvent(next, { kind: "push", taskId: id, agent: "zippy", push: { commits: 3 } }, 3_000);
    expect(fighter(next, "zippy")).toMatchObject({ action: "push", actionAt: 3_000, commits: 3 });

    const preview = { url: "https://zippy.example.dev", commit: "abc", at: "2025-01-01T00:01:00.000Z" };
    next = applyEvent(next, { kind: "preview", taskId: id, agent: "zippy", preview }, 3_000);
    expect(fighter(next, "zippy").preview).toEqual(preview);

    next = applyEvent(next, { kind: "agent-end", taskId: id, agent: "ponder", outcome: { end: "done" }, status: "running" }, 4_000);
    expect(fighter(next, "ponder")).toMatchObject({ status: "done", action: "finished", actionAt: 4_000 });
    next = applyEvent(next, { kind: "agent-end", taskId: id, agent: "zippy", outcome: { end: "timeout" }, status: "running" }, 4_000);
    expect(fighter(next, "zippy")).toMatchObject({ status: "timeout", action: "down" });
    next = applyEvent(next, { kind: "agent-end", taskId: id, agent: "testy", outcome: { end: "failed" }, status: "finished" }, 5_000);
    expect(fighter(next, "testy")).toMatchObject({ status: "failed", action: "down" });
    expect(next.task?.status).toBe("finished");
    expect(next.task?.finishedAt).toBe(new Date(5_000).toISOString());
    expect(next.task?.agents.map((slot) => slot.status)).toEqual(["done", "timeout", "failed"]);
    expect(task.agents.map((slot) => slot.status)).toEqual(["running", "running", "running"]);

    // An ended robot keeps its final action but still shows its last words.
    next = applyEvent(next, { kind: "steps", taskId: id, agent: "ponder", steps: [step(3, "ponder", "tool", "Edit a.ts")] }, 6_000);
    expect(fighter(next, "ponder")).toMatchObject({ action: "finished", lastStep: "Edit a.ts" });

    const base = { url: "https://base.example.dev", commit: "b0", at: "2025-01-01T00:00:30.000Z" };
    next = applyEvent(next, { kind: "base-preview", taskId: id, preview: base }, 6_000);
    expect(next.basePreview).toEqual(base);

    // Another task's events are ignored.
    expect(applyEvent(next, { kind: "push", taskId: "t-ffffffff", agent: "testy", push: { commits: 9 } }, 7_000)).toBe(next);
  });

  it("U5: a claim clash marks both robots as clashing on the file and the grid marks it red", () => {
    let board = initBoard(wireTask(), [], { active: [], history: [] }, now);
    board = applyEvent(board, claim("ponder", ["src/b.ts", "src/a.ts"], [], []), now);
    expect(board.grid.clashes).toEqual([]);
    const before = JSON.stringify(board);
    board = applyEvent(board, claim("zippy", ["src/a.ts"], ["src/a.ts"], [{ file: "src/a.ts", heldBy: ["ponder"] }]), later);
    expect(JSON.parse(before).grid.cells["src/a.ts"]).toEqual({ ponder: "own" });

    expect(board.grid.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(board.grid.cells["src/a.ts"]).toEqual({ ponder: "own", zippy: "shared" });
    expect(board.grid.clashes).toEqual(["src/a.ts"]);
    for (const agent of ["ponder", "zippy"]) {
      expect(fighter(board, agent)).toMatchObject({ action: "clash", actionAt: later, clashFile: "src/a.ts" });
    }
    expect(fighter(board, "ponder").files).toEqual(["src/b.ts", "src/a.ts"]);
    expect(fighter(board, "testy").clashFile).toBeUndefined();

    board = applyEvent(board, { kind: "release", taskId: id, agent: "zippy", released: ["src/a.ts"] }, 3_000);
    expect(board.grid.clashes).toEqual([]);
    expect(board.grid.cells["src/a.ts"]).toEqual({ ponder: "own" });
    expect(fighter(board, "ponder").clashFile).toBeUndefined();
    expect(fighter(board, "zippy")).toMatchObject({ files: [], action: "clash" });

    // An ended agent's files are freed.
    board = applyEvent(board, { kind: "agent-end", taskId: id, agent: "ponder", outcome: { end: "done" }, status: "running" }, 4_000);
    expect(board.grid).toEqual({ files: [], cells: {}, clashes: [] });
  });

  it("U6: the verdict crowns the winner, the rest lose, scores rank the fighters with their parts, and a null winner crowns nobody", () => {
    const board = initBoard(wireTask(), [], { active: [], history: [] }, now);
    const won = applyEvent(board, { kind: "verdict", taskId: id, verdict: { winner: "zippy", why: "Passed every test." } }, later);
    expect(won.fighters.map((f) => f.action)).toEqual(["lost", "won", "lost"]);
    expect(won).toMatchObject({ winner: "zippy", why: "Passed every test.", ended: true });
    expect(won.task?.verdict).toEqual({ winner: "zippy", why: "Passed every test." });
    expect(board.ended).toBe(false);

    const fork = { testsTotal: 4, linesChanged: 5, filesChanged: ["a.ts"], filesClaimed: ["a.ts"] };
    const ranked: ScoreResult["ranked"] = scoreForks([
      { ...fork, agent: "ponder", testsPassed: 2, taskFit: 0.5, clarity: 0.5 },
      { ...fork, agent: "zippy", testsPassed: 4, taskFit: 1, clarity: 1 },
      { ...fork, agent: "testy", testsPassed: 0, taskFit: 1, clarity: 1 },
    ]).ranked;
    const scored = applyScores(won, ranked);
    expect(scored.fighters.map((f) => f.agent)).toEqual(["ponder", "zippy", "testy"]);
    expect(fighter(scored, "zippy").score).toEqual({ total: 100, parts: { tests: 50, taskFit: 25, clarity: 15, claim: 10 }, eligible: true, place: 1 });
    expect(fighter(scored, "ponder").score).toMatchObject({ place: 2, eligible: true, parts: { tests: 25 } });
    expect(fighter(scored, "testy").score).toMatchObject({ place: 3, eligible: false });
    expect(fighter(won, "zippy").score).toBeUndefined();

    let none = applyEvent(board, { kind: "agent-end", taskId: id, agent: "testy", outcome: { end: "failed" }, status: "running" }, later);
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
      agents: (["ponder", "zippy", "testy"] as const).map((name) => ({
        name,
        fork: `${id}-${name}`,
        remote: `https://example.dev/${name}.git`,
        defaultBranch: "main",
        status: "running" as const,
      })),
      baseCommit: "b0",
    };
    const steps: LoggedStep[] = [
      step(1, "ponder", "tool", "Read src/a.ts"),
      step(2, "ponder", "claim", "claimed src/a.ts, src/b.ts"),
      step(3, "zippy", "tool", "Edit src/a.ts"),
    ];
    const first: ClaimResult = { ok: true, claimed: ["src/a.ts", "src/b.ts"], already: [], shared: [], clashes: [] };
    const second: ClaimResult = { ok: true, claimed: ["src/a.ts"], already: [], shared: ["src/a.ts"], clashes: [{ file: "src/a.ts", heldBy: ["ponder"] }] };
    const at = "2025-01-01T00:00:02.000Z";
    const claims: ClaimBoard = {
      active: [
        { agent: "ponder", file: "src/a.ts", shared: false, at },
        { agent: "ponder", file: "src/b.ts", shared: false, at },
        { agent: "zippy", file: "src/a.ts", shared: true, at },
      ],
      history: [],
    };
    const replay: LiveEvent[] = [
      { kind: "snapshot", taskId: id, task },
      { kind: "steps", taskId: id, agent: "ponder", steps: steps.slice(0, 2) },
      { kind: "steps", taskId: id, agent: "zippy", steps: steps.slice(2) },
      { kind: "claim", taskId: id, agent: "ponder", result: first },
      { kind: "claim", taskId: id, agent: "zippy", result: second },
    ];
    let replayed = emptyBoard(id);
    for (const event of replay) replayed = applyEvent(replayed, event, now);
    const built = initBoard(task, steps, claims, now);
    expect(built).toEqual(replayed);
    expect(built.grid.clashes).toEqual(["src/a.ts"]);
    expect(fighter(built, "zippy")).toMatchObject({ action: "clash", clashFile: "src/a.ts", lastStep: "Edit src/a.ts" });

    const preview = { url: "https://p.example.dev", commit: "c1", at };
    const rest: LiveEvent[] = [
      { kind: "status", taskId: id, task },
      { kind: "steps", taskId: id, agent: "testy", steps: [step(4, "testy", "tool", "Bash npm test")] },
      { kind: "claim", taskId: id, agent: "testy", result: { ok: false, status: 409, error: "Task is finished" } },
      { kind: "release", taskId: id, agent: "zippy", released: ["src/a.ts"] },
      { kind: "push", taskId: id, agent: "zippy", push: { commits: 2, pushes: 1, lastPushAt: at, head: "c1" } },
      { kind: "preview", taskId: id, agent: "zippy", preview },
      { kind: "agent-end", taskId: id, agent: "zippy", outcome: { end: "done", pushed: true, commit: "c1" }, status: "running" },
      { kind: "base-preview", taskId: id, preview: { url: "https://b.example.dev", commit: "b0", at } },
      {
        kind: "verdict",
        taskId: id,
        verdict: { winner: "zippy", why: "Best fix.", judgedAt: at, ship: { status: "merged", winner: "zippy", commit: "m1", locks: [] } },
      },
    ];
    let board = built;
    for (const event of rest) board = applyEvent(board, event, later);
    expect(fighter(board, "testy")).toMatchObject({ lastStep: "Bash npm test", action: "lost" });
    expect(fighter(board, "zippy")).toMatchObject({ commits: 2, preview, status: "done", action: "won", files: [] });
    expect(board.grid.clashes).toEqual([]);
    expect(board.basePreview?.commit).toBe("b0");
    expect(board).toMatchObject({ winner: "zippy", why: "Best fix.", ended: true, lastSeq: 4 });
    expect(task.agents.map((slot) => slot.status)).toEqual(["running", "running", "running"]);
  });
});

describe("U8 names: each fighter has a display name", () => {
  it("U8 names every agent, and falls back to the agent id", () => {
    expect(["ponder", "zippy", "testy", "snip", "sparkle"].map(displayName)).toEqual(["Ponder", "Zippy", "Testy", "Snip", "Sparkle"]);
    expect(displayName("other")).toBe("other");
    expect(displayName("constructor")).toBe("constructor");
  });
});

describe("U9 names: the why uses the names and keeps the table aligned", () => {
  it("U9 swaps whole agent ids and keeps each table column at the same offset", () => {
    const why = [
      "Winner: ponder (98.47/100)",
      "",
      "agent    tests     total",
      "ponder   6/6 (50)  98.47",
      "testy    6/6 (50)  89.49",
      "zippy    6/6 (50)  86.05",
      "",
      "Why ponder won:",
      "- A carefully kept claim; zippy was faster.",
    ].join("\n");
    const out = whyWithNames(why, ["ponder", "testy", "zippy"]).split("\n");
    expect(out[0]).toBe("Winner: Ponder (98.47/100)");
    for (const row of out.slice(2, 6)) expect(row.indexOf("6/6") === -1 ? row.indexOf("tests") : row.indexOf("6/6")).toBe(9);
    expect(out[4]).toBe("Testy    6/6 (50)  89.49");
    expect(out[7]).toBe("Why Ponder won:");
    expect(out[8]).toBe("- A carefully kept claim; Zippy was faster.");
  });
});

describe("U10 claims: the claimed grid keeps the race's claim record", () => {
  it("U10 keeps released and ended agents' claims, and their clashes, in claimed", () => {
    const task = wireTask();
    let board = initBoard(task, [], { active: [], history: [] }, now);
    board = applyEvent(board, { kind: "claim", taskId: id, agent: "ponder", result: { ok: true, claimed: ["src/a.ts"], shared: [], clashes: [] } }, now);
    board = applyEvent(board, { kind: "claim", taskId: id, agent: "zippy", result: { ok: true, claimed: ["src/a.ts"], shared: ["src/a.ts"], clashes: [{ file: "src/a.ts", heldBy: ["ponder"] }] } }, now);
    board = applyEvent(board, { kind: "release", taskId: id, agent: "ponder", released: ["src/a.ts"] }, now);
    board = applyEvent(board, { kind: "agent-end", taskId: id, agent: "zippy", outcome: { end: "done" }, status: "running" }, now);
    expect(board.grid.files).toEqual([]);
    expect(board.claimed.cells).toEqual({ "src/a.ts": { ponder: "own", zippy: "shared" } });
    expect(board.claimed.clashes).toEqual(["src/a.ts"]);
  });

  it("U10 builds claimed from the claim history on load, even when nothing is held", () => {
    const history = [
      { agent: "ponder", file: "src/a.ts", shared: false, at: "t" },
      { agent: "zippy", file: "src/a.ts", shared: true, at: "t" },
      { agent: "testy", file: "src/b.ts", shared: false, at: "t" },
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
    expect(bubbleFor({ kind: "claim", text: "shared claim src/a.ts; clash: src/a.ts (also held by ponder)" })).toBe("clash on a claim!");
    expect(bubbleFor({ kind: "init", text: "started" })).toBeUndefined();
    expect((bubbleFor({ kind: "text", text: "x".repeat(200) }) ?? "").length).toBe(64);
  });
});

describe("U14 decided: the page shows the judge's deciding line", () => {
  it("U14 finds the Decided by line in the why, and nothing when there is none", () => {
    const why = "Winner: zippy (91.82/100)\n\nagent  total\nfast   91.82\n\nDecided by claims: the fixes were within 0.55 points on code; zippy claimed the files first (10 vs 8 claim points).\n\nWhy zippy won:\n- x";
    expect(decidedLine(why)).toBe("Decided by claims: the fixes were within 0.55 points on code; zippy claimed the files first (10 vs 8 claim points).");
    expect(decidedLine("Winner: a (1/100)")).toBeUndefined();
    expect(decidedLine(undefined)).toBeUndefined();
  });
});

describe("progress squares", () => {
  const reached = (board: Board, agent: string) => [...progressOf(board, fighter(board, agent))];

  it("lights one step at a time as the agent works, and only the steps it reached", () => {
    let board = initBoard(wireTask("starting"), [], { active: [], history: [] }, now);
    expect(reached(board, "ponder")).toEqual([]);
    board = applyEvent(board, { kind: "steps", taskId: id, agent: "ponder", steps: [step(1, "ponder", "init", "started")] }, now);
    expect(reached(board, "ponder")).toEqual(["started"]);
    board = applyEvent(board, claim("ponder", ["src/a.ts"], [], []), now);
    board = applyEvent(board, { kind: "steps", taskId: id, agent: "ponder", steps: [step(2, "ponder", "tool", "Edit src/a.ts")] }, now);
    expect(reached(board, "ponder")).toEqual(["started", "claimed", "edited"]);
    // zippy pushed without running the tests: its "ran the tests" square stays dark.
    board = applyEvent(board, { kind: "steps", taskId: id, agent: "zippy", steps: [step(3, "zippy", "tool", "Write src/b.ts")] }, now);
    board = applyEvent(board, { kind: "push", taskId: id, agent: "zippy", push: { commits: 1 } }, now);
    expect(reached(board, "zippy")).toEqual(["started", "edited", "pushed"]);
    // testy edited with sed only, then pushed: the push counts as edited code.
    board = applyEvent(board, { kind: "steps", taskId: id, agent: "testy", steps: [step(4, "testy", "tool", "Bash sed -i s/a/b/ src/c.ts")] }, now);
    board = applyEvent(board, { kind: "push", taskId: id, agent: "testy", push: { commits: 1 } }, now);
    expect(reached(board, "testy")).toEqual(["started", "edited", "pushed"]);
    board = applyEvent(board, { kind: "steps", taskId: id, agent: "ponder", steps: [step(5, "ponder", "tool", "Bash npm test")] }, now);
    board = applyEvent(board, { kind: "push", taskId: id, agent: "ponder", push: { commits: 2 } }, now);
    expect(reached(board, "ponder")).toEqual(["started", "claimed", "edited", "tested", "pushed"]);
  });

  it("does not light \"sandbox up\" for an agent that failed before it ever ran", () => {
    const board = initBoard(wireTask("failed"), [], { active: [], history: [] }, now);
    expect(reached(board, "ponder")).toEqual([]);
  });

  it("fills the winner's bar completely, and only the winner's", () => {
    let board = initBoard(wireTask("done"), [step(1, "ponder", "init", "started")], { active: [], history: [] }, now);
    board = applyEvent(board, { kind: "verdict", taskId: id, verdict: { winner: "zippy", why: "Fast won." } }, later);
    expect(reached(board, "zippy")).toEqual([...PROGRESS_STEPS]);
    expect(reached(board, "ponder")).toEqual(["started"]);
    expect(PROGRESS_STEPS.map((s) => PROGRESS_LABELS[s])).toEqual(["sandbox up", "claimed files", "edited code", "ran the tests", "pushed", "won the race"]);
  });
});

describe("a test run hidden in a long command", () => {
  it("still lights \"ran the tests\": the server keeps the run at the end of the clipped text", () => {
    const command = `claim src/page.ts && cat > src/page.ts <<'EOF'\n${"export const x = 1;\n".repeat(60)}EOF\nnpm test`;
    const [logged] = stepsOf({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
    let board = initBoard(wireTask(), [], { active: [], history: [] }, now);
    board = applyEvent(board, { kind: "steps", taskId: id, agent: "zippy", steps: [step(1, "zippy", "tool", logged!.text)] }, now);
    expect(progressOf(board, fighter(board, "zippy")).has("tested")).toBe(true);
  });
});
