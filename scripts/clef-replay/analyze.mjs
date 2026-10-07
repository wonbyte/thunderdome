// Replays old races through the current Clef questions: noise per fork across harmless rewrites, and each race's winner then.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const run = promisify(execFile);
const dir = process.argv[2];
const { averageResults, scoreForks, compareRequest, parseCompare, CLEF_MODEL_ID, CONTEXT_CHARS } = await import(pathToFileURL(`${dir}/judge.mjs`).href);
const A = JSON.parse(readFileSync(`${dir}/answers.json`, "utf8"));
const races = readdirSync(`${dir}/races`).map((f) => JSON.parse(readFileSync(`${dir}/races/${f}`, "utf8")));
const pts = (r, visual) => r.taskFit * (visual ? 20 : 25) + r.clarity * (visual ? 10 : 15);
const noise = [], single = [];
const report = [];
let n = 0;
async function compare(task, changes) {
  const once = async (ordered) => {
    const file = `${dir}/cmp-${n++}.json`;
    writeFileSync(file, JSON.stringify(compareRequest(task, ordered)));
    const { stdout } = await run("cf", ["ai", "run", CLEF_MODEL_ID, "--body", `@${file}`], { maxBuffer: 16 << 20 });
    return parseCompare(JSON.parse(stdout), changes.map((c) => c.agent));
  };
  const [a, b] = await Promise.all([once(changes), once(changes.toReversed())]);
  return Object.fromEntries(changes.map((c) => [c.agent, Math.round(((a[c.agent] + b[c.agent]) / 2) * 1e4) / 1e4]));
}
for (const race of races.toSorted((a, b) => a.id.localeCompare(b.id))) {
  const visual = race.forks.some((f) => f.input.look !== undefined);
  const inputs = [];
  for (const f of race.forks) {
    const g = (k) => A[`${race.id}/${f.agent}/${k}`];
    const pairs = [["v0", "v1"], ["s0", "s1"], ["f0", "f1"]].map(([x, y]) => averageResults(g(x), g(y)));
    const p = pairs.map((r) => pts(r, visual));
    noise.push(Math.max(...p) - Math.min(...p));
    const s = ["v0", "v1", "s0", "s1", "f0", "f1"].map((k) => pts(g(k), visual));
    single.push(Math.max(...s) - Math.min(...s));
    inputs.push({ ...f.input, taskFit: pairs[0].taskFit, clarity: pairs[0].clarity });
  }
  let scores = scoreForks(inputs);
  let prefer;
  if (scores.tie && scores.tie.agents.length > 1) {
    const changes = scores.tie.agents.map((agent) => { const d = race.forks.find((f) => f.agent === agent).diff; return { agent, diff: d.length <= CONTEXT_CHARS ? d : `${d.slice(0, CONTEXT_CHARS)}\n[diff clipped at ${CONTEXT_CHARS} chars]` }; });
    prefer = await compare(race.task, changes);
    scores = scoreForks(inputs, prefer);
  }
  report.push({ id: race.id, forks: race.forks.length, visual, oldWinner: race.winner, newWinner: scores.winner, tie: scores.tie ? `${scores.tie.by} [${scores.tie.agents.join(",")}] gap ${scores.tie.gap}` : "-", prefer,
    totals: scores.ranked.map((s) => `${s.agent} ${s.total}`).join("  "), prompt: race.task.slice(0, 40) });
}
const q = (arr, p) => { const s = arr.toSorted((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(JSON.stringify({ forks: noise.length, averaged: { max: Math.max(...noise).toFixed(2), p90: q(noise, 0.9).toFixed(2), median: q(noise, 0.5).toFixed(2) }, singleCall: { max: Math.max(...single).toFixed(2), p90: q(single, 0.9).toFixed(2), median: q(single, 0.5).toFixed(2) } }, null, 1));
for (const r of report) console.log(`${r.id} ${r.forks}f ${r.visual ? "visual" : "      "} old=${r.oldWinner} new=${r.newWinner} ${r.oldWinner === r.newWinner ? "same" : "CHANGED"} | tie ${r.tie}${r.prefer ? " prefer " + JSON.stringify(r.prefer) : ""}\n    ${r.totals}   (${r.prompt})`);
writeFileSync(`${dir}/report.json`, JSON.stringify({ noise, single, report }, null, 1));
