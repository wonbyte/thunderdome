import { describe, expect, it } from "vitest";

import { clipDiff, MAX_SAVED_DIFF } from "../src/judge/diffs";

describe("clipDiff", () => {
  it("X4: clipDiff keeps a short diff, cuts a long one at the last newline at or before max, and cuts at max with no newline", () => {
    expect(MAX_SAVED_DIFF).toBe(200_000);

    // Short or exactly max: kept whole.
    expect(clipDiff("ab\ncd\n", 6)).toEqual({ diff: "ab\ncd\n", clipped: false });
    expect(clipDiff("", 6)).toEqual({ diff: "", clipped: false });
    const big = "x".repeat(MAX_SAVED_DIFF);
    expect(clipDiff(big)).toEqual({ diff: big, clipped: false });

    // Long: whole lines up to and including the last newline at or before max.
    expect(clipDiff("ab\ncd\nef", 6)).toEqual({ diff: "ab\ncd\n", clipped: true });
    expect(clipDiff("ab\ncd\nef", 5)).toEqual({ diff: "ab\n", clipped: true });
    // The newline at index max - 1 still fits.
    expect(clipDiff("abc\ndef", 4)).toEqual({ diff: "abc\n", clipped: true });

    // No newline at or before max: cut at max.
    expect(clipDiff("abcdef", 4)).toEqual({ diff: "abcd", clipped: true });
    expect(clipDiff("abcdef\ngh", 4)).toEqual({ diff: "abcd", clipped: true });

    // The default max applies, and the result is never longer than max.
    const long = `${"line\n".repeat(MAX_SAVED_DIFF / 5)}tail`;
    const clipped = clipDiff(long);
    expect(clipped.clipped).toBe(true);
    expect(clipped.diff.length).toBeLessThanOrEqual(MAX_SAVED_DIFF);
    expect(clipped.diff.endsWith("\n")).toBe(true);
  });
});
