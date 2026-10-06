import { describe, expect, it, vi } from "vitest";

import { judgeInstanceId } from "../src/judge/judge";
import { claimFiles, emptyBoard, type ClaimBoard } from "../src/room/claims";
import { judgeInput as roomJudgeInput, type AgentStatus, type Task, type TaskStatus } from "../src/room/task";
import { handleJudge, judgeInput, judgeTaskId } from "../src/routes/tasks";

const ID = "t-0123abcd";
const URL_ = `https://thunderdome.test/tasks/${ID}/judge`;

function task(status: TaskStatus = "finished"): Task {
  const ends: AgentStatus[] = ["done", "failed", "timeout"];
  return {
    id: ID,
    repo: "thunderdome-sample",
    prompt: "Add /health",
    status,
    createdAt: "2026-10-05T00:00:00.000Z",
    agents: (["ponder", "zippy", "testy"] as const).map((name, i) => ({
      name,
      fork: `${ID}-${name}`,
      remote: `https://git.test/${name}.git`,
      defaultBranch: "main",
      status: ends[i] ?? "done",
    })),
  };
}

function board(): ClaimBoard {
  const b = emptyBoard();
  claimFiles(b, "ponder", ["src/a.ts", "src/b.ts"], false, "now");
  claimFiles(b, "zippy", ["src/a.ts"], true, "now");
  return b;
}

interface FakeOptions {
  state?: Task | null;
  instance?: { status: string; output?: unknown; error?: unknown };
  // create throws; when raceStatus is set, the room's instance shows up right after.
  createError?: Error;
  raceStatus?: string;
}

function fakeEnv({ state = task(), instance, createError, raceStatus }: FakeOptions = {}) {
  const stub = { state: vi.fn(async () => state), claimBoard: vi.fn(async () => board()) };
  const getByName = vi.fn(() => stub);
  let current = instance;
  const status = vi.fn(async () => current ?? { status: "queued" });
  const JUDGE = {
    create: vi.fn(async (options: { id: string; params: unknown }) => {
      if (createError !== undefined) {
        if (raceStatus !== undefined) current = { status: raceStatus };
        throw createError;
      }
      return { id: options.id, status };
    }),
    get: vi.fn(async (id: string) => {
      if (current === undefined) throw new Error("instance.not_found");
      return { id, status };
    }),
  };
  const env = { TASK_ROOM: { getByName }, JUDGE } as unknown as Pick<Env, "TASK_ROOM" | "JUDGE">;
  return { env, stub, JUDGE };
}

const post = () => new Request(URL_, { method: "POST" });

describe("judgeTaskId", () => {
  it("matches only /tasks/:id/judge with a valid id", () => {
    expect(judgeTaskId(`/tasks/${ID}/judge`)).toBe(ID);
    expect(judgeTaskId("/tasks/nope/judge")).toBeUndefined();
    expect(judgeTaskId(`/tasks/${ID}/judge/x`)).toBeUndefined();
    expect(judgeTaskId(`/tasks/${ID}`)).toBeUndefined();
  });
});

describe("judgeInput", () => {
  it("is the room's judgeInput, so the auto start and the route send the same params", () => {
    expect(judgeInput).toBe(roomJudgeInput);
  });

  it("includes every agent slot with its claimed files", () => {
    const input = judgeInput(task(), board());
    expect(input).toMatchObject({ taskId: ID, repo: "thunderdome-sample", task: "Add /health" });
    expect(input.forks.map((f) => [f.agent, f.filesClaimed])).toEqual([
      ["ponder", ["src/a.ts", "src/b.ts"]],
      ["zippy", ["src/a.ts"]],
      ["testy", []],
    ]);
    expect(input.forks[0]).toMatchObject({ fork: `${ID}-ponder`, remote: "https://git.test/ponder.git", defaultBranch: "main" });
  });

  it("passes shared files and each agent's end time", () => {
    const t = task();
    t.agents[1]!.endedAt = "2026-10-05T00:01:00.000Z";
    const input = judgeInput(t, board());
    expect(input.forks.map((f) => [f.agent, f.filesShared, f.endedAt])).toEqual([
      ["ponder", [], undefined],
      ["zippy", ["src/a.ts"], "2026-10-05T00:01:00.000Z"],
      ["testy", [], undefined],
    ]);
    expect("endedAt" in input.forks[0]!).toBe(false);
  });
});

describe("POST /tasks/:id/judge", () => {
  it("starts a judge instance and returns 202", async () => {
    const { env, JUDGE } = fakeEnv();
    const response = await handleJudge(post(), env, ID);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: judgeInstanceId(ID), status: "queued" });
    expect(response.headers.get("location")).toBe(`/tasks/${ID}/judge`);
    expect(JUDGE.create).toHaveBeenCalledWith({ id: judgeInstanceId(ID), params: judgeInput(task(), board()) });
  });

  it("returns 404 for an unknown task", async () => {
    const { env, JUDGE } = fakeEnv({ state: null });
    expect((await handleJudge(post(), env, ID)).status).toBe(404);
    expect(JUDGE.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the task is not finished", async () => {
    const { env, JUDGE } = fakeEnv({ state: task("running") });
    const response = await handleJudge(post(), env, ID);
    expect(response.status).toBe(409);
    expect(JUDGE.create).not.toHaveBeenCalled();
  });

  it("returns 409 with the instance status when one exists", async () => {
    const { env, JUDGE } = fakeEnv({ instance: { status: "running" } });
    const response = await handleJudge(post(), env, ID);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ id: judgeInstanceId(ID), status: "running" });
    expect(JUDGE.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the room starts the judge between the lookup and the create", async () => {
    const { env, JUDGE } = fakeEnv({ createError: new Error("instance.already_exists"), raceStatus: "running" });
    const response = await handleJudge(post(), env, ID);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ id: judgeInstanceId(ID), status: "running" });
    expect(JUDGE.create).toHaveBeenCalledTimes(1);
    expect(JUDGE.get).toHaveBeenCalledTimes(2);
  });

  it("rethrows a create error when no instance exists after it", async () => {
    const error = new Error("workflows down");
    const { env } = fakeEnv({ createError: error });
    await expect(handleJudge(post(), env, ID)).rejects.toBe(error);
  });
});

describe("GET /tasks/:id/judge", () => {
  it("returns the status and output", async () => {
    const output = { winner: "ponder", why: "Winner: ponder (90/100)" };
    const { env, JUDGE } = fakeEnv({ instance: { status: "complete", output } });
    const response = await handleJudge(new Request(URL_), env, ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: judgeInstanceId(ID), status: "complete", output });
    expect(JUDGE.get).toHaveBeenCalledWith(judgeInstanceId(ID));
  });

  it("returns the ship result in the output", async () => {
    const ship = { status: "merged", winner: "ponder", commit: "abc123", locks: [{ agent: "ponder", fork: `${ID}-ponder`, revoked: 1 }] };
    const output = { winner: "ponder", why: "Winner: ponder (90/100)", ship };
    const { env } = fakeEnv({ instance: { status: "complete", output } });
    const response = await handleJudge(new Request(URL_), env, ID);
    expect(await response.json()).toMatchObject({ status: "complete", output: { ship: { status: "merged", commit: "abc123" } } });
  });

  it("returns 404 when no judge was started", async () => {
    const { env } = fakeEnv();
    const response = await handleJudge(new Request(URL_), env, ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not judged yet" });
  });

  it("allows only GET and POST", async () => {
    const { env } = fakeEnv();
    const response = await handleJudge(new Request(URL_, { method: "DELETE" }), env, ID);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});
