import { describe, expect, it } from "vitest";

import {
  parsePlay,
  PLAY_AGENTS,
  PLAY_DAILY_DEFAULT,
  PLAY_PER_IP,
  PLAY_PROMPT_MAX,
  PLAY_PROMPT_MIN,
  PLAY_TEMPLATES,
  playDailyLimit,
  quotaView,
  takeQuota,
  utcDay,
  type QuotaState,
} from "../src/play/play";

const prompt = "Fix the off-by-one bug in the list";

describe("parsePlay", () => {
  it("X5: parsePlay accepts a demo template and trims the prompt; rejects other templates, short/long prompts and non-objects with 400; and a wrong or missing invite with 403 only when an invite is set", () => {
    expect(PLAY_TEMPLATES).toEqual(["thunderdome-bugs", "thunderdome-ui", "thunderdome-clash", "thunderdome-fusion"]);
    expect([PLAY_PROMPT_MIN, PLAY_PROMPT_MAX, PLAY_AGENTS, PLAY_PER_IP]).toEqual([10, 600, 3, 2]);

    for (const template of PLAY_TEMPLATES) {
      expect(parsePlay({ template, prompt: `  ${prompt}\n` }, "")).toEqual({ template, prompt });
    }
    // Lengths count after trimming, and both ends of the range are allowed.
    expect(parsePlay({ template: "thunderdome-ui", prompt: ` ${"p".repeat(PLAY_PROMPT_MIN)} ` }, "")).toEqual({ template: "thunderdome-ui", prompt: "p".repeat(PLAY_PROMPT_MIN) });
    expect(parsePlay({ template: "thunderdome-ui", prompt: "p".repeat(PLAY_PROMPT_MAX) }, "")).toMatchObject({ prompt: "p".repeat(PLAY_PROMPT_MAX) });
    // An invite is ignored when none is set.
    expect(parsePlay({ template: "thunderdome-bugs", prompt, invite: "anything" }, "")).toEqual({ template: "thunderdome-bugs", prompt });

    const objectError = { error: "Body must be a JSON object", status: 400 };
    for (const body of [null, undefined, [], "text", 3]) expect(parsePlay(body, ""), JSON.stringify(body)).toEqual(objectError);

    const templateError = { error: "template must be one of thunderdome-bugs, thunderdome-ui, thunderdome-clash, thunderdome-fusion", status: 400 };
    for (const template of ["thunderdome-sample", "", undefined, 1, "THUNDERDOME-BUGS"]) {
      expect(parsePlay({ template, prompt }, ""), String(template)).toEqual(templateError);
    }

    const promptError = { error: "prompt must be 10 to 600 characters", status: 400 };
    for (const bad of [undefined, 42, "short", `   ${"p".repeat(PLAY_PROMPT_MIN - 1)}   `, "p".repeat(PLAY_PROMPT_MAX + 1)]) {
      expect(parsePlay({ template: "thunderdome-bugs", prompt: bad }, ""), String(bad)).toEqual(promptError);
    }

    // With an invite set: the right one passes, a wrong or missing one is 403.
    expect(parsePlay({ template: "thunderdome-clash", prompt, invite: "letmein" }, "letmein")).toEqual({ template: "thunderdome-clash", prompt });
    const inviteError = { error: "invite code is wrong", status: 403 };
    expect(parsePlay({ template: "thunderdome-clash", prompt, invite: "nope" }, "letmein")).toEqual(inviteError);
    expect(parsePlay({ template: "thunderdome-clash", prompt }, "letmein")).toEqual(inviteError);
    // Bad input is 400 before the invite is checked.
    expect(parsePlay({ template: "nope", prompt }, "letmein")).toEqual(templateError);
  });
});

describe("takeQuota", () => {
  it("X6: takeQuota counts per day and per IP, resets on a new day, says daily before ip, and never mutates its input; quotaView and playDailyLimit", () => {
    const day = "2026-10-05";

    // Undefined state starts fresh.
    const first = takeQuota(undefined, day, "1.1.1.1", 3);
    expect(first).toEqual({ ok: true, state: { day, used: 1, byIp: { "1.1.1.1": 1 } }, remaining: 2 });
    if (!first.ok) throw new Error("unreachable");

    // The input is never written to.
    const frozen: QuotaState = Object.freeze({ ...first.state, byIp: Object.freeze({ ...first.state.byIp }) });
    const before = structuredClone(frozen);
    const second = takeQuota(frozen, day, "1.1.1.1", 3);
    expect(second).toEqual({ ok: true, state: { day, used: 2, byIp: { "1.1.1.1": 2 } }, remaining: 1 });
    expect(frozen).toEqual(before);
    if (!second.ok) throw new Error("unreachable");
    expect(second.state).not.toBe(frozen);

    // The IP is at its limit (default PLAY_PER_IP = 2); another IP may still play.
    expect(takeQuota(second.state, day, "1.1.1.1", 3)).toEqual({ ok: false, reason: "ip", state: second.state });
    const third = takeQuota(second.state, day, "2.2.2.2", 3);
    expect(third).toEqual({ ok: true, state: { day, used: 3, byIp: { "1.1.1.1": 2, "2.2.2.2": 1 } }, remaining: 0 });
    if (!third.ok) throw new Error("unreachable");

    // The daily limit is checked before the IP limit.
    expect(takeQuota(third.state, day, "1.1.1.1", 3)).toMatchObject({ ok: false, reason: "daily" });
    expect(takeQuota(third.state, day, "3.3.3.3", 3)).toMatchObject({ ok: false, reason: "daily" });

    // A new day starts fresh.
    expect(takeQuota(third.state, "2026-10-06", "1.1.1.1", 3)).toEqual({
      ok: true,
      state: { day: "2026-10-06", used: 1, byIp: { "1.1.1.1": 1 } },
      remaining: 2,
    });

    // A custom per-IP limit.
    const one = takeQuota(undefined, day, "ip", 10, 1);
    if (!one.ok) throw new Error("unreachable");
    expect(takeQuota(one.state, day, "ip", 10, 1)).toMatchObject({ ok: false, reason: "ip" });

    // quotaView: no IPs, used 0 for another day, remaining never below 0.
    expect(quotaView(third.state, day, 3)).toEqual({ day, used: 3, limit: 3, remaining: 0 });
    expect(quotaView(third.state, day, 2)).toEqual({ day, used: 3, limit: 2, remaining: 0 });
    expect(quotaView(third.state, "2026-10-06", 3)).toEqual({ day: "2026-10-06", used: 0, limit: 3, remaining: 3 });
    expect(quotaView(undefined, day, 10)).toEqual({ day, used: 0, limit: 10, remaining: 10 });

    expect(utcDay(new Date("2026-10-05T23:59:59.999Z"))).toBe("2026-10-05");
    expect(utcDay(new Date("2026-10-06T00:00:00.000Z"))).toBe("2026-10-06");

    expect(PLAY_DAILY_DEFAULT).toBe(10);
    expect(playDailyLimit("25")).toBe(25);
    expect(playDailyLimit("1")).toBe(1);
    for (const bad of [undefined, "", "0", "-3", "2.5", " 5", "abc", "1e3", "99999999999999999999"]) {
      expect(playDailyLimit(bad), String(bad)).toBe(10);
    }
  });
});
