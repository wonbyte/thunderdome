// Asks Clef six harmless variants of each collected fork (both file orders, index lines dropped, files_changed reversed).
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const run = promisify(execFile);
const dir = process.argv[2];
const { buildRequest, reverseFiles, parseResponse, authorName, CLEF_MODEL_ID } = await import(pathToFileURL(`${dir}/judge.mjs`).href);
const stripIndex = (d) => d.split("\n").filter((l) => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l)).join("\n");
function numstat(text) {
  const out = { filesChanged: [], linesAdded: 0, linesRemoved: 0 };
  for (const line of text.split("\n")) { const [a, r, ...p] = line.split("\t"); if (!p.length) continue; out.filesChanged.push(p.join("\t")); out.linesAdded += Number(a) || 0; out.linesRemoved += Number(r) || 0; }
  return out;
}
let n = 0;
async function ask(body, tag) {
  const file = `${dir}/req-${process.pid}-${n++}.json`;
  writeFileSync(file, JSON.stringify(body));
  for (let i = 0; i < 4; i++) {
    try {
      const { stdout } = await run("cf", ["ai", "run", CLEF_MODEL_ID, "--body", `@${file}`], { maxBuffer: 16 << 20 });
      return parseResponse(JSON.parse(stdout));
    } catch (e) { if (i === 3) { console.error(tag, String(e).slice(0, 200)); return undefined; } await new Promise((r) => setTimeout(r, 2000)); }
  }
}
const jobs = [];
for (const f of readdirSync(`${dir}/races`)) {
  const race = JSON.parse(readFileSync(`${dir}/races/${f}`, "utf8"));
  for (const fork of race.forks) {
    const ns = numstat(fork.numstat);
    const base = { task: race.task, author: authorName(fork.agent), ...ns };
    const rev = reverseFiles(fork.diff);
    const variants = {
      v0: buildRequest({ ...base, diff: fork.diff }),
      v1: buildRequest({ ...base, diff: rev }),
      s0: buildRequest({ ...base, diff: stripIndex(fork.diff) }),
      s1: buildRequest({ ...base, diff: stripIndex(rev) }),
      f0: buildRequest({ ...base, filesChanged: ns.filesChanged.toReversed(), diff: fork.diff }),
      f1: buildRequest({ ...base, filesChanged: ns.filesChanged.toReversed(), diff: rev }),
    };
    for (const [k, body] of Object.entries(variants)) jobs.push({ key: `${race.id}/${fork.agent}/${k}`, body });
  }
}
const outFile = `${dir}/answers.json`;
const answers = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const todo = jobs.filter((j) => answers[j.key] === undefined);
console.log(jobs.length, "jobs,", todo.length, "to do");
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < todo.length) {
    const j = todo[next++];
    const r = await ask(j.body, j.key);
    if (r !== undefined) answers[j.key] = { taskFit: r.taskFit, clarity: r.clarity, raw: r.raw };
    if (next % 20 === 0) { writeFileSync(outFile, JSON.stringify(answers)); console.log(next); }
  }
}));
writeFileSync(outFile, JSON.stringify(answers));
console.log("done", Object.keys(answers).length);
