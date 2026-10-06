import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimFiles, emptyBoard, parseFiles, releaseFiles, type ClaimBoard } from "../src/room/claims";
import { handleThunderdomeApi, type ClaimRoom } from "../src/sandbox/thunderdomeApi";
import { thunderdomeApiBase, decideOutbound, isThunderdomeApi, type OutboundProps } from "../src/sandbox/policy";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../image/claim.mjs", import.meta.url).href);
const GIT_HOST = "git.test";

// A TaskRoom stand-in with the real claim rules.
function memoryRoom(board: ClaimBoard): ClaimRoom {
  return {
    claim(agent, files, shared) {
      const parsed = parseFiles(files);
      if (typeof parsed === "string") return { ok: false, status: 400, error: parsed };
      return claimFiles(board, agent, parsed, shared, "now");
    },
    release(agent, files) {
      const parsed = files === undefined ? undefined : parseFiles(files);
      if (typeof parsed === "string") return { ok: false };
      return { ok: true, released: releaseFiles(board, agent, parsed) } as { ok: boolean };
    },
    claimBoard: () => board,
  };
}

const props = (agent: string): OutboundProps => ({ gitHost: GIT_HOST, gitToken: "t", modelApi: true, taskId: "t-0123abcd", agent });

describe("isThunderdomeApi", () => {
  it("matches only the reserved path on the git host", () => {
    const base = props("ponder");
    expect(isThunderdomeApi(new URL("https://git.test/_thunderdome/claims"), base)).toBe(true);
    expect(isThunderdomeApi(new URL("https://git.test/git/thunderdome/x.git"), base)).toBe(false);
    expect(isThunderdomeApi(new URL("https://evil.test/_thunderdome/claims"), base)).toBe(false);
    expect(thunderdomeApiBase(GIT_HOST)).toBe("https://git.test/_thunderdome");
  });

  it("never forwards an Thunderdome API path to the git host with the token", () => {
    expect(decideOutbound(new URL("https://git.test/_thunderdome/claims"), props("ponder"))).toMatchObject({ allow: false, status: 404 });
  });
});

describe("handleThunderdomeApi", () => {
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://${GIT_HOST}/_thunderdome/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  it("takes the agent from the props, not the body", async () => {
    const board = emptyBoard();
    const response = await handleThunderdomeApi(request("POST", "claims", { files: ["a.ts"], agent: "zippy" }), props("ponder"), () => memoryRoom(board));
    expect(response.status).toBe(200);
    expect(board.active[0]?.agent).toBe("ponder");
  });

  it("gives agent B a shared claim and the clash on a file agent A holds", async () => {
    const board = emptyBoard();
    const room = () => memoryRoom(board);
    await handleThunderdomeApi(request("POST", "claims", { files: ["src/text.ts"] }), props("ponder"), room);
    const response = await handleThunderdomeApi(request("POST", "claims", { files: ["src/text.ts"] }), props("zippy"), room);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ shared: ["src/text.ts"], clashes: [{ file: "src/text.ts", heldBy: ["ponder"] }] });
  });

  it("refuses a sandbox that runs no agent, plain HTTP, and unknown paths", async () => {
    const room = () => memoryRoom(emptyBoard());
    expect((await handleThunderdomeApi(request("GET", "claims"), { gitHost: GIT_HOST, gitToken: "t" }, room)).status).toBe(404);
    const plain = new Request(`http://${GIT_HOST}/_thunderdome/claims`);
    expect((await handleThunderdomeApi(plain, props("ponder"), room)).status).toBe(403);
    expect((await handleThunderdomeApi(request("GET", "nope"), props("ponder"), room)).status).toBe(404);
    expect((await handleThunderdomeApi(new Request(`https://${GIT_HOST}/_thunderdome/claims`, { method: "POST", body: "{" }), props("ponder"), room)).status).toBe(400);
  });
});

describe("claim CLI", () => {
  const board = emptyBoard();
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // Plays the Outbound Worker: the agent name comes from the path the test picks.
    server = createServer((req, res) => void answer(req, res));
    async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const [, agent = "", ...rest] = (req.url ?? "").split("/");
      const body = chunks.length > 0 ? Buffer.concat(chunks).toString() : undefined;
      const request = new Request(`https://${GIT_HOST}/_thunderdome/${rest.join("/")}`, { method: req.method, body });
      const response = await handleThunderdomeApi(request, props(agent), () => memoryRoom(board));
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function claim(agent: string, ...args: string[]) {
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, THUNDERDOME_API: `${base}/${agent}` } });
      return { code: 0, stdout, stderr };
    } catch (cause) {
      const error = cause as { code: number; stdout: string; stderr: string };
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }

  it("runs a full claim round between two agents", async () => {
    expect(await claim("ponder", "./src/text.ts")).toMatchObject({ code: 0, stdout: "Claimed: src/text.ts\n" });

    const clash = await claim("zippy", "src/text.ts", "src/index.ts");
    expect(clash).toMatchObject({ code: 0, stdout: "Claimed: src/index.ts\nShared claim: src/text.ts\n" });
    expect(clash.stderr).toContain("src/text.ts: ponder");

    expect(await claim("zippy", "src/index.ts")).toMatchObject({ code: 0, stdout: "Already yours: src/index.ts\n" });
    expect(await claim("testy", "--shared", "README.md")).toMatchObject({ code: 0, stdout: "Shared claim: README.md\n" });
    expect((await claim("ponder", "--list")).stdout).toBe("src/text.ts\tponder\nsrc/text.ts\tzippy (shared)\nsrc/index.ts\tzippy\nREADME.md\ttesty (shared)\n");
    expect(await claim("ponder", "--release")).toMatchObject({ code: 0, stdout: "Released: src/text.ts\n" });
  });

  it("explains usage errors", async () => {
    expect(await claim("ponder")).toMatchObject({ code: 2 });
    expect(await claim("ponder", "--shared")).toMatchObject({ code: 2 });
    expect(await claim("ponder", "../etc/passwd")).toMatchObject({ code: 2 });
    const noApi = await run(process.execPath, [CLI, "a.ts"], { env: { ...process.env, THUNDERDOME_API: "" } }).catch((e: { code: number; stderr: string }) => e);
    expect(noApi).toMatchObject({ code: 2 });
  });
});
