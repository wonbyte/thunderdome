import { describe, expect, it, vi } from "vitest";

import {
  applyBasePreview,
  applyOutcome,
  applyPreview,
  applyPreviewFailure,
  applyPush,
  applyStarts,
  baseRequest,
  claimRefusal,
  describeFailure,
  isTaskId,
  justFinished,
  FORK_ATTEMPTS,
  makeForks,
  MAX_SEEN_PUSHES,
  needsPreview,
  newTaskId,
  parseCreateTask,
  recordJudgeStep,
  saveVerdict,
  type Task,
  type Verdict,
  isStalled,
  purgeRefusal,
  purgeRepos,
  stalledOutcomes,
  WATCHDOG_MS,
} from "../src/room/task";
import { artifactsError, created, fakeArtifacts, fakeRepo } from "./fakes";

const noSleep = async () => {};

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

// A repo whose log returns one commit with this hash.
function repoWithHead(hash: string): ArtifactsRepo {
  return fakeRepo({ log: vi.fn(async () => [{ hash } as ArtifactsCommitMetadata]) });
}

describe("newTaskId", () => {
  it("makes valid, distinct ids", () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(isTaskId(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("isTaskId", () => {
  it("rejects other strings", () => {
    expect(isTaskId("t-0123abcd")).toBe(true);
    expect(isTaskId("t-0123ABCD")).toBe(false);
    expect(isTaskId("t-0123abc")).toBe(false);
    expect(isTaskId("../x")).toBe(false);
  });
});

describe("parseCreateTask", () => {
  it("accepts a valid body and defaults agents to 3", () => {
    expect(parseCreateTask({ repo: "thunderdome-sample", prompt: "Add a route" })).toEqual({ repo: "thunderdome-sample", prompt: "Add a route", agents: 3 });
    expect(parseCreateTask({ repo: "thunderdome-sample", prompt: "x", agents: 5 })).toMatchObject({ agents: 5 });
  });

  it("accepts a template instead of a repo", () => {
    expect(parseCreateTask({ template: "thunderdome-template", prompt: "x" })).toEqual({ template: "thunderdome-template", prompt: "x", agents: 3 });
  });

  it.each([
    [null, /JSON object/],
    [[], /JSON object/],
    [{ prompt: "x" }, /exactly one/],
    [{ repo: "r", template: "t", prompt: "x" }, /exactly one/],
    [{ template: "a/b", prompt: "x" }, /template/],
    [{ template: "t".repeat(90), prompt: "x" }, /template/],
    [{ repo: "a/b", prompt: "x" }, /repo/],
    [{ repo: "r" }, /prompt/],
    [{ repo: "r", prompt: "  " }, /prompt/],
    [{ repo: "r", prompt: "x".repeat(10_001) }, /at most/],
    [{ repo: "r", prompt: "x", agents: 2 }, /agents/],
    [{ repo: "r", prompt: "x", agents: 6 }, /agents/],
    [{ repo: "r", prompt: "x", agents: 3.5 }, /agents/],
    [{ repo: "r", prompt: "x", agents: "3" }, /agents/],
  ])("rejects %j", (body, message) => {
    expect(parseCreateTask(body)).toMatch(message);
  });
});

describe("makeForks", () => {
  const task = { id: "t-0123abcd", repo: "thunderdome-sample", prompt: "p", agents: 3 };

  it("makes 1 fork and 1 token per agent", async () => {
    const repo = fakeRepo();
    const { source, forks, base } = await makeForks(fakeArtifacts(repo), task, noSleep);
    expect(source).toBe("thunderdome-sample");
    expect(base).toBeUndefined();
    expect(forks.map((fork) => fork.fork)).toEqual(["t-0123abcd-ponder", "t-0123abcd-zippy", "t-0123abcd-testy"]);
    expect(forks[0]).toEqual({
      name: "ponder",
      fork: "t-0123abcd-ponder",
      remote: "https://git.test/thunderdome/t-0123abcd-ponder.git",
      defaultBranch: "main",
      token: "token-t-0123abcd-ponder",
    });
    expect(new Set(forks.map((fork) => fork.token)).size).toBe(3);
    expect(repo.fork).toHaveBeenCalledWith("t-0123abcd-ponder", { description: "Thunderdome task t-0123abcd, agent ponder", defaultBranchOnly: true });
  });

  it("retries while the source repo is busy", async () => {
    let calls = 0;
    const repo = fakeRepo({
      fork: vi.fn(async (name: string) => {
        if (++calls === 2) throw artifactsError("FORK_IN_PROGRESS");
        return created(name);
      }),
    });
    const { forks } = await makeForks(fakeArtifacts(repo), task, noSleep);
    expect(forks).toHaveLength(3);
    expect(repo.fork).toHaveBeenCalledTimes(4);
  });

  it("MF1: forks every agent at once, in agent order, and waits out a busy source with up to FORK_ATTEMPTS tries", async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const repo = fakeRepo({
      fork: vi.fn(async (name: string) => {
        if (++started === 3) release();
        await gate;
        return created(name);
      }),
    });
    const { forks } = await makeForks(fakeArtifacts(repo), task, noSleep);
    expect(forks.map((f) => f.name)).toEqual(["ponder", "zippy", "testy"]);

    let busy = 0;
    const slow = fakeRepo({
      fork: vi.fn(async (name: string) => {
        if (name.endsWith("-testy") && ++busy < FORK_ATTEMPTS) throw artifactsError("FORK_IN_PROGRESS");
        return created(name);
      }),
    });
    expect(await makeForks(fakeArtifacts(slow), task, noSleep)).toMatchObject({ forks: [{ name: "ponder" }, { name: "zippy" }, { name: "testy" }] });
  });

  it("deletes the forks it made when one fails", async () => {
    const repo = fakeRepo({
      fork: vi.fn(async (name: string) => {
        if (name.endsWith("-testy")) throw artifactsError("INTERNAL_ERROR");
        return created(name);
      }),
    });
    const artifacts = fakeArtifacts(repo);
    await expect(makeForks(artifacts, task, noSleep)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(artifacts.delete).toHaveBeenCalledTimes(2);
    expect(artifacts.delete).toHaveBeenCalledWith("t-0123abcd-ponder");
    expect(artifacts.delete).toHaveBeenCalledWith("t-0123abcd-zippy");
  });

  it("does not retry a missing source repo: each agent's fork looks it up once", async () => {
    const artifacts = fakeArtifacts(fakeRepo(), {
      get: vi.fn(async () => {
        throw artifactsError("NOT_FOUND");
      }),
    });
    await expect(makeForks(artifacts, task, noSleep)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(artifacts.get).toHaveBeenCalledTimes(3);
    expect(artifacts.delete).not.toHaveBeenCalled();
  });

  it("B3: makeForks returns the source head commit as the base, for a repo task and a template task", async () => {
    const repo = repoWithHead(A);
    const artifacts = fakeArtifacts(repo);
    const made = await makeForks(artifacts, task, noSleep);
    expect(made.base).toBe(A);
    expect(made.source).toBe("thunderdome-sample");
    expect(repo.log).toHaveBeenCalledWith({ ref: undefined, limit: 1 });
    expect(vi.mocked(artifacts.get).mock.calls.at(-1)?.[0]).toBe("thunderdome-sample");

    const templateRepo = repoWithHead(B);
    const templateArtifacts = fakeArtifacts(templateRepo);
    const fromTemplate = await makeForks(templateArtifacts, { id: "t-0123abcd", template: "thunderdome-template", prompt: "p", agents: 3 }, noSleep);
    expect(fromTemplate.base).toBe(B);
    expect(fromTemplate.source).toBe("thunderdome-template-t-0123abcd");
    expect(templateRepo.log).toHaveBeenCalledWith({ ref: undefined, limit: 1 });
    expect(vi.mocked(templateArtifacts.get).mock.calls.at(-1)?.[0]).toBe("thunderdome-template-t-0123abcd");
  });

  it("has no base when the source has no commit or its head cannot be read", async () => {
    expect((await makeForks(fakeArtifacts(fakeRepo()), task, noSleep)).base).toBeUndefined();
    const repo = fakeRepo({
      log: vi.fn(async () => {
        throw artifactsError("INTERNAL_ERROR");
      }),
    });
    const artifacts = fakeArtifacts(repo);
    const made = await makeForks(artifacts, { id: "t-0123abcd", template: "thunderdome-template", prompt: "p", agents: 3 }, noSleep);
    expect(made.base).toBeUndefined();
    expect(made.forks).toHaveLength(3);
    expect(artifacts.delete).not.toHaveBeenCalled();
  });

  describe("from a template", () => {
    const fromTemplate = { id: "t-0123abcd", template: "thunderdome-template", prompt: "p", agents: 3 };

    it("forks the template into a fresh source, then forks the source per agent", async () => {
      const repo = fakeRepo();
      const artifacts = fakeArtifacts(repo);
      const { source, forks, base } = await makeForks(artifacts, fromTemplate, noSleep);
      expect(source).toBe("thunderdome-template-t-0123abcd");
      expect(base).toBeUndefined();
      expect(vi.mocked(artifacts.get).mock.calls.map(([name]) => name)).toEqual([
        "thunderdome-template",
        "thunderdome-template-t-0123abcd",
        "thunderdome-template-t-0123abcd",
        "thunderdome-template-t-0123abcd",
        "thunderdome-template-t-0123abcd",
      ]);
      expect(vi.mocked(repo.fork).mock.calls[0]?.[0]).toBe("thunderdome-template-t-0123abcd");
      expect(forks.map((fork) => fork.fork)).toEqual(["t-0123abcd-ponder", "t-0123abcd-zippy", "t-0123abcd-testy"]);
    });

    it("retries agent forks while the fresh source is still forking", async () => {
      let calls = 0;
      const repo = fakeRepo({
        fork: vi.fn(async (name: string) => {
          if (name.endsWith("-ponder") && ++calls <= 2) throw artifactsError("FORK_IN_PROGRESS");
          return created(name);
        }),
      });
      const { forks } = await makeForks(fakeArtifacts(repo), fromTemplate, noSleep);
      expect(forks).toHaveLength(3);
    });

    it("deletes the fresh source and every agent fork made when an agent fork fails (they run at once)", async () => {
      const repo = fakeRepo({
        fork: vi.fn(async (name: string) => {
          if (name.endsWith("-zippy")) throw artifactsError("INTERNAL_ERROR");
          return created(name);
        }),
      });
      const artifacts = fakeArtifacts(repo);
      await expect(makeForks(artifacts, fromTemplate, noSleep)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(vi.mocked(artifacts.delete).mock.calls.map(([name]) => name).toSorted()).toEqual(["t-0123abcd-ponder", "t-0123abcd-testy", "thunderdome-template-t-0123abcd"]);
    });

    it("makes nothing when the template is missing", async () => {
      const artifacts = fakeArtifacts(fakeRepo(), {
        get: vi.fn(async () => {
          throw artifactsError("NOT_FOUND");
        }),
      });
      await expect(makeForks(artifacts, fromTemplate, noSleep)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(artifacts.delete).not.toHaveBeenCalled();
    });
  });
});

describe("describeFailure", () => {
  it("maps errors to statuses", () => {
    expect(describeFailure(artifactsError("NOT_FOUND"), "nope")).toEqual({ status: 404, error: { error: "Repo not found: nope", code: "NOT_FOUND" } });
    expect(describeFailure(artifactsError("UPSTREAM_UNAVAILABLE"), "r")).toMatchObject({ status: 502, error: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(describeFailure(new Error("boom"), "r")).toEqual({ status: 500, error: { error: "Error: boom" } });
  });
});

function runningTask(): Task {
  return {
    id: "t-0123abcd",
    repo: "thunderdome-sample",
    prompt: "p",
    status: "running",
    createdAt: "t0",
    startedAt: "t0",
    agents: (["ponder", "zippy", "testy"] as const).map((name) => ({ name, fork: `t-0123abcd-${name}`, remote: "r", defaultBranch: "main", status: "starting" as const })),
  };
}

describe("applyStarts", () => {
  it("marks started agents running and failed starts failed", () => {
    const task = runningTask();
    applyStarts(task, [{ agent: "ponder" }, { agent: "zippy", error: "clone failed" }, { agent: "testy" }], "t1");
    expect(task.agents.map((slot) => slot.status)).toEqual(["running", "failed", "running"]);
    expect(task.agents[1]).toMatchObject({ error: "clone failed", pushed: false, endedAt: "t1" });
    expect(task.status).toBe("running");
  });

  it("keeps an end that arrived before the start was recorded", () => {
    const task = runningTask();
    task.agents[0]!.status = "done";
    applyStarts(task, [{ agent: "ponder" }], "t1");
    expect(task.agents[0]!.status).toBe("done");
  });

  it("finishes the task when every start failed", () => {
    const task = runningTask();
    applyStarts(task, task.agents.map((slot) => ({ agent: slot.name, error: "x" })), "t1");
    expect(task).toMatchObject({ status: "finished", finishedAt: "t1" });
  });
});

describe("applyOutcome", () => {
  it("records each end once and finishes the task after the last one", () => {
    const task = runningTask();
    for (const slot of task.agents) slot.status = "running";
    expect(applyOutcome(task, "ponder", { end: "done", pushed: true, commit: "abc", costUsd: 0.12 }, "t1")).toBe(true);
    expect(task.agents[0]).toMatchObject({ status: "done", commit: "abc", pushed: true, costUsd: 0.12, endedAt: "t1" });
    expect(applyOutcome(task, "ponder", { end: "failed", pushed: false }, "t2")).toBe(false);
    expect(task.agents[0]!.status).toBe("done");
    applyOutcome(task, "zippy", { end: "timeout", pushed: true }, "t3");
    expect(task.status).toBe("running");
    applyOutcome(task, "testy", { end: "failed", pushed: false, error: "e" }, "t4");
    expect(task).toMatchObject({ status: "finished", finishedAt: "t4" });
  });

  it("ignores an unknown agent", () => {
    expect(applyOutcome(runningTask(), "nobody", { end: "done", pushed: false }, "t1")).toBe(false);
  });
});

function verdict(winner: string | null, why: string): Verdict {
  return { winner, why, judgedAt: "2024-01-01T00:00:00.000Z", ship: { status: "no-winner", winner, locks: [] } };
}

describe("saveVerdict", () => {
  it("a verdict is saved once, and a second save is refused", () => {
    const task = { ...runningTask(), status: "finished" as const };
    const first = verdict("ponder", "ponder passed every test");
    expect(saveVerdict(task, first)).toBe(true);
    expect(task.verdict).toEqual(first);
    const before = structuredClone(task);
    expect(saveVerdict(task, verdict("zippy", "another why"))).toBe(false);
    expect(task).toEqual(before);
    expect(task.verdict?.winner).toBe("ponder");
  });
});

describe("justFinished", () => {
  it("a task that just finished asks for exactly one judge run", () => {
    const task = runningTask();
    let judgeRuns = 0;
    const track = (change: () => void) => {
      const before = task.status;
      change();
      if (justFinished(before, task)) judgeRuns += 1;
    };
    track(() => applyStarts(task, [{ agent: "ponder" }, { agent: "zippy", error: "x" }, { agent: "testy" }], "t1"));
    expect(judgeRuns).toBe(0);
    track(() => applyOutcome(task, "ponder", { end: "done", pushed: true }, "t2"));
    expect(judgeRuns).toBe(0);
    track(() => applyOutcome(task, "testy", { end: "done", pushed: true }, "t3"));
    expect(task.status).toBe("finished");
    expect(judgeRuns).toBe(1);
    // Retried ends and late starts on a finished task do not ask again.
    track(() => applyOutcome(task, "testy", { end: "done", pushed: true }, "t4"));
    track(() => applyStarts(task, [{ agent: "ponder" }], "t5"));
    expect(judgeRuns).toBe(1);
  });

  it("is true when every start failed, and never for other statuses", () => {
    const task = runningTask();
    applyStarts(task, task.agents.map((slot) => ({ agent: slot.name, error: "x" })), "t1");
    expect(justFinished("running", task)).toBe(true);
    expect(justFinished("finished", task)).toBe(false);
    expect(justFinished("running", runningTask())).toBe(false);
  });
});

describe("applyPush", () => {
  it("R6: a push is recorded once per commit, counts commits, and keeps the newest head", () => {
    const task = runningTask();
    expect(applyPush(task, { agent: "ponder", after: A, commits: 2, message: "first" }, "t1")).toBe(true);
    expect(task.agents[0]!.push).toEqual({
      commits: 2,
      pushes: 1,
      lastPushAt: "t1",
      head: A,
      headMessage: "first",
      seen: [A],
      log: [{ at: "t1", commit: A, commits: 2, message: "first" }],
    });
    // An event retry of the same commit changes nothing.
    const before = structuredClone(task);
    expect(applyPush(task, { agent: "ponder", after: A, commits: 2, message: "first" }, "t2")).toBe(false);
    expect(task).toEqual(before);
    expect(applyPush(task, { agent: "ponder", after: B, commits: 3 }, "t3")).toBe(true);
    expect(task.agents[0]!.push).toEqual({
      commits: 5,
      pushes: 2,
      lastPushAt: "t3",
      head: B,
      seen: [A, B],
      log: [
        { at: "t1", commit: A, commits: 2, message: "first" },
        { at: "t3", commit: B, commits: 3 },
      ],
    });
    // A late retry of an older push is still refused, so the head stays the newest.
    expect(applyPush(task, { agent: "ponder", after: A, commits: 2 }, "t4")).toBe(false);
    expect(task.agents[0]!.push?.head).toBe(B);
    // Other agents keep their own state; unknown agents are refused.
    expect(task.agents[1]!.push).toBeUndefined();
    expect(applyPush(task, { agent: "nobody", after: C, commits: 1 }, "t5")).toBe(false);
  });

  it("records pushes in any task status and keeps the outcome fields apart", () => {
    const task = { ...runningTask(), status: "finished" as const };
    applyOutcome(task, "zippy", { end: "done", pushed: true, commit: A }, "t1");
    expect(applyPush(task, { agent: "zippy", after: A, commits: 1 }, "t2")).toBe(true);
    expect(task.agents[1]).toMatchObject({ commit: A, pushed: true, push: { head: A, commits: 1 } });
  });

  it("caps the seen list at MAX_SEEN_PUSHES", () => {
    const task = runningTask();
    for (let i = 0; i < MAX_SEEN_PUSHES + 5; i++) {
      applyPush(task, { agent: "ponder", after: i.toString(16).padStart(40, "0"), commits: 1 }, `t${i}`);
    }
    const push = task.agents[0]!.push!;
    expect(push.seen).toHaveLength(MAX_SEEN_PUSHES);
    expect(push.seen.at(-1)).toBe(push.head);
    expect(push).toMatchObject({ pushes: MAX_SEEN_PUSHES + 5, commits: MAX_SEEN_PUSHES + 5 });
  });

  it("X1: applyPush appends a timed log entry per new push (with message only when given), caps it at MAX_SEEN_PUSHES, and ignores a duplicate", () => {
    const task = runningTask();
    expect(applyPush(task, { agent: "ponder", after: A, commits: 2, message: "fix the bug" }, "t1")).toBe(true);
    // No message, and a bad count is logged as 0 commits.
    expect(applyPush(task, { agent: "ponder", after: B, commits: -1 }, "t2")).toBe(true);
    const log = task.agents[0]!.push!.log!;
    expect(log).toEqual([
      { at: "t1", commit: A, commits: 2, message: "fix the bug" },
      { at: "t2", commit: B, commits: 0 },
    ]);
    expect(Object.hasOwn(log[1]!, "message")).toBe(false);

    // A duplicate push changes nothing, log included.
    const before = structuredClone(task);
    expect(applyPush(task, { agent: "ponder", after: A, commits: 2, message: "fix the bug" }, "t3")).toBe(false);
    expect(task).toEqual(before);
    expect(task.agents[1]!.push).toBeUndefined();

    // A stored push state without a log counts as an empty log.
    const old = runningTask();
    old.agents[0]!.push = { commits: 1, pushes: 1, lastPushAt: "t0", head: A, seen: [A] };
    expect(applyPush(old, { agent: "ponder", after: B, commits: 1 }, "t1")).toBe(true);
    expect(old.agents[0]!.push?.log).toEqual([{ at: "t1", commit: B, commits: 1 }]);

    // Capped at MAX_SEEN_PUSHES, oldest first, newest kept.
    const many = runningTask();
    const total = MAX_SEEN_PUSHES + 5;
    const hash = (i: number) => i.toString(16).padStart(40, "0");
    for (let i = 0; i < total; i++) {
      applyPush(many, { agent: "zippy", after: hash(i), commits: 1, message: `m${i}` }, `t${i}`);
    }
    const capped = many.agents[1]!.push!.log!;
    expect(capped).toHaveLength(MAX_SEEN_PUSHES);
    expect(capped[0]).toEqual({ at: "t5", commit: hash(5), commits: 1, message: "m5" });
    expect(capped.at(-1)).toEqual({ at: `t${total - 1}`, commit: hash(total - 1), commits: 1, message: `m${total - 1}` });
    expect(capped.map((entry) => entry.commit)).toEqual(many.agents[1]!.push!.seen);
  });
});

describe("applyPreview", () => {
  it("R7: a preview URL is saved only when it is for the agent's newest pushed commit", () => {
    const task = runningTask();
    expect(applyPreview(task, "ponder", { url: "https://a.example", commit: A }, "t0")).toBe(false);
    applyPush(task, { agent: "ponder", after: A, commits: 1 }, "t1");
    applyPush(task, { agent: "ponder", after: B, commits: 1 }, "t2");
    // The older build finished late: not saved.
    expect(applyPreview(task, "ponder", { url: "https://a.example", commit: A }, "t3")).toBe(false);
    expect(task.agents[0]!.push?.preview).toBeUndefined();
    expect(applyPreview(task, "ponder", { url: "https://b.example", commit: B }, "t4")).toBe(true);
    expect(task.agents[0]!.push?.preview).toEqual({ url: "https://b.example", commit: B, at: "t4" });
    // A newer push keeps the last preview until its own is saved; an old one never replaces it.
    applyPush(task, { agent: "ponder", after: C, commits: 1 }, "t5");
    expect(task.agents[0]!.push?.preview?.commit).toBe(B);
    expect(applyPreview(task, "ponder", { url: "https://a.example", commit: A }, "t6")).toBe(false);
    expect(applyPreview(task, "ponder", { url: "https://b2.example", commit: B }, "t6")).toBe(false);
    expect(task.agents[0]!.push?.preview).toEqual({ url: "https://b.example", commit: B, at: "t4" });
    expect(applyPreview(task, "nobody", { url: "https://c.example", commit: C }, "t7")).toBe(false);
  });
});

describe("applyBasePreview", () => {
  it("B4: a base preview is saved only when its commit is the task's base commit", () => {
    const task = runningTask();
    // No base commit: nothing is saved.
    let before = structuredClone(task);
    expect(applyBasePreview(task, { url: "https://a.example", commit: A }, "t0")).toBe(false);
    expect(task).toEqual(before);

    task.baseCommit = A;
    before = structuredClone(task);
    expect(applyBasePreview(task, { url: "https://b.example", commit: B }, "t1")).toBe(false);
    expect(task).toEqual(before);

    expect(applyBasePreview(task, { url: "https://a.example", commit: A }, "t1")).toBe(true);
    expect(task.basePreview).toEqual({ url: "https://a.example", commit: A, at: "t1" });

    // A later preview for another commit keeps the saved one.
    before = structuredClone(task);
    expect(applyBasePreview(task, { url: "https://b.example", commit: B }, "t2")).toBe(false);
    expect(task).toEqual(before);
    expect(task.basePreview).toEqual({ url: "https://a.example", commit: A, at: "t1" });
  });
});

describe("baseRequest", () => {
  it("B5: the base request for a task carries its id, source repo and base commit, and there is none without a base commit", () => {
    const task = { ...runningTask(), baseCommit: A };
    expect(baseRequest(task)).toEqual({ kind: "base", taskId: "t-0123abcd", repo: "thunderdome-sample", commit: A });
    expect(baseRequest(runningTask())).toBeUndefined();
  });
});

describe("needsPreview", () => {
  it("is true only for the newest head without a saved preview", () => {
    const task = runningTask();
    expect(needsPreview(task, "ponder", A)).toBe(false);
    applyPush(task, { agent: "ponder", after: A, commits: 1 }, "t1");
    expect(needsPreview(task, "ponder", A)).toBe(true);
    applyPush(task, { agent: "ponder", after: B, commits: 1 }, "t2");
    expect(needsPreview(task, "ponder", A)).toBe(false);
    expect(needsPreview(task, "ponder", B)).toBe(true);
    applyPreview(task, "ponder", { url: "https://b.example", commit: B }, "t3");
    expect(needsPreview(task, "ponder", B)).toBe(false);
    expect(needsPreview(task, "nobody", B)).toBe(false);
  });
});

describe("claimRefusal", () => {
  it("lets a live agent of a ready or running task claim", () => {
    const task = runningTask();
    expect(claimRefusal(task, "ponder")).toBeUndefined();
    expect(claimRefusal({ ...task, status: "ready" }, "ponder")).toBeUndefined();
  });

  it("refuses everyone else", () => {
    const task = runningTask();
    expect(claimRefusal(undefined, "ponder")).toMatchObject({ status: 404 });
    expect(claimRefusal({ ...task, status: "finished" }, "ponder")).toMatchObject({ status: 409 });
    expect(claimRefusal(task, "nobody")).toMatchObject({ status: 404 });
    task.agents[0]!.status = "done";
    expect(claimRefusal(task, "ponder")).toMatchObject({ status: 409, error: "Agent ponder has ended" });
  });
});

describe("purge", () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: "t-00000001",
    repo: "thunderdome-ui-t-00000001",
    template: "thunderdome-ui",
    prompt: "p",
    status: "finished",
    createdAt: "x",
    agents: [
      { name: "ponder", fork: "t-00000001-ponder", remote: "r", defaultBranch: "main", status: "done" },
      { name: "zippy", fork: "t-00000001-zippy", remote: "r", defaultBranch: "main", status: "done" },
    ],
    verdict: { winner: "zippy", why: "", judgedAt: "x", ship: { status: "merged", winner: "zippy", locks: [] } },
    ...over,
  });

  it("deletes the forks and a template-made source, but never a shared source repo", () => {
    expect(purgeRepos(task())).toEqual(["t-00000001-ponder", "t-00000001-zippy", "thunderdome-ui-t-00000001"]);
    const { template: _template, ...shared } = task({ repo: "thunderdome-sample" });
    expect(purgeRepos(shared)).toEqual(["t-00000001-ponder", "t-00000001-zippy"]);
  });

  it("refuses a race that is creating, running or being judged", () => {
    expect(purgeRefusal(task())).toBeUndefined();
    expect(purgeRefusal(undefined)).toBeUndefined();
    expect(purgeRefusal(task({ status: "failed" }))).toBeUndefined();
    expect(purgeRefusal(task({ status: "running" }))).toBe("Task is running");
    expect(purgeRefusal(task({ status: "creating" }))).toBe("Task is creating");
    expect(purgeRefusal(task({ verdict: undefined }))).toBe("Task is being judged");
  });
});

describe("the watchdog", () => {
  const start = Date.parse("2026-10-06T05:00:00Z");
  const running = (): Task => ({
    id: "t-00000001",
    repo: "r",
    prompt: "p",
    status: "running",
    createdAt: "x",
    startedAt: new Date(start).toISOString(),
    agents: [
      { name: "ponder", fork: "f1", remote: "r", defaultBranch: "main", status: "starting", push: { commits: 1, pushes: 1, lastPushAt: "x", head: "abc123", seen: ["abc123"] } },
      { name: "zippy", fork: "f2", remote: "r", defaultBranch: "main", status: "done", pushed: true },
      { name: "testy", fork: "f3", remote: "r", defaultBranch: "main", status: "running" },
    ],
  });

  it("calls a running race stalled only once its watchdog time has passed", () => {
    expect(isStalled(running(), start + WATCHDOG_MS - 1)).toBe(false);
    expect(isStalled(running(), start + WATCHDOG_MS)).toBe(true);
    expect(isStalled({ ...running(), status: "finished" }, start + WATCHDOG_MS)).toBe(false);
    expect(isStalled({ ...running(), startedAt: undefined }, start + WATCHDOG_MS)).toBe(false);
  });

  it("ends every agent that never ended as failed, keeping a pushed head for the judge", () => {
    expect(stalledOutcomes(running())).toEqual([
      { agent: "ponder", outcome: { end: "failed", pushed: true, commit: "abc123", error: expect.stringContaining("stopped reporting") } },
      { agent: "testy", outcome: { end: "failed", pushed: false, error: expect.stringContaining("stopped reporting") } },
    ]);
  });

  it("lets a stalled race be purged, but not one still in its time", () => {
    expect(purgeRefusal(running(), start + 60_000)).toBe("Task is running");
    expect(purgeRefusal(running(), start + WATCHDOG_MS)).toBeUndefined();
  });
});

describe("recordJudgeStep", () => {
  it("G1: a step starts, ends with its start kept, and starts again on a retry; unknown names and steps after the verdict are refused", () => {
    const task = { ...runningTask(), status: "finished" as const };
    expect(recordJudgeStep(task, "fork ponder", "running", "t1")).toBe(true);
    expect(recordJudgeStep(task, "fork ponder", "done", "t2")).toBe(true);
    expect(task.judging).toEqual([{ name: "fork ponder", state: "done", startedAt: "t1", endedAt: "t2" }]);
    expect(recordJudgeStep(task, "fork ponder", "running", "t3")).toBe(true);
    expect(task.judging).toEqual([{ name: "fork ponder", state: "running", startedAt: "t3" }]);
    expect(recordJudgeStep(task, "rm -rf", "running", "t4")).toBe(false);
    saveVerdict(task, verdict("ponder", "w"));
    expect(recordJudgeStep(task, "ship", "running", "t5")).toBe(false);
    expect(task.judging).toHaveLength(1);
  });
});

describe("judge step attempts", () => {
  it("G2: a late end from an older attempt is refused; the retry's own end is kept", () => {
    const task = { ...runningTask(), status: "finished" as const };
    recordJudgeStep(task, "look", "running", "t1", "a1");
    recordJudgeStep(task, "look", "running", "t2", "a2");
    expect(recordJudgeStep(task, "look", "done", "t3", "a1")).toBe(false);
    expect(task.judging?.[0]).toMatchObject({ state: "running", attempt: "a2" });
    expect(recordJudgeStep(task, "look", "done", "t4", "a2")).toBe(true);
    expect(task.judging?.[0]).toMatchObject({ state: "done", startedAt: "t2", endedAt: "t4" });
  });
});

describe("applyPreviewFailure", () => {
  it("G3: notes a failed build only for the agent's newest head", () => {
    const task = runningTask();
    task.agents[0]!.push = { commits: 1, pushes: 1, lastPushAt: "t1", head: "c2", seen: ["c2"] };
    expect(applyPreviewFailure(task, "ponder", "c1")).toBe(false);
    expect(applyPreviewFailure(task, "ponder", "c2")).toBe(true);
    expect(task.agents[0]!.push.previewFailed).toBe("c2");
    expect(applyPreviewFailure(task, "zippy", "c2")).toBe(false);
  });
});
