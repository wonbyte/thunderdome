// The judge's pure parts the Clef replay needs, bundled by scripts/clef-replay/build.sh.
export { averageResults, authorName, buildRequest, CLEF_MODEL_ID, parseResponse, reverseFiles } from "../../src/judge/scorer";
export { judgmentPoints, JUDGE_TIE, scoreForks } from "../../src/judge/score";
export { compareRequest, parseCompare } from "../../src/judge/compare";
export { CONTEXT_CHARS } from "../../src/judge/judge";
