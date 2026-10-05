import { describe, expect, it, vi } from "vitest";

import { keyShape, modelCheck } from "../src/routes/admin";

describe("keyShape", () => {
  it("shows the key type and length, never the key", () => {
    const key = `sk-ant-api03-${"x".repeat(20)}`;
    expect(keyShape(key)).toEqual({ kind: "sk-ant-api", length: key.length, trimmed: false });
    expect(keyShape(" sk-ant-oat01-abc\n")).toEqual({ kind: "sk-ant-oat", length: 16, trimmed: true });
    expect(keyShape(undefined)).toEqual({ kind: "missing", length: 0, trimmed: false });
    expect(keyShape("hello")).toMatchObject({ kind: "unknown" });
  });
});

describe("modelCheck", () => {
  it("calls the model API with the trimmed key", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const response = await modelCheck({ ANTHROPIC_API_KEY: "sk-ant-api03-abc\n" }, fetcher as unknown as typeof fetch);
    expect(await response.json()).toMatchObject({ ok: true, status: 200, key: { kind: "sk-ant-api", trimmed: true } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.hostname).toBe("api.anthropic.com");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant-api03-abc" });
  });

  it("reports the API's refusal without the key", async () => {
    const fetcher = vi.fn(async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 }));
    const body = await (await modelCheck({ ANTHROPIC_API_KEY: "sk-ant-api03-secret" }, fetcher as unknown as typeof fetch)).json();
    expect(body).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("says when the key is missing", async () => {
    const body = await (await modelCheck({ ANTHROPIC_API_KEY: "" })).json();
    expect(body).toMatchObject({ ok: false, key: { kind: "missing" } });
  });
});
