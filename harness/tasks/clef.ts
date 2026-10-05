// Judge scorer on Cloudflare's Clef through Workers AI. Graph: harness/tasks/clef.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "clef scorer",
    owns: ["src/judge/scorer.ts", "test/scorer.test.ts", "src/judge/JudgeWorkflow.ts", "wrangler.jsonc"],
    tests: ["test/scorer.test.ts"],
    required: ["C1", "C2", "C3", "C4"],
    maxAttempts: 4,
    regenTypes: true,
    brief:
      "In src/judge/scorer.ts (still no cloudflare:workers import): replace the TypeSafe HTTP call with an injected Workers AI runner. " +
      "Export `CLEF_MODEL_ID = \"@cf/cloudflare/clef\"` and `CLEF_MODEL = \"clef\"`, and `interface AiRunner { run(model: string, input: unknown): Promise<unknown> }`. " +
      "Rename TypeSafeRequest to SystemOneRequest. buildRequest sets model CLEF_MODEL. QUESTIONS, clipDiff, MAX_DIFF_CHARS and the state shape stay byte-for-byte the same. " +
      "`clefScorer(ai: AiRunner, sleep?)` returns a Scorer: it calls `ai.run(CLEF_MODEL_ID, buildRequest(request))` inside retry (SCORER_ATTEMPTS, SCORER_RETRY_DELAY_MS). An error thrown by run becomes a retryable ScorerError whose message is `Clef run failed: <error message, first 300 chars>`. A malformed answer is a non-retryable ScorerError. " +
      "parseResponse accepts `{ answers }` or `{ result: { answers } }`. Its error messages say Clef instead of TypeSafe. " +
      "Remove TYPESAFE_URL, TYPESAFE_MODEL, typeSafeScorer, callTypeSafe and httpError. Keep ScorerError (status may stay optional and unused), fakeScorer, parseResponse and every other export. " +
      "The typecheck covers the whole project, so wire it in this step too. wrangler.jsonc: add `\"ai\": { \"binding\": \"AI\" }` with a one-line comment (the judge's scorer, Cloudflare's Clef), and remove TYPESAFE_API_KEY from secrets.required and from the secrets comment. JudgeWorkflow: use `clefScorer(env.AI)`. If Ai's run overloads do not accept the AiRunner shape directly, adapt it with a small typed wrapper and a comment, with no `any`. " +
      "Rewrite test/scorer.test.ts for the runner (a vi.fn fake AiRunner). Keep the existing behaviour tests that still apply (clipping, injection text stays in state, the questions constant) and add C1–C4 as the step brief lists them.",
  },
  {
    id: "N3",
    title: "docs",
    owns: ["README.md"],
    tests: ["test"],
    required: [],
    maxAttempts: 2,
    brief:
      "README: wherever the judge's scorer, TypeSafe, Jev or TYPESAFE_API_KEY is mentioned, say it now uses Cloudflare's Clef (`@cf/cloudflare/clef`) on Workers AI through the AI binding, and drop the TYPESAFE_API_KEY setup step. Keep the rest of the README unchanged.",
  },
];

export const task: TaskGraph = {
  branch: "harness/clef",
  nodes,
  planTask:
    "Plan moving Thunderdome's judge scorer from TypeSafe's Jev to Cloudflare's Clef on Workers AI. " +
    "Read harness/tasks/clef.md, src/judge/scorer.ts, test/scorer.test.ts, src/judge/JudgeWorkflow.ts, src/retry.ts, wrangler.jsonc and the README, then call submit_plan.",
  extraAllowed: ["worker-configuration.d.ts"],
};
