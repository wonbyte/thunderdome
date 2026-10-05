import { describe, expect, it, vi } from "vitest";

import type { SavedDiff } from "../src/judge/diffs";
import { claimFiles, emptyBoard, type ClaimBoard, type ClaimResult } from "../src/room/claims";
import { RACE_LIST_LIMIT, summaryOf, type RaceSummary } from "../src/room/races";
import type { CreateTaskResult, LoggedStep, NewTask, RunTaskResult, Task } from "../src/room/task";
import { handlePurge, handleRaceBackfill, handleTasks, isTasksPath } from "../src/routes/tasks";

const readyTask = (input: NewTask): Task => ({
  id: input.id,
  repo: input.repo ?? `${input.template}-${input.id}`,
  prompt: input.prompt,
  status: "ready",
  createdAt: "2026-10-05T00:00:00.000Z",
  agents: (["careful", "fast", "tester"] as const).map((name) => ({ name, fork: `${input.id}-${name}`, remote: `https://git.test/${name}.git`, defaultBranch: "main", status: "idle" as const })),
});

const race = (id: string, createdAt: string): RaceSummary => ({ id, prompt: "p", status: "ready", createdAt, agents: ["careful", "fast", "tester"], clash: false });

interface FakeRoom {
  create?: (input: NewTask) => Promise<CreateTaskResult>;
  state?: () => Promise<Task | null>;
  run?: () => Promise<RunTaskResult>;
  steps?: (after: number, limit: number) => Promise<LoggedStep[]>;
  claim?: (agent: string, files: unknown, shared: boolean) => Promise<ClaimResult>;
  release?: (agent: string, files?: unknown) => Promise<{ ok: true; released: string[] } | { ok: false; status: number; error: string }>;
  claimBoard?: () => Promise<ClaimBoard>;
  fetch?: (request: Request) => Promise<Response>;
  forkDiff?: (agent: string) => Promise<SavedDiff | null>;
  purge?: () => Promise<{ ok: true; deleted: string[] } | { ok: false; error: string }>;
}

// The race index fake: list returns races, record does nothing.
function fakeIndex(races: RaceSummary[] = []) {
  const index = {
    list: vi.fn(async (_limit: number) => races),
    record: vi.fn(async (_summary: RaceSummary) => {}),
    remove: vi.fn(async (_ids: string[]) => {}),
  };
  return { index, RACE_INDEX: { getByName: vi.fn(() => index) } };
}

function fakeEnv(room: FakeRoom, races: RaceSummary[] = []) {
  const stub = {
    create: vi.fn(room.create ?? (async (input: NewTask) => ({ ok: true as const, task: readyTask(input), tokens: { careful: "k1", fast: "k2", tester: "k3" } }))),
    state: vi.fn(room.state ?? (async () => null)),
    run: vi.fn(room.run ?? (async () => ({ ok: false as const, status: 404, error: { error: "not found" } }))),
    steps: vi.fn(room.steps ?? (async () => [])),
    claim: vi.fn(room.claim ?? (async () => ({ ok: true as const, claimed: [], already: [], shared: false }))),
    release: vi.fn(room.release ?? (async () => ({ ok: true as const, released: [] }))),
    claimBoard: vi.fn(room.claimBoard ?? (async () => emptyBoard())),
    // Node cannot build a 101 Response, so the fake room answers with a plain one.
    fetch: vi.fn(room.fetch ?? (async (_request: Request) => new Response("live"))),
    forkDiff: vi.fn(room.forkDiff ?? (async (_agent: string): Promise<SavedDiff | null> => null)),
    purge: vi.fn(room.purge ?? (async () => ({ ok: true as const, deleted: [] as string[] }))),
  };
  const getByName = vi.fn(() => stub);
  const { index, RACE_INDEX } = fakeIndex(races);
  const env = { TASK_ROOM: { getByName }, RACE_INDEX } as unknown as Pick<Env, "TASK_ROOM" | "RACE_INDEX">;
  return { env, stub, getByName, index, indexByName: RACE_INDEX.getByName };
}

function post(body: unknown): Request {
  return new Request("https://thunderdome.test/tasks", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("isTasksPath", () => {
  it("matches only task paths", () => {
    expect(isTasksPath("/tasks")).toBe(true);
    expect(isTasksPath("/tasks/t-0123abcd")).toBe(true);
    expect(isTasksPath("/tasks/t-0123abcd/live")).toBe(true);
    expect(isTasksPath("/tasksx")).toBe(false);
  });
});

describe("POST /tasks", () => {
  it("creates a task and returns 1 token per agent", async () => {
    const { env, stub, getByName } = fakeEnv({});
    const response = await handleTasks(post({ repo: "thunderdome-sample", prompt: "Add /health", agents: 3 }), env);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Omit<Task, "agents"> & { agents: { token: string }[] };
    expect(body.agents.map((agent) => agent.token)).toEqual(["k1", "k2", "k3"]);
    expect(response.headers.get("location")).toBe(`/tasks/${body.id}`);
    expect(getByName).toHaveBeenCalledWith(body.id);
    expect(stub.create).toHaveBeenCalledWith({ id: body.id, repo: "thunderdome-sample", prompt: "Add /health", agents: 3 });
  });

  it("rejects a bad body without making a room", async () => {
    const { env, getByName } = fakeEnv({});
    expect((await handleTasks(post("{"), env)).status).toBe(400);
    const response = await handleTasks(post({ repo: "thunderdome-sample", prompt: "x", agents: 9 }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "agents must be an integer from 3 to 5" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("passes the room's failure status through", async () => {
    const { env } = fakeEnv({ create: async () => ({ ok: false, status: 404, error: { error: "Repo not found: nope", code: "NOT_FOUND" } }) });
    const response = await handleTasks(post({ repo: "nope", prompt: "x" }), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Repo not found: nope", code: "NOT_FOUND" });
  });

  it("allows only GET and POST on /tasks", async () => {
    const { env } = fakeEnv({});
    const response = await handleTasks(new Request("https://thunderdome.test/tasks", { method: "PUT" }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});

describe("GET /tasks", () => {
  it("L4: GET /tasks returns the index list (at most 50), and POST /tasks still creates a task", async () => {
    const races = [race("t-00000002", "2026-10-05T00:02:00.000Z"), race("t-00000001", "2026-10-05T00:01:00.000Z")];
    const { env, index, indexByName, stub } = fakeEnv({}, races);
    const response = await handleTasks(new Request("https://thunderdome.test/tasks"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ races });
    expect(RACE_LIST_LIMIT).toBe(50);
    expect(index.list).toHaveBeenCalledWith(50);
    expect(indexByName).toHaveBeenCalledWith("all");
    expect(stub.create).not.toHaveBeenCalled();

    const created = await handleTasks(post({ repo: "thunderdome-sample", prompt: "Add /health", agents: 3 }), env);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { agents: { token: string }[] };
    expect(body.agents.map((agent) => agent.token)).toEqual(["k1", "k2", "k3"]);
    expect(index.list).toHaveBeenCalledTimes(1);
  });
});

describe("POST /admin/races", () => {
  const known = "t-0000000a";
  const unknown = "t-0000000b";
  const backfill = (body: unknown) =>
    new Request("https://thunderdome.test/admin/races", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

  function backfillEnv() {
    const task: Task = { ...readyTask({ id: known, repo: "thunderdome-sample", prompt: "p", agents: 3 }), status: "running", startedAt: "2026-10-05T00:01:00.000Z" };
    const board = emptyBoard();
    claimFiles(board, "careful", ["src/text.ts"], false, "now");
    claimFiles(board, "fast", ["src/text.ts"], false, "now");
    const knownRoom = { state: vi.fn(async () => task), claimBoard: vi.fn(async () => board) };
    const unknownRoom = { state: vi.fn(async () => null), claimBoard: vi.fn(async () => emptyBoard()) };
    const getByName = vi.fn((id: string) => (id === known ? knownRoom : unknownRoom));
    const { index, RACE_INDEX } = fakeIndex();
    const env = { TASK_ROOM: { getByName }, RACE_INDEX } as unknown as Pick<Env, "TASK_ROOM" | "RACE_INDEX">;
    return { env, task, board, index, indexByName: RACE_INDEX.getByName, unknownRoom };
  }

  it("L5: POST /admin/races records existing races, lists missing ids, and rejects a bad body with 400", async () => {
    const { env, task, board, index, indexByName, unknownRoom } = backfillEnv();
    const response = await handleRaceBackfill(backfill({ ids: [known, unknown] }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: [known], missing: [unknown] });
    expect(index.record).toHaveBeenCalledTimes(1);
    expect(index.record).toHaveBeenCalledWith(summaryOf(task, board.history));
    expect(index.record.mock.calls[0]?.[0].clash).toBe(true);
    expect(indexByName).toHaveBeenCalledWith("all");
    expect(unknownRoom.claimBoard).not.toHaveBeenCalled();

    const fresh = backfillEnv();
    const tooMany = Array.from({ length: 51 }, (_, i) => `t-${i.toString(16).padStart(8, "0")}`);
    for (const body of ["{", {}, { ids: [] }, { ids: ["nope"] }, { ids: [1] }, { ids: tooMany }]) {
      const bad = await handleRaceBackfill(backfill(body), fresh.env);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "Body must be { ids: 1..50 task ids }" });
    }
    expect(fresh.index.record).not.toHaveBeenCalled();
  });
});

describe("GET /tasks/:id", () => {
  it("returns the task state", async () => {
    const task = readyTask({ id: "t-0123abcd", repo: "thunderdome-sample", prompt: "p", agents: 3 });
    const { env, getByName } = fakeEnv({ state: async () => task });
    const response = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(task);
    expect(getByName).toHaveBeenCalledWith("t-0123abcd");
  });

  it("returns the verdict once it is saved", async () => {
    const task: Task = {
      ...readyTask({ id: "t-0123abcd", repo: "thunderdome-sample", prompt: "p", agents: 3 }),
      status: "finished",
      verdict: {
        winner: "careful",
        why: "Winner: careful (90/100)",
        judgedAt: "2026-10-05T00:10:00.000Z",
        ship: { status: "merged", winner: "careful", commit: "abc123", locks: [{ agent: "careful", fork: "t-0123abcd-careful", revoked: 1 }] },
      },
    };
    const { env } = fakeEnv({ state: async () => task });
    const response = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verdict: { winner: "careful", ship: { status: "merged", commit: "abc123" } } });
  });

  it("returns 404 for an unknown or malformed id", async () => {
    const { env, getByName } = fakeEnv({});
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd"), env)).status).toBe(404);
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/nope"), env)).status).toBe(404);
    expect(getByName).toHaveBeenCalledTimes(1);
  });
});

describe("POST /tasks/:id/run", () => {
  it("starts the agents and returns 202", async () => {
    const task = { ...readyTask({ id: "t-0123abcd", repo: "thunderdome-sample", prompt: "p", agents: 3 }), status: "running" as const };
    const { env, stub } = fakeEnv({ run: async () => ({ ok: true, task }) });
    const response = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/run", { method: "POST" }), env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(task);
    expect(stub.run).toHaveBeenCalledTimes(1);
  });

  it("passes a conflict through", async () => {
    const { env } = fakeEnv({ run: async () => ({ ok: false, status: 409, error: { error: "Task is running; only a ready task can run" } }) });
    const response = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/run", { method: "POST" }), env);
    expect(response.status).toBe(409);
  });

  it("allows only POST", async () => {
    const { env } = fakeEnv({});
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/run"), env)).status).toBe(405);
  });
});

describe("GET /tasks/:id/live", () => {
  const live = (init?: RequestInit) => new Request("https://thunderdome.test/tasks/t-0123abcd/live", init);

  it("hands a WebSocket upgrade to the task's room", async () => {
    const { env, stub, getByName } = fakeEnv({});
    const request = live({ headers: { upgrade: "WebSocket" } });
    const response = await handleTasks(request, env);
    expect(await response.text()).toBe("live");
    expect(getByName).toHaveBeenCalledWith("t-0123abcd");
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(stub.fetch).toHaveBeenCalledWith(request);
  });

  it("returns 426 without Upgrade: websocket and never calls the room", async () => {
    const { env, stub } = fakeEnv({});
    for (const request of [live(), live({ headers: { upgrade: "h2c" } })]) {
      const response = await handleTasks(request, env);
      expect(response.status).toBe(426);
      expect(response.headers.get("upgrade")).toBe("websocket");
      expect(await response.json()).toEqual({ error: "Expected Upgrade: websocket" });
    }
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("allows only GET", async () => {
    const { env, stub } = fakeEnv({});
    const response = await handleTasks(live({ method: "POST", headers: { upgrade: "websocket" } }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed id or extra path", async () => {
    const { env, stub } = fakeEnv({});
    const headers = { upgrade: "websocket" };
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/nope/live", { headers }), env)).status).toBe(404);
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/live/x", { headers }), env)).status).toBe(404);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /tasks/:id/steps", () => {
  const step = (seq: number): LoggedStep => ({ seq, agent: "fast", at: "2026-10-05T00:00:00.000Z", kind: "tool", text: "Bash npm test" });

  it("pages by seq", async () => {
    const { env, stub } = fakeEnv({ steps: async () => [step(4), step(5)] });
    const response = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/steps?after=3&limit=2"), env);
    expect(await response.json()).toEqual({ steps: [step(4), step(5)], next: 5 });
    expect(stub.steps).toHaveBeenCalledWith(3, 2);
  });

  it("keeps the cursor when there is nothing new, and ignores bad numbers", async () => {
    const { env, stub } = fakeEnv({});
    const response = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/steps?after=x&limit=-1"), env);
    expect(await response.json()).toEqual({ steps: [], next: 0 });
    expect(stub.steps).toHaveBeenCalledWith(0, 200);
  });
});

describe("GET /tasks/:id/forks/:agent/diff", () => {
  const diffUrl = (path: string) => `https://thunderdome.test/tasks/${path}`;

  it("X8: GET /tasks/:id/forks/:agent/diff returns the saved diff and 404 without one", async () => {
    const saved: SavedDiff = { diff: "diff --git a/src/text.ts b/src/text.ts\n+fixed\n", clipped: true };
    const { env, stub, getByName } = fakeEnv({ forkDiff: async (agent) => (agent === "fast" ? saved : null) });

    const found = await handleTasks(new Request(diffUrl("t-0123abcd/forks/fast/diff")), env);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ agent: "fast", diff: saved.diff, clipped: true });
    expect(getByName).toHaveBeenCalledWith("t-0123abcd");
    expect(stub.forkDiff).toHaveBeenCalledWith("fast");

    const missing = await handleTasks(new Request(diffUrl("t-0123abcd/forks/careful/diff")), env);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });

    // A bad agent name, a bad id or a near path is 404 without asking the room.
    stub.forkDiff.mockClear();
    for (const path of ["t-0123abcd/forks/Bad1/diff", "t-0123abcd/forks/fast/diff/x", "t-0123abcd/forks/fast", "t-0123abcd/forks", "nope/forks/fast/diff"]) {
      expect((await handleTasks(new Request(diffUrl(path)), env)).status).toBe(404);
    }
    expect(stub.forkDiff).not.toHaveBeenCalled();

    const wrong = await handleTasks(new Request(diffUrl("t-0123abcd/forks/fast/diff"), { method: "POST" }), env);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    expect(stub.forkDiff).not.toHaveBeenCalled();
  });
});

describe("unknown task paths", () => {
  it("return 404", async () => {
    const { env } = fakeEnv({});
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/nope"), env)).status).toBe(404);
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/run/x", { method: "POST" }), env)).status).toBe(404);
  });
});

describe("claim routes", () => {
  const post = (path: string, body: unknown) => new Request(`https://thunderdome.test/tasks/t-0123abcd/${path}`, { method: "POST", body: JSON.stringify(body) });

  it("gives agent B a shared claim and the clash on a file agent A holds", async () => {
    const board = emptyBoard();
    const { env } = fakeEnv({ claim: async (agent, files, shared) => claimFiles(board, agent, files as string[], shared, "now") });
    expect((await handleTasks(post("claims", { agent: "careful", files: ["src/text.ts"] }), env)).status).toBe(200);
    const response = await handleTasks(post("claims", { agent: "fast", files: ["src/text.ts"] }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ shared: ["src/text.ts"], clashes: [{ file: "src/text.ts", heldBy: ["careful"] }] });
  });

  it("passes shared and checks the body", async () => {
    const { env, stub } = fakeEnv({});
    await handleTasks(post("claims", { agent: "fast", files: ["a.ts"], shared: true }), env);
    expect(stub.claim).toHaveBeenCalledWith("fast", ["a.ts"], true);
    expect((await handleTasks(post("claims", { files: ["a.ts"] }), env)).status).toBe(400);
    expect((await handleTasks(post("claims", [1]), env)).status).toBe(400);
  });

  it("returns the board and releases files", async () => {
    const { env, stub } = fakeEnv({});
    const board = await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/claims"), env);
    expect(await board.json()).toEqual({ active: [], history: [] });
    expect((await handleTasks(post("release", { agent: "fast" }), env)).status).toBe(200);
    expect(stub.release).toHaveBeenCalledWith("fast", undefined);
    expect((await handleTasks(post("release", {}), env)).status).toBe(400);
    expect((await handleTasks(new Request("https://thunderdome.test/tasks/t-0123abcd/release"), env)).status).toBe(405);
  });
});

describe("POST /admin/purge", () => {
  const purge = (body?: unknown) =>
    new Request("https://thunderdome.test/admin/purge", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const race = (id: string) => ({ id, prompt: "p", status: "finished", createdAt: "2026-10-05T00:00:00Z", agents: [], clash: false }) as RaceSummary;

  it("purges every listed race with no body, drops only the purged ones from the list, and reports the skipped", async () => {
    let call = 0;
    const { env, index } = fakeEnv(
      {
        purge: async () => (++call === 2 ? { ok: false as const, error: "Task is running" } : { ok: true as const, deleted: [`fork-${call}`] }),
      },
      [race("t-00000001"), race("t-00000002"), race("t-00000003")],
    );
    const response = await handlePurge(purge(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      purged: [{ id: "t-00000001", deleted: ["fork-1"] }, { id: "t-00000003", deleted: ["fork-3"] }],
      skipped: [{ id: "t-00000002", error: "Task is running" }],
    });
    expect(index.remove).toHaveBeenCalledWith(["t-00000001", "t-00000003"]);
  });

  it("purges only the given ids, and rejects bad ids with 400", async () => {
    const { env, getByName, index } = fakeEnv({}, [race("t-00000001")]);
    await handlePurge(purge({ ids: ["t-0000000a"] }), env);
    expect(getByName).toHaveBeenCalledWith("t-0000000a");
    expect(index.list).not.toHaveBeenCalled();
    expect((await handlePurge(purge({ ids: ["nope"] }), env)).status).toBe(400);
  });
});
