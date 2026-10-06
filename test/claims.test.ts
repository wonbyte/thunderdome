import { describe, expect, it } from "vitest";

import {
  claimFiles,
  claimsOf,
  describeClaim,
  emptyBoard,
  MAX_FILES_PER_CLAIM,
  normalizeFile,
  parseFiles,
  releaseFiles,
} from "../src/room/claims";

describe("normalizeFile", () => {
  it("cleans repo paths", () => {
    expect(normalizeFile("src/text.ts")).toBe("src/text.ts");
    expect(normalizeFile(" ./src//text.ts ")).toBe("src/text.ts");
    expect(normalizeFile("././a")).toBe("a");
  });

  it.each(["", "/etc/passwd", "../x", "src/../../x", "src/./x", "src/", "a\0b", "x".repeat(301)])("rejects %j", (path) => {
    expect(normalizeFile(path)).toBeUndefined();
  });
});

describe("parseFiles", () => {
  it("normalizes and removes duplicates", () => {
    expect(parseFiles(["./a.ts", "a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  it("rejects bad input", () => {
    expect(parseFiles("a.ts")).toMatch(/array/);
    expect(parseFiles([])).toMatch(/empty/);
    expect(parseFiles([1])).toMatch(/not a repo path/);
    expect(parseFiles(["../x"])).toMatch(/not a repo path/);
    expect(parseFiles(Array.from({ length: MAX_FILES_PER_CLAIM + 1 }, (_, i) => `f${i}`))).toMatch(/at most/);
  });

  it("allows an empty list when asked", () => {
    expect(parseFiles([], { allowEmpty: true })).toEqual([]);
  });
});

describe("claimFiles", () => {
  it("claims a file agent A holds as shared for agent B and reports the clash", () => {
    const board = emptyBoard();
    expect(claimFiles(board, "ponder", ["src/text.ts"], false, "t1")).toMatchObject({ ok: true, claimed: ["src/text.ts"] });
    const result = claimFiles(board, "zippy", ["src/index.ts", "src/text.ts"], false, "t2");
    expect(result).toEqual({
      ok: true,
      claimed: ["src/index.ts", "src/text.ts"],
      already: [],
      shared: ["src/text.ts"],
      clashes: [{ file: "src/text.ts", heldBy: ["ponder"] }],
    });
    expect(board.active.map((claim) => `${claim.agent}:${claim.file}:${claim.shared}`)).toEqual([
      "ponder:src/text.ts:false",
      "zippy:src/index.ts:false",
      "zippy:src/text.ts:true",
    ]);
    expect(claimsOf(board, "zippy")).toEqual({ files: ["src/index.ts", "src/text.ts"], shared: ["src/text.ts"] });
  });

  it("lets agent B take the file after agent A releases it", () => {
    const board = emptyBoard();
    claimFiles(board, "ponder", ["src/text.ts", "README.md"], false, "t1");
    expect(releaseFiles(board, "ponder", ["src/text.ts"])).toEqual(["src/text.ts"]);
    expect(claimFiles(board, "zippy", ["src/text.ts"], false, "t2")).toMatchObject({ ok: true, claimed: ["src/text.ts"] });
    expect(board.active.map((claim) => `${claim.agent}:${claim.file}`)).toEqual(["ponder:README.md", "zippy:src/text.ts"]);
  });

  it("treats a re-claim of your own file as a no-op", () => {
    const board = emptyBoard();
    claimFiles(board, "ponder", ["a.ts"], false, "t1");
    expect(claimFiles(board, "ponder", ["a.ts", "b.ts"], false, "t2")).toEqual({ ok: true, claimed: ["b.ts"], already: ["a.ts"], shared: [], clashes: [] });
    expect(board.active).toHaveLength(2);
    expect(board.history).toHaveLength(2);
  });

  it("allows a shared claim on a held file and records it", () => {
    const board = emptyBoard();
    claimFiles(board, "ponder", ["a.ts"], false, "t1");
    expect(claimFiles(board, "zippy", ["a.ts"], true, "t2")).toMatchObject({ ok: true, claimed: ["a.ts"], shared: ["a.ts"] });
    expect(claimsOf(board, "zippy")).toEqual({ files: ["a.ts"], shared: ["a.ts"] });
    // A third agent without "shared" gets a shared claim too, and sees both holders.
    expect(claimFiles(board, "testy", ["a.ts"], false, "t3")).toMatchObject({
      ok: true,
      shared: ["a.ts"],
      clashes: [{ file: "a.ts", heldBy: ["ponder", "zippy"] }],
    });
  });

  it("marks every new claim shared when asked, even on free files", () => {
    const board = emptyBoard();
    expect(claimFiles(board, "zippy", ["a.ts"], true, "t1")).toEqual({ ok: true, claimed: ["a.ts"], already: [], shared: ["a.ts"], clashes: [] });
  });
});

describe("releaseFiles", () => {
  it("releases all of one agent's files and keeps the history", () => {
    const board = emptyBoard();
    claimFiles(board, "ponder", ["a.ts", "b.ts"], false, "t1");
    claimFiles(board, "zippy", ["c.ts"], false, "t1");
    expect(releaseFiles(board, "ponder")).toEqual(["a.ts", "b.ts"]);
    expect(board.active.map((claim) => claim.agent)).toEqual(["zippy"]);
    expect(claimsOf(board, "ponder").files).toEqual(["a.ts", "b.ts"]);
  });

  it("releases nothing it does not hold", () => {
    const board = emptyBoard();
    claimFiles(board, "ponder", ["a.ts"], false, "t1");
    expect(releaseFiles(board, "zippy", ["a.ts"])).toEqual([]);
    expect(board.active).toHaveLength(1);
  });
});

describe("describeClaim", () => {
  it("writes one log line", () => {
    expect(describeClaim({ ok: true, claimed: ["a.ts"], already: [], shared: [], clashes: [] })).toBe("claimed a.ts");
    expect(describeClaim({ ok: true, claimed: ["a.ts"], already: ["b.ts"], shared: ["a.ts"], clashes: [] })).toBe(
      "shared claim a.ts; already held b.ts",
    );
    expect(
      describeClaim({ ok: true, claimed: ["a.ts", "b.ts"], already: [], shared: ["a.ts"], clashes: [{ file: "a.ts", heldBy: ["ponder"] }] }),
    ).toBe("claimed b.ts; shared claim a.ts; clash: a.ts (also held by ponder)");
    expect(describeClaim({ ok: false, status: 400, error: "files must not be empty" })).toBe("claim refused: files must not be empty");
  });
});
