import { describe, expect, it } from "vitest";

import { accessFor, isForkAgent, pageAsset } from "../src/routes/access";

const id = "t-0123abcd";

describe("accessFor", () => {
  it("U1: GET task, steps, claims, live and judge are public for a valid task id, and GET /race/:id is the page", () => {
    for (const path of [`/tasks/${id}`, `/tasks/${id}/steps`, `/tasks/${id}/claims`, `/tasks/${id}/live`, `/tasks/${id}/judge`]) {
      expect(accessFor("GET", path), path).toBe("public");
    }
    expect(accessFor("GET", `/race/${id}`)).toBe("page");
  });

  it("U2: POSTs, bad ids, extra segments, spike, admin and unknown paths need admin; GET / stays public", () => {
    const cases: [string, string][] = [
      ["POST", "/tasks"],
      ["POST", `/tasks/${id}/run`],
      ["POST", `/tasks/${id}/claims`],
      ["POST", `/tasks/${id}/release`],
      ["POST", `/tasks/${id}/judge`],
      ["POST", `/race/${id}`],
      ["PUT", `/tasks/${id}`],
      ["DELETE", `/tasks/${id}`],
      ["HEAD", `/tasks/${id}`],
      ["get", `/tasks/${id}`],
      ["POST", "/"],
      ["GET", "/tasks/"],
      ["GET", "/tasks/bad-id"],
      ["GET", "/tasks/nope/steps"],
      ["GET", "/tasks/nope/live"],
      ["GET", "/race/bad-id"],
      ["GET", "/race"],
      ["GET", `/tasks/${id}/`],
      ["GET", `/race/${id}/`],
      ["GET", `/tasks/${id}/live/x`],
      ["GET", `/tasks/${id}/judge/x`],
      ["GET", `/race/${id}/x`],
      ["GET", `/tasks/${id}/run`],
      ["GET", `/tasks/${id}/release`],
      ["GET", `/tasks/${id}/nope`],
      ["GET", "/spike/seed"],
      ["POST", "/spike/seed"],
      ["POST", "/spike/day1"],
      ["GET", "/admin/model-check"],
      ["GET", "/nope"],
      ["GET", "/race.html"],
      ["GET", `/x/tasks/${id}`],
    ];
    for (const [method, path] of cases) {
      expect(accessFor(method, path), `${method} ${path}`).toBe("admin");
    }
    expect(accessFor("GET", "/")).toBe("public");
  });

  it("L3: GET /tasks is public, POST /tasks is admin, GET /races is page, and pageAsset maps both pages and nothing else", () => {
    expect(accessFor("GET", "/tasks")).toBe("public");
    expect(accessFor("POST", "/tasks")).toBe("admin");
    expect(accessFor("GET", "/tasks/")).toBe("admin");
    expect(accessFor("GET", "/races")).toBe("page");
    for (const [method, path] of [["POST", "/races"], ["GET", "/races/"], ["GET", "/races/x"], ["GET", "/races.html"]] as const) {
      expect(accessFor(method, path), `${method} ${path}`).toBe("admin");
    }

    expect(pageAsset(`/race/${id}`)).toBe("/race.html");
    expect(pageAsset("/races")).toBe("/races.html");
    for (const path of ["/race/bad-id", "/race", "/race/", "/races/", `/race/${id}/`, `/race/${id}/x`, "/tasks", `/tasks/${id}`, "/", "/races.html", "/race.html", `/x/race/${id}`]) {
      expect(pageAsset(path), path).toBeUndefined();
    }
  });

  it("L6: the existing public and admin rules (U1, U2) still hold", () => {
    for (const path of ["/", `/tasks/${id}`, `/tasks/${id}/steps`, `/tasks/${id}/claims`, `/tasks/${id}/live`, `/tasks/${id}/judge`]) {
      expect(accessFor("GET", path), path).toBe("public");
    }
    expect(accessFor("GET", `/race/${id}`)).toBe("page");
    const admin: [string, string][] = [
      ["POST", "/tasks"],
      ["POST", `/tasks/${id}/run`],
      ["POST", `/tasks/${id}/judge`],
      ["POST", `/race/${id}`],
      ["POST", "/"],
      ["get", `/tasks/${id}`],
      ["GET", "/tasks/bad-id"],
      ["GET", "/race/bad-id"],
      ["GET", `/tasks/${id}/live/x`],
      ["GET", `/race/${id}/x`],
      ["GET", `/tasks/${id}/run`],
      ["GET", "/spike/seed"],
      ["POST", "/spike/day1"],
      ["GET", "/admin/model-check"],
      ["GET", "/nope"],
    ];
    for (const [method, path] of admin) {
      expect(accessFor(method, path), `${method} ${path}`).toBe("admin");
    }
  });

  it("the commit route is public only for GET with a full lowercase hash", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(accessFor("GET", `/tasks/${id}/commits/${sha}`)).toBe("public");
    for (const [method, path] of [
      ["POST", `/tasks/${id}/commits/${sha}`],
      ["GET", `/tasks/${id}/commits/${sha.slice(0, 7)}`],
      ["GET", `/tasks/${id}/commits/${sha.toUpperCase()}`],
      ["GET", `/tasks/${id}/commits/${sha}/x`],
      ["GET", `/tasks/${id}/commits`],
      ["GET", `/tasks/bad-id/commits/${sha}`],
    ] as const) {
      expect(accessFor(method, path), `${method} ${path}`).toBe("admin");
    }
  });

  it('X7: the diff route, POST /play and GET /play/quota are public; GET /play is page with pageAsset "/play.html"; POST to other paths is still admin; a bad agent name in the diff path is admin', () => {
    for (const agent of ["ponder", "zippy", "a"]) {
      expect(accessFor("GET", `/tasks/${id}/forks/${agent}/diff`), agent).toBe("public");
    }
    expect(accessFor("POST", "/play")).toBe("public");
    expect(accessFor("GET", "/play/quota")).toBe("public");
    expect(accessFor("GET", "/play")).toBe("page");
    expect(pageAsset("/play")).toBe("/play.html");
    expect(pageAsset("/races")).toBe("/races.html");
    expect(pageAsset(`/race/${id}`)).toBe("/race.html");
    for (const path of ["/play/", "/play.html", "/play/quota"]) expect(pageAsset(path), path).toBeUndefined();

    expect(isForkAgent("ponder")).toBe(true);
    for (const bad of ["", "Bad1", "Careful", "a-b", "a b", "../x"]) expect(isForkAgent(bad), bad).toBe(false);

    const admin: [string, string][] = [
      ["POST", "/tasks"],
      ["POST", `/tasks/${id}/run`],
      ["POST", "/play/quota"],
      ["POST", "/play/"],
      ["POST", `/tasks/${id}/forks/ponder/diff`],
      ["PUT", "/play"],
      ["DELETE", "/play"],
      ["get", "/play"],
      ["GET", "/play/"],
      ["GET", "/play.html"],
      ["GET", "/play/quota/x"],
      ["GET", `/tasks/${id}/forks`],
      ["GET", `/tasks/${id}/forks/ponder`],
      ["GET", `/tasks/${id}/forks/Bad1/diff`],
      ["GET", `/tasks/${id}/forks//diff`],
      ["GET", `/tasks/${id}/forks/a-b/diff`],
      ["GET", `/tasks/${id}/forks/a/diff/x`],
      ["GET", `/tasks/${id}/forks/a/diff/`],
      ["GET", `/tasks/${id}/forks/a/patch`],
      ["GET", "/tasks/bad-id/forks/ponder/diff"],
      ["GET", `/race/${id}/forks/ponder/diff`],
      ["GET", `/x/tasks/${id}/forks/ponder/diff`],
    ];
    for (const [method, path] of admin) {
      expect(accessFor(method, path), `${method} ${path}`).toBe("admin");
    }
  });
});
