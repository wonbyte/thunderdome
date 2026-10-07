// Whether the task gives robots different parts. Then each robot's added tests check its own part,
// so the shared suite keeps only the repo's tests: no robot loses tests points for a part it was
// told not to build. Clef could not tell reliably which robot a test file belongs to (measured
// Oct 7), so the scope is the whole race, not per file. No cloudflare:workers import; the AI runner is injected.
import { retry } from "../retry";
import { CLEF_MODEL, CLEF_MODEL_ID, SCORER_ATTEMPTS, SCORER_RETRY_DELAY_MS, ScorerError, type AiRunner } from "./scorer";

/** The task splits the work when Clef's yes is at least this. Demo prompts: 0.97 split, at most 0.04 not. */
export const SPLIT_YES = 0.5;

/** The split question: only the task in state, which the race starter wrote. */
export function splitRequest(task: string): unknown {
  return {
    model: CLEF_MODEL,
    state: { task },
    questions: {
      split: {
        type: "noul",
        instructions: "Does `task` give different robots different parts to build, by naming robots?",
        criteria: {
          true: "`task` names robots and gives some of them a part the others do not build, for example \"Zippy builds part 4, everyone else builds part 3\".",
          false: "`task` asks every robot for the same work.",
        },
      },
    },
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The split answer's yes, 0..1. Accepts { answers } or Workers AI's { result: { answers } }. */
export function parseSplit(body: unknown): number {
  const unwrapped = isRecord(body) && !isRecord(body.answers) && isRecord(body.result) ? body.result : body;
  const answer = isRecord(unwrapped) && isRecord(unwrapped.answers) ? unwrapped.answers.split : undefined;
  if (!isRecord(answer) || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) throw new ScorerError("Clef answer split is malformed");
  return Math.round(Math.min(1, Math.max(0, answer.noul)) * 10_000) / 10_000;
}

/** Clef's yes that the task gives robots different parts. A failed run is retried. */
export async function splitTask(ai: AiRunner, task: string, sleep?: (ms: number) => Promise<void>): Promise<number> {
  return retry(
    async () => {
      let body: unknown;
      try {
        body = await ai.run(CLEF_MODEL_ID, splitRequest(task));
      } catch (cause) {
        throw new ScorerError(`Clef run failed (${cause instanceof Error ? cause.name : "error"})`, undefined, true);
      }
      return parseSplit(body);
    },
    { attempts: SCORER_ATTEMPTS, delayMs: SCORER_RETRY_DELAY_MS, shouldRetry: (e) => e instanceof ScorerError && e.retryable },
    sleep,
  );
}
