import { describe, expect, it, vi } from "vitest";

import { retry } from "../src/retry";

const noSleep = async () => {};

describe("retry", () => {
  it("returns the first success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue("ok");
    expect(await retry(fn, { attempts: 3, delayMs: 1, shouldRetry: () => true }, noSleep)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops after the last attempt", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("busy"));
    await expect(retry(fn, { attempts: 3, delayMs: 1, shouldRetry: () => true }, noSleep)).rejects.toThrow("busy");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry errors it should not", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(retry(fn, { attempts: 3, delayMs: 1, shouldRetry: () => false }, noSleep)).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
