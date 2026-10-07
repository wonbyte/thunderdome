import { describe, expect, it, vi } from "vitest";

import { utcDay, type QuotaTaken, type QuotaView } from "../src/play/play";
import type { CreateTaskResult, NewTask, RunTaskResult, Task } from "../src/room/task";
import { handlePlay, isPlayPath, PLAY_QUOTA_NAME, type PlayEnv } from "../src/routes/play";

const readyTask = (input: NewTask): Task => ({
  id: input.id,
  repo: `${input.template}-${input.id}`,
  template: input.template,
  prompt: input.prompt,
  status: "ready",
  createdAt: "2026-10-05T00:00:00.000Z",
  agents: (["ponder", "zippy", "testy"] as const).map((name) => ({ name, fork: `${input.id}-${name}`, remote: `https://git.test/${name}.git`, defaultBranch: "main", status: "idle" as const })),
});

interface Fakes {
  take?: (day: string, ip: string, daily: number) => Promise<QuotaTaken>;
  view?: (day: string, daily: number) => Promise<QuotaView>;
  create?: (input: NewTask) => Promise<CreateTaskResult>;
  run?: () => Promise<RunTaskResult>;
  invite?: string;
  limit?: string;
}

// Inline fakes for PLAY_QUOTA and TASK_ROOM. create hands out tokens that must never reach a response.
function fakeEnv(fakes: Fakes = {}) {
  const created: Task[] = [];
  const quota = {
    take: vi.fn(fakes.take ?? (async (): Promise<QuotaTaken> => ({ ok: true, remaining: 7 }))),
    view: vi.fn(fakes.view ?? (async (day: string, daily: number): Promise<QuotaView> => ({ day, used: 3, limit: daily, remaining: daily - 3 }))),
  };
  const room = {
    create: vi.fn(
      fakes.create ??
        (async (input: NewTask): Promise<CreateTaskResult> => {
          const task = readyTask(input);
          created.push(task);
          return { ok: true, task, tokens: { ponder: "secret-k1", zippy: "secret-k2", testy: "secret-k3" } };
        }),
    ),
    run: vi.fn(fakes.run ?? (async (): Promise<RunTaskResult> => ({ ok: true, task: { ...created[0]!, status: "running" } }))),
  };
  const quotaByName = vi.fn(() => quota);
  const roomByName = vi.fn(() => room);
  const env = {
    PLAY_QUOTA: { getByName: quotaByName },
    TASK_ROOM: { getByName: roomByName },
    ...(fakes.invite === undefined ? {} : { PLAY_INVITE: fakes.invite }),
    ...(fakes.limit === undefined ? {} : { PLAY_DAILY_LIMIT: fakes.limit }),
  } as unknown as PlayEnv;
  return { env, quota, room, quotaByName, roomByName };
}

function play(body: unknown, ip?: string): Request {
  return new Request("https://thunderdome.test/play", {
    method: "POST",
    headers: ip === undefined ? {} : { "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const good = { template: "thunderdome-bugs", prompt: "  Fix the failing tests please  " };

describe("isPlayPath", () => {
  it("matches only the play paths", () => {
    expect(isPlayPath("/play")).toBe(true);
    expect(isPlayPath("/play/quota")).toBe(true);
    expect(isPlayPath("/play/")).toBe(false);
    expect(isPlayPath("/play.html")).toBe(false);
  });
});

describe("play routes", () => {
  it("X9: POST /play creates and runs a 5-agent task and returns 202 without tokens; 429 when the quota is used up; 400/403 from parsePlay; GET /play/quota returns the view and the invite flag", async () => {
    // 202: create then run, the trimmed prompt, 3 agents, no tokens.
    const ok = fakeEnv();
    const response = await handlePlay(play(good, "203.0.113.9"), ok.env);
    expect(response.status).toBe(202);
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
    const body = JSON.parse(text) as { id: string; page: string; remaining: number };
    expect(body).toEqual({ id: body.id, page: `/race/${body.id}`, remaining: 7 });
    expect(Object.keys(body).toSorted()).toEqual(["id", "page", "remaining"]);
    expect(ok.quotaByName).toHaveBeenCalledWith(PLAY_QUOTA_NAME);
    expect(PLAY_QUOTA_NAME).toBe("daily");
    expect(ok.quota.take).toHaveBeenCalledWith(utcDay(new Date()), "203.0.113.9", 10);
    expect(ok.roomByName).toHaveBeenCalledWith(body.id);
    expect(ok.room.create).toHaveBeenCalledWith({ id: body.id, template: "thunderdome-bugs", prompt: "Fix the failing tests please", agents: 5 });
    expect(ok.room.run).toHaveBeenCalledTimes(1);
    expect(ok.room.create.mock.invocationCallOrder[0]!).toBeLessThan(ok.room.run.mock.invocationCallOrder[0]!);

    // No CF-Connecting-IP: "unknown". PLAY_DAILY_LIMIT is passed through playDailyLimit.
    const noIp = fakeEnv({ limit: "4" });
    expect((await handlePlay(play(good), noIp.env)).status).toBe(202);
    expect(noIp.quota.take).toHaveBeenCalledWith(utcDay(new Date()), "unknown", 4);

    // 429 for each reason, and nothing is created.
    for (const reason of ["daily", "ip"] as const) {
      const used = fakeEnv({ take: async () => ({ ok: false, reason }) });
      const refused = await handlePlay(play(good, "203.0.113.9"), used.env);
      expect(refused.status).toBe(429);
      const error = reason === "daily" ? "Today's play quota is used up" : "This IP has used its plays for today";
      expect(await refused.json()).toEqual({ error, reason });
      expect(used.room.create).not.toHaveBeenCalled();
      expect(used.roomByName).not.toHaveBeenCalled();
    }

    // 400 from parsePlay: no quota taken, nothing created.
    const bad = fakeEnv();
    for (const input of ["{", [1], { template: "thunderdome-sample", prompt: good.prompt }, { template: "thunderdome-ui", prompt: "short" }]) {
      const rejected = await handlePlay(play(input), bad.env);
      expect(rejected.status).toBe(400);
      expect(Object.keys((await rejected.json()))).toEqual(["error"]);
    }
    expect(bad.quota.take).not.toHaveBeenCalled();
    expect(bad.room.create).not.toHaveBeenCalled();

    // 403 only when an invite code is set.
    const invited = fakeEnv({ invite: "letmein" });
    for (const input of [good, { ...good, invite: "nope" }]) {
      const forbidden = await handlePlay(play(input), invited.env);
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({ error: "invite code is wrong" });
    }
    expect(invited.quota.take).not.toHaveBeenCalled();
    expect(invited.room.create).not.toHaveBeenCalled();
    expect((await handlePlay(play({ ...good, invite: "letmein" }), invited.env)).status).toBe(202);

    // A failed create or run passes its status and error through.
    const failed = fakeEnv({ create: async () => ({ ok: false, status: 502, error: { error: "fork failed", code: "INTERNAL" } }) });
    const broken = await handlePlay(play(good), failed.env);
    expect(broken.status).toBe(502);
    expect(await broken.json()).toEqual({ error: "fork failed", code: "INTERNAL" });
    expect(failed.room.run).not.toHaveBeenCalled();
    const stuck = fakeEnv({ run: async () => ({ ok: false, status: 409, error: { error: "Task is running; only a ready task can run" } }) });
    expect((await handlePlay(play(good), stuck.env)).status).toBe(409);

    // GET /play/quota: the view plus the invite flag.
    const open = fakeEnv();
    const view = await handlePlay(new Request("https://thunderdome.test/play/quota"), open.env);
    expect(view.status).toBe(200);
    const day = utcDay(new Date());
    expect(await view.json()).toEqual({ day, used: 3, limit: 10, remaining: 7, invite: false });
    expect(open.quota.view).toHaveBeenCalledWith(day, 10);
    expect(open.quotaByName).toHaveBeenCalledWith("daily");
    const gated = await handlePlay(new Request("https://thunderdome.test/play/quota"), fakeEnv({ invite: "letmein" }).env);
    expect(await gated.json()).toMatchObject({ invite: true });

    // Wrong methods.
    const methods = fakeEnv();
    const putPlay = await handlePlay(new Request("https://thunderdome.test/play", { method: "PUT" }), methods.env);
    expect(putPlay.status).toBe(405);
    expect(putPlay.headers.get("allow")).toBe("POST");
    const postQuota = await handlePlay(new Request("https://thunderdome.test/play/quota", { method: "POST" }), methods.env);
    expect(postQuota.status).toBe(405);
    expect(postQuota.headers.get("allow")).toBe("GET");
    expect(methods.quota.take).not.toHaveBeenCalled();
  });
});
