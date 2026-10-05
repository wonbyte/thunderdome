import { describe, expect, it, vi } from "vitest";

import { START_ATTEMPTS, startWorkflow } from "../src/start";

// A Workflow binding whose create fails `failures` times, then works. landed: a failed
// create that still made the instance (the retry then finds it).
function fakeBinding({ failures = 0, landed = false } = {}) {
  const made = new Set<string>();
  let left = failures;
  const binding = {
    create: vi.fn(async ({ id }: { id?: string }) => {
      if (left > 0) {
        left--;
        if (landed) made.add(id!);
        throw new Error("internal error");
      }
      made.add(id!);
      return { id };
    }),
    get: vi.fn(async (id: string) => {
      if (!made.has(id)) throw new Error("instance.not_found");
      return { id };
    }),
  };
  return binding as typeof binding & Pick<Workflow<{ n: number }>, "create" | "get">;
}

const noSleep = vi.fn(async () => {});

describe("startWorkflow", () => {
  it("creates the instance once when create works", async () => {
    const binding = fakeBinding();
    await startWorkflow(binding, "t-1-judge", { n: 1 }, noSleep);
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect(binding.create).toHaveBeenCalledWith({ id: "t-1-judge", params: { n: 1 } });
  });

  it("S1 retries a create that fails with internal error", async () => {
    const binding = fakeBinding({ failures: 2 });
    await startWorkflow(binding, "t-1-judge", { n: 1 }, noSleep);
    expect(binding.create).toHaveBeenCalledTimes(3);
    expect(await binding.get("t-1-judge")).toEqual({ id: "t-1-judge" });
  });

  it("S2 counts a failed create whose instance exists as started", async () => {
    const binding = fakeBinding({ failures: 1, landed: true });
    await startWorkflow(binding, "t-1-judge", { n: 1 }, noSleep);
    expect(binding.create).toHaveBeenCalledTimes(1);
  });

  it("S3 throws the last error after every attempt fails", async () => {
    const binding = fakeBinding({ failures: 99 });
    await expect(startWorkflow(binding, "t-1-judge", { n: 1 }, noSleep)).rejects.toThrow("internal error");
    expect(binding.create).toHaveBeenCalledTimes(START_ATTEMPTS);
  });
});
