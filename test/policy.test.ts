import { describe, expect, it } from "vitest";

import { decideOutbound, gitRepoPath, isPreviewApiPath, previewApiPrefix } from "../src/sandbox/policy";

const props = { gitHost: "git.test", gitToken: "secret" };

describe("decideOutbound", () => {
  it("adds the token for the fork's git host", () => {
    expect(decideOutbound(new URL("https://git.test/thunderdome/x.git/info/refs"), props)).toEqual({
      allow: true,
      headers: { authorization: "Bearer secret" },
    });
  });

  it("never sends the token over plain HTTP", () => {
    expect(decideOutbound(new URL("http://git.test/thunderdome/x.git"), props)).toMatchObject({ allow: false, status: 403 });
  });

  it("blocks every other host", () => {
    expect(decideOutbound(new URL("https://evil.test/"), props)).toMatchObject({ allow: false, status: 403 });
    expect(decideOutbound(new URL("https://git.test.evil.test/"), props)).toMatchObject({ allow: false });
  });
});

describe("decideOutbound with repo tokens", () => {
  const multi = { ...props, gitToken: "read", repoTokens: { "thunderdome/source": "write", "thunderdome/winner": "winner" } };
  const auth = (href: string, p: typeof props = multi) => decideOutbound(new URL(href), p);

  it("a git request gets the token for its own repo path, and never another repo's token", () => {
    expect(auth("https://git.test/git/thunderdome/source.git/info/refs?service=git-receive-pack")).toEqual({
      allow: true,
      headers: { authorization: "Bearer write" },
    });
    expect(auth("https://git.test/git/thunderdome/winner.git/git-upload-pack")).toEqual({
      allow: true,
      headers: { authorization: "Bearer winner" },
    });
    // Other repos, look-alike names and inherited keys get only gitToken.
    for (const href of [
      "https://git.test/git/thunderdome/other.git/info/refs",
      "https://git.test/git/other/source.git/info/refs",
      "https://git.test/git/thunderdome/source2.git/info/refs",
      "https://git.test/git/thunderdome/sourc.git/info/refs",
      "https://git.test/git/thunderdome/source/info/refs",
      "https://git.test/git/thunderdome/constructor.git/info/refs",
    ]) {
      expect(auth(href)).toEqual({ allow: true, headers: { authorization: "Bearer read" } });
    }
    // Paths the host may route to another repo first: only gitToken.
    for (const href of [
      "https://git.test/git/other/x%2Egit/thunderdome/source.git/info/refs",
      "https://git.test/git/other/x.git;a/thunderdome/source.git/info/refs",
      "https://git.test/git/other/x.GIT/thunderdome/source.git/info/refs",
      "https://git.test/git/thunderdome/sour%63e.git/info/refs",
    ]) {
      expect(auth(href)).toEqual({ allow: true, headers: { authorization: "Bearer read" } });
    }
    // Not repo paths: only gitToken.
    for (const href of ["https://git.test/", "https://git.test/thunderdome/source", "https://git.test/.git", "https://git.test//source.git"]) {
      expect(auth(href)).toEqual({ allow: true, headers: { authorization: "Bearer read" } });
    }
    // Repo tokens go only to the git host.
    expect(auth("https://evil.test/git/thunderdome/source.git/info/refs")).toMatchObject({ allow: false, status: 403 });
    expect(auth("http://git.test/git/thunderdome/source.git/info/refs")).toMatchObject({ allow: false, status: 403 });
    // The Thunderdome API check is unchanged.
    expect(auth("https://git.test/_thunderdome/thunderdome/source.git")).toMatchObject({ allow: false, status: 404 });
  });

  it("finds the repo path in git URLs", () => {
    expect(gitRepoPath(new URL("https://git.test/git/thunderdome/x.git/info/refs"))).toBe("thunderdome/x");
    expect(gitRepoPath(new URL("https://git.test/thunderdome/x.git"))).toBe("thunderdome/x");
    expect(gitRepoPath(new URL("https://git.test/a/x.git/b/y.git"))).toBe("a/x");
    expect(gitRepoPath(new URL("https://git.test/a/x.git/b%2F/c;d"))).toBe("a/x");
    expect(gitRepoPath(new URL("https://git.test/x.git"))).toBeUndefined();
    expect(gitRepoPath(new URL("https://git.test/thunderdome/.git"))).toBeUndefined();
    expect(gitRepoPath(new URL("https://git.test/thunderdome/x"))).toBeUndefined();
    expect(gitRepoPath(new URL("https://git.test/a%2Fb/x.git"))).toBeUndefined();
    expect(gitRepoPath(new URL("https://git.test/a/x%2Egit/b/y.git"))).toBeUndefined();
  });
});

describe("decideOutbound for the model API", () => {
  const url = new URL("https://api.anthropic.com/v1/messages");

  it("adds the Worker's key for agent sandboxes", () => {
    expect(decideOutbound(url, { ...props, modelApi: true }, "sk-real")).toEqual({ allow: true, headers: { "x-api-key": "sk-real" } });
  });

  it("blocks sandboxes without model access", () => {
    expect(decideOutbound(url, props, "sk-real")).toMatchObject({ allow: false, status: 403 });
  });

  it("trims a pasted key", () => {
    expect(decideOutbound(url, { ...props, modelApi: true }, " sk-real\n")).toEqual({ allow: true, headers: { "x-api-key": "sk-real" } });
  });

  it("says when the key is missing", () => {
    expect(decideOutbound(url, { ...props, modelApi: true })).toMatchObject({ allow: false, status: 503 });
  });

  it("never sends the key over plain HTTP", () => {
    expect(decideOutbound(new URL("http://api.anthropic.com/v1/messages"), { ...props, modelApi: true }, "sk-real")).toMatchObject({ allow: false });
  });
});

describe("decideOutbound for the previews API", () => {
  const account = "a".repeat(32);
  const grant = { accountId: account, worker: "thunderdome-preview" };
  const preview = { ...props, previewApi: grant };
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/thunderdome-preview/previews`;
  const allowed = { allow: true, headers: { authorization: "Bearer preview-token" } };
  const decide = (href: string, p: Parameters<typeof decideOutbound>[1] = preview, method?: string, token = "preview-token") =>
    decideOutbound(new URL(href), p, "sk-real", method, token);

  it("R1: a preview sandbox gets the preview token on the previews path with GET or POST, and nothing else does", () => {
    expect(previewApiPrefix(grant)).toBe(`/client/v4/accounts/${account}/workers/workers/thunderdome-preview/previews`);
    for (const method of ["GET", "POST"]) {
      for (const href of [base, `${base}/`, `${base}/abc123`, `${base}/abc123/deployments`, `${base}?per_page=10`]) {
        expect(decide(href, preview, method)).toEqual(allowed);
      }
    }
    // The token is trimmed like the model key, and a missing token says so.
    expect(decide(base, preview, "POST", " preview-token\n")).toEqual(allowed);
    expect(decide(base, preview, "POST", "  ")).toMatchObject({ allow: false, status: 503 });
    expect(decideOutbound(new URL(base), preview, undefined, "POST")).toMatchObject({ allow: false, status: 503 });
    // Agent sandboxes and git-only sandboxes are refused on the Cloudflare API.
    for (const p of [props, { ...props, modelApi: true, taskId: "t", agent: "claude" }]) {
      for (const method of ["GET", "POST"]) {
        expect(decide(base, p, method)).toMatchObject({ allow: false, status: 403 });
      }
    }
    // The old 2- and 3-argument calls have no method and are refused there.
    expect(decideOutbound(new URL(base), preview)).toMatchObject({ allow: false, status: 403 });
    expect(decideOutbound(new URL(base), preview, "sk-real")).toMatchObject({ allow: false, status: 403 });
    // The preview token never goes to the git host or the model API.
    expect(decide("https://git.test/thunderdome/x.git/info/refs", preview, "GET")).toEqual({
      allow: true,
      headers: { authorization: "Bearer secret" },
    });
    expect(decide("https://api.anthropic.com/v1/messages", { ...preview, modelApi: true }, "POST")).toEqual({
      allow: true,
      headers: { "x-api-key": "sk-real" },
    });
    expect(decide("https://api.anthropic.com/v1/messages", preview, "POST")).toMatchObject({ allow: false, status: 403 });
    // Not over plain HTTP, and not to look-alike hosts.
    expect(decide(base.replace("https:", "http:"), preview, "GET")).toMatchObject({ allow: false, status: 403 });
    expect(decide(base.replace("api.cloudflare.com", "api.cloudflare.com.evil.test"), preview, "GET")).toMatchObject({ allow: false, status: 403 });
  });

  it("R2: another Worker, another account, another method, or a path that escapes the previews prefix is refused", () => {
    const refused = { allow: false, status: 403 };
    // Other methods, including lowercase and missing ones.
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "get", "post", undefined]) {
      expect(decide(base, preview, method)).toMatchObject(refused);
      expect(decide(`${base}/abc123`, preview, method)).toMatchObject(refused);
    }
    const other = "b".repeat(32);
    for (const href of [
      // Another account or Worker, look-alike names and prefixes.
      base.replace(account, other),
      base.replace("thunderdome-preview", "other"),
      base.replace("thunderdome-preview", "thunderdome-preview2"),
      `${base}2`,
      `${base}-x`,
      base.replace("/previews", ""),
      base.replace("/previews", "/versions"),
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/thunderdome-preview`,
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "https://api.cloudflare.com/",
      // Traversal out of the prefix: resolved by URL parsing, then outside the prefix.
      `${base}/../../other/previews`,
      `${base}/%2e%2e/%2e%2e/other/previews`,
      `${base}/%2E%2E/%2E%2E/other/previews`,
      `${base}/../../../../${other}/workers/workers/thunderdome-preview/previews`,
      `${base}/..`,
      // Paths still ambiguous after parsing.
      `${base}//abc`,
      `${base}/abc//def`,
      `https://api.cloudflare.com//client/v4/accounts/${account}/workers/workers/thunderdome-preview/previews`,
      `${base}/abc%2F..%2F..`,
      `${base}/%2e%2e%2f`,
      `${base}/abc;x`,
      `${base};x`,
      `${base}/.%2e/x`,
      `https://api.cloudflare.com:8443/client/v4/accounts/${account}/workers/workers/thunderdome-preview/previews`,
    ]) {
      expect(decide(href, preview, "GET")).toMatchObject(refused);
      expect(decide(href, preview, "POST")).toMatchObject(refused);
    }
    // A grant that is not well-formed is ignored.
    for (const bad of [
      { accountId: "A".repeat(32), worker: "thunderdome-preview" },
      { accountId: "a".repeat(31), worker: "thunderdome-preview" },
      { accountId: `${account}/x`, worker: "thunderdome-preview" },
      { accountId: account, worker: "Thunderdome" },
      { accountId: account, worker: "-x" },
      { accountId: account, worker: "x/.." },
      { accountId: account, worker: "" },
    ]) {
      const href = `https://api.cloudflare.com${previewApiPrefix(bad)}`;
      expect(isPreviewApiPath(new URL(href), bad)).toBe(false);
      expect(decide(href, { ...props, previewApi: bad }, "GET")).toMatchObject(refused);
    }
  });
});
