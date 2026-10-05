import { describe, expect, it } from "vitest";

import { AGENT_NAMES, type AgentName } from "../src/agents/prompt";
import { forkName } from "../src/artifacts/repo";
import {
  MAX_PREVIEW_NAME_LENGTH,
  PREVIEW_MAIN,
  PUSH_REF,
  basePreviewName,
  parseBaseRequest,
  parseForkName,
  parsePushEvent,
  previewConfig,
  previewName,
  previewUrl,
} from "../src/push/push";

const TASK = "t-0123abcd";
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);

function pushEvent(overrides: { source?: Record<string, unknown>; payload?: Record<string, unknown>; type?: string } = {}): unknown {
  return {
    type: overrides.type ?? "cf.artifacts.repo.pushed",
    source: { namespace: "thunderdome", repoName: `${TASK}-fast`, ...overrides.source },
    payload: {
      ref: "refs/heads/main",
      before: OLDER,
      after: HEAD,
      commits: [
        { id: OLDER, message: "first step" },
        { id: HEAD, message: "  fix   the\nparser  " },
      ],
      totalCommitsCount: 2,
      ...overrides.payload,
    },
  };
}

describe("parsePushEvent", () => {
  it("R3: a push event to a task fork names its task and agent; the source repo, other namespaces and other branches are ignored", () => {
    expect(parsePushEvent(pushEvent())).toEqual({
      taskId: TASK,
      agent: "fast",
      fork: `${TASK}-fast`,
      ref: PUSH_REF,
      after: HEAD,
      commits: 2,
      message: "fix the parser",
    });
    // The source repo and non-fork names.
    expect(parsePushEvent(pushEvent({ source: { repoName: "thunderdome-sample" } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ source: { repoName: `${TASK}-boss` } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ source: { repoName: "t-xyz-fast" } }))).toBeUndefined();
    // Other namespaces, unless asked for.
    expect(parsePushEvent(pushEvent({ source: { namespace: "other" } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ source: { namespace: "other" } }), "other")?.agent).toBe("fast");
    // Other branches and tags.
    expect(parsePushEvent(pushEvent({ payload: { ref: "refs/heads/dev" } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { ref: "refs/tags/main" } }))).toBeUndefined();
    // Other event types.
    expect(parsePushEvent(pushEvent({ type: "cf.artifacts.repo.forked" }))).toBeUndefined();
  });

  it("ignores a branch delete and bad heads", () => {
    expect(parsePushEvent(pushEvent({ payload: { after: "0".repeat(40) } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { after: "A".repeat(40) } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { after: "a".repeat(39) } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { after: 42 } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { after: "c".repeat(64), commits: [] } }))?.after).toBe("c".repeat(64));
  });

  it("never throws on bad input", () => {
    for (const bad of [undefined, null, 1, "x", [], {}, { type: "cf.artifacts.repo.pushed" }, { type: "cf.artifacts.repo.pushed", source: [], payload: {} }]) {
      expect(parsePushEvent(bad)).toBeUndefined();
    }
    expect(parsePushEvent(pushEvent({ source: { repoName: 7 } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { commits: "nope" } }))).toBeUndefined();
    expect(parsePushEvent(pushEvent({ payload: { commits: [null] } }))).toBeUndefined();
  });

  it("counts commits from totalCommitsCount, else the list", () => {
    expect(parsePushEvent(pushEvent({ payload: { totalCommitsCount: 25 } }))?.commits).toBe(25);
    expect(parsePushEvent(pushEvent({ payload: { totalCommitsCount: -1 } }))?.commits).toBe(2);
    expect(parsePushEvent(pushEvent({ payload: { totalCommitsCount: 1.5 } }))?.commits).toBe(2);
    expect(parsePushEvent(pushEvent({ payload: { commits: undefined, totalCommitsCount: 3 } }))).toMatchObject({ commits: 3 });
    expect(parsePushEvent(pushEvent({ payload: { commits: undefined, totalCommitsCount: "3" } }))).toBeUndefined();
  });

  it("takes the message of the head commit, else the last entry, clipped", () => {
    const reversed = [
      { hash: HEAD, message: "head" },
      { sha: OLDER, message: "older" },
    ];
    expect(parsePushEvent(pushEvent({ payload: { commits: reversed } }))?.message).toBe("head");
    expect(parsePushEvent(pushEvent({ payload: { commits: [{ id: "x", message: "last" }] } }))?.message).toBe("last");
    expect(parsePushEvent(pushEvent({ payload: { commits: [{ id: HEAD, message: 5 }] } }))).not.toHaveProperty("message");
    expect(parsePushEvent(pushEvent({ payload: { commits: [] } }))).not.toHaveProperty("message");
    expect(parsePushEvent(pushEvent({ payload: { commits: [{ id: HEAD, message: "m".repeat(900) }] } }))?.message).toHaveLength(500);
  });
});

describe("parseForkName", () => {
  it("inverts forkName for every agent", () => {
    for (const agent of AGENT_NAMES) {
      expect(parseForkName(forkName(TASK, agent))).toEqual({ taskId: TASK, agent });
    }
    expect(parseForkName("thunderdome-sample")).toBeUndefined();
    expect(parseForkName("careful")).toBeUndefined();
    expect(parseForkName(`${TASK}-careful-x`)).toBeUndefined();
  });
});

describe("previewName", () => {
  it("R4: the preview name is DNS-safe, stable for a task and agent, and short enough for the preview hostname", () => {
    const worker = "x".repeat(30);
    for (const agent of AGENT_NAMES) {
      const name = previewName("t-ffffffff", agent);
      expect(name).toBe(`t-ffffffff-${agent}`);
      expect(name).toBe(previewName("t-ffffffff", agent));
      expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
      expect(name.length).toBeLessThanOrEqual(MAX_PREVIEW_NAME_LENGTH);
      expect(`${name}-${worker}`.length).toBeLessThanOrEqual(63);
    }
    expect(previewName(TASK, "fast")).not.toBe(previewName(TASK, "lean"));
    expect(() => previewName("T-0123ABCD", "fast")).toThrow();
    expect(() => previewName("thunderdome-sample", "fast")).toThrow();
    expect(() => previewName(TASK, "Boss" as AgentName)).toThrow();
  });
});

describe("basePreviewName", () => {
  it("B1: the base preview name is <taskId>-base, a DNS label within the length limit, and a bad task id throws", () => {
    const name = basePreviewName("t-ffffffff");
    expect(name).toBe("t-ffffffff-base");
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(MAX_PREVIEW_NAME_LENGTH);
    expect(`${name}-${"x".repeat(30)}`.length).toBeLessThanOrEqual(63);
    for (const agent of AGENT_NAMES) {
      expect(name).not.toBe(previewName("t-ffffffff", agent));
    }
    expect(() => basePreviewName("T-0123ABCD")).toThrow();
    expect(() => basePreviewName("thunderdome-sample")).toThrow();
  });
});

describe("parseBaseRequest", () => {
  const request = { kind: "base", taskId: TASK, repo: "thunderdome-sample", commit: HEAD };

  it("B2: the base request parser accepts { kind: \"base\", taskId, repo, commit } with a valid id, repo name and commit, and rejects anything else; the push event parser ignores a base request and the base parser ignores a push event", () => {
    expect(parseBaseRequest(request)).toEqual(request);
    expect(parseBaseRequest({ ...request, commit: "c".repeat(64) })?.commit).toBe("c".repeat(64));
    // Extra keys are dropped.
    expect(parseBaseRequest({ ...request, extra: 1 })).toEqual(request);
    // Wrong or missing kind.
    expect(parseBaseRequest({ ...request, kind: "push" })).toBeUndefined();
    expect(parseBaseRequest({ taskId: TASK, repo: "thunderdome-sample", commit: HEAD })).toBeUndefined();
    // Bad task ids.
    for (const taskId of ["T-0123ABCD", "thunderdome-sample", 7]) {
      expect(parseBaseRequest({ ...request, taskId })).toBeUndefined();
    }
    // Bad repo names.
    for (const repo of ["a/b", "", "r".repeat(101), undefined]) {
      expect(parseBaseRequest({ ...request, repo })).toBeUndefined();
    }
    // Bad commits.
    for (const commit of ["0".repeat(40), "A".repeat(40), "a".repeat(39), 42]) {
      expect(parseBaseRequest({ ...request, commit })).toBeUndefined();
    }
    // Non-records.
    for (const bad of [undefined, null, [], "x"]) {
      expect(parseBaseRequest(bad)).toBeUndefined();
    }
    // Each parser ignores the other's input.
    expect(parsePushEvent(request)).toBeUndefined();
    expect(parseBaseRequest(pushEvent())).toBeUndefined();
  });
});

describe("previewConfig", () => {
  it("writes Thunderdome's preview config as JSON", () => {
    const text = previewConfig("thunderdome-sample", "2026-10-01");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ name: "thunderdome-sample", main: PREVIEW_MAIN, compatibility_date: "2026-10-01", previews: {} });
    expect(PREVIEW_MAIN).toBe("repo/src/index.ts");
  });
});

describe("previewUrl", () => {
  it("R5: the preview URL is read from wrangler's JSON output, and bad output gives none", () => {
    const url = "https://t-0123abcd-fast-thunderdome-sample.acct.workers.dev";
    expect(previewUrl(JSON.stringify({ preview: { urls: [url, "https://other.dev"] } }))).toBe(url);
    expect(previewUrl(`  ${JSON.stringify({ preview: { urls: [url] } })}\n`)).toBe(url);
    // Log lines around the JSON.
    expect(previewUrl(`⛅️ wrangler 4.147.0\n${JSON.stringify({ preview: { urls: [url] } })}\ndone`)).toBe(url);
    // Bad output.
    expect(previewUrl("")).toBeUndefined();
    expect(previewUrl("not json")).toBeUndefined();
    expect(previewUrl("{ broken")).toBeUndefined();
    expect(previewUrl("[]")).toBeUndefined();
    expect(previewUrl(JSON.stringify({ preview: {} }))).toBeUndefined();
    expect(previewUrl(JSON.stringify({ preview: { urls: [] } }))).toBeUndefined();
    expect(previewUrl(JSON.stringify({ preview: { urls: "https://x.dev" } }))).toBeUndefined();
    expect(previewUrl(JSON.stringify({ urls: [url] }))).toBeUndefined();
    // Only https, and only the first entry.
    expect(previewUrl(JSON.stringify({ preview: { urls: ["http://x.workers.dev"] } }))).toBeUndefined();
    expect(previewUrl(JSON.stringify({ preview: { urls: ["javascript:alert(1)"] } }))).toBeUndefined();
    expect(previewUrl(JSON.stringify({ preview: { urls: ["not a url", url] } }))).toBeUndefined();
    expect(previewUrl(JSON.stringify({ preview: { urls: [42, url] } }))).toBeUndefined();
  });
});
