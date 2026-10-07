import { describe, expect, it, vi } from "vitest";

import { CLEF_MODEL, CLEF_MODEL_ID, ScorerError, type AiRunner } from "../src/judge/scorer";
import { parseSplit, splitRequest, splitTask } from "../src/judge/testscope";

const TASK = "Build parts 1 and 2. Then Zippy builds part 4 and everyone else builds part 3.";
const noul = (value: number) => ({ answers: { split: { type: "noul", noul: value } } });

describe("split task", () => {
  it("P1: the request holds only the task in state and one yes/no question", () => {
    const body = splitRequest(TASK) as { model: string; state: unknown; questions: Record<string, { type: string }> };
    expect(body.model).toBe(CLEF_MODEL);
    expect(body.state).toEqual({ task: TASK });
    expect(Object.keys(body.questions)).toEqual(["split"]);
    expect(body.questions.split!.type).toBe("noul");
  });

  it("P2: parseSplit reads the yes from a plain or wrapped answer, clamps it, and rejects a malformed one", () => {
    expect(parseSplit(noul(0.97))).toBe(0.97);
    expect(parseSplit({ result: noul(1.4) })).toBe(1);
    expect(() => parseSplit({ answers: {} })).toThrow(ScorerError);
  });

  it("P3: splitTask asks Clef once, and retries a thrown run", async () => {
    const answers: unknown[] = [new Error("busy"), noul(0.97)];
    const ai = { run: vi.fn(async (_m: string, _i: unknown) => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }) } satisfies AiRunner;
    expect(await splitTask(ai, TASK, async () => {})).toBe(0.97);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(ai.run.mock.calls[0]![0]).toBe(CLEF_MODEL_ID);
  });
});
