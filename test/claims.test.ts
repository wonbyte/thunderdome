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
    expect(claimFiles(board, "careful", ["src/text.ts"], false, "t1")).toMatchObject({ ok: true, claimed: ["src/text.ts"] });
    const result = claimFiles(board, "fast", ["src/index.ts", "src/text.ts"], false, "t2");
    expect(result).toEqual({
      ok: true,
      claimed: ["src/index.ts", "src/text.ts"],
      already: [],
      shared: ["src/text.ts"],
      clashes: [{ file: "src/text.ts", heldBy: ["careful"] }],
    });
    expect(board.active.map((claim) => `${claim.agent}:${claim.file}:${claim.shared}`)).toEqual([
      "careful:src/text.ts:false",
      "fast:src/index.ts:false",
      "fast:src/text.ts:true",
    ]);
    expect(claimsOf(board, "fast")).toEqual({ files: ["src/index.ts", "src/text.ts"], shared: ["src/text.ts"] });
  });

  it("lets agent B take the file after agent A releases it", () => {
    const board = emptyBoard();
    claimFiles(board, "careful", ["src/text.ts", "README.md"], false, "t1");
    expect(releaseFiles(board, "careful", ["src/text.ts"])).toEqual(["src/text.ts"]);
    expect(claimFiles(board, "fast", ["src/text.ts"], false, "t2")).toMatchObject({ ok: true, claimed: ["src/text.ts"] });
    expect(board.active.map((claim) => `${claim.agent}:${claim.file}`)).toEqual(["careful:README.md", "fast:src/text.ts"]);
  });

  it("treats a re-claim of your own file as a no-op", () => {
    const board = emptyBoard();
    claimFiles(board, "careful", ["a.ts"], false, "t1");
    expect(claimFiles(board, "careful", ["a.ts", "b.ts"], false, "t2")).toEqual({ ok: true, claimed: ["b.ts"], already: ["a.ts"], shared: [], clashes: [] });
    expect(board.active).toHaveLength(2);
    expect(board.history).toHaveLength(2);
  });

  it("allows a shared claim on a held file and records it", () => {
    const board = emptyBoard();
    claimFiles(board, "careful", ["a.ts"], false, "t1");
    expect(claimFiles(board, "fast", ["a.ts"], true, "t2")).toMatchObject({ ok: true, claimed: ["a.ts"], shared: ["a.ts"] });
    expect(claimsOf(board, "fast")).toEqual({ files: ["a.ts"], shared: ["a.ts"] });
    // A third agent without "shared" gets a shared claim too, and sees both holders.
    expect(claimFiles(board, "tester", ["a.ts"], false, "t3")).toMatchObject({
      ok: true,
      shared: ["a.ts"],
      clashes: [{ file: "a.ts", heldBy: ["careful", "fast"] }],
    });
  });

  it("marks every new claim shared when asked, even on free files", () => {
    const board = emptyBoard();
    expect(claimFiles(board, "fast", ["a.ts"], true, "t1")).toEqual({ ok: true, claimed: ["a.ts"], already: [], shared: ["a.ts"], clashes: [] });
  });
});

describe("releaseFiles", () => {
  it("releases all of one agent's files and keeps the history", () => {
    const board = emptyBoard();
    claimFiles(board, "careful", ["a.ts", "b.ts"], false, "t1");
    claimFiles(board, "fast", ["c.ts"], false, "t1");
    expect(releaseFiles(board, "careful")).toEqual(["a.ts", "b.ts"]);
    expect(board.active.map((claim) => claim.agent)).toEqual(["fast"]);
    expect(claimsOf(board, "careful").files).toEqual(["a.ts", "b.ts"]);
  });

  it("releases nothing it does not hold", () => {
    const board = emptyBoard();
    claimFiles(board, "careful", ["a.ts"], false, "t1");
    expect(releaseFiles(board, "fast", ["a.ts"])).toEqual([]);
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
      describeClaim({ ok: true, claimed: ["a.ts", "b.ts"], already: [], shared: ["a.ts"], clashes: [{ file: "a.ts", heldBy: ["careful"] }] }),
    ).toBe("claimed b.ts; shared claim a.ts; clash: a.ts (also held by careful)");
    expect(describeClaim({ ok: false, status: 400, error: "files must not be empty" })).toBe("claim refused: files must not be empty");
  });
});
