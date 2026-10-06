// Live race check: node --env-file=.env scripts/race.mjs <prompt>   (bugs, ui, clash, clash-full; prompts in demo/README.md)
// Creates a task from template thunderdome-<app> (the prompt name up to its first "-") with the prompt in demo/README.md, watches
// /tasks/:id/live until the verdict, then fetches the base and agent previews. Prints no tokens.
import { readFileSync } from "node:fs";

const B = process.env.THUNDERDOME_URL ?? "https://thunderdome.git-bc1.workers.dev";
const app = process.argv[2];
const md = readFileSync(new URL("../demo/README.md", import.meta.url), "utf8");
const block = md.split(`**${app}**`)[1]?.split("**")[0] ?? "";
const prompt = block.split("\n").filter((l) => l.startsWith(">")).map((l) => l.replace(/^>\s?/, "").trim()).join(" ");
if (!prompt) throw new Error(`no prompt for ${app}`);

const auth = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const short = (e) => JSON.stringify(e, (k, v) => (k === "why" || k === "text" || k === "summary" ? undefined : v)).slice(0, 220);

const created = await (await fetch(`${B}/tasks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ template: `thunderdome-${app.split("-")[0]}`, prompt, agents: 3 }),
})).json();
const id = created.id;
console.log(at(), "task", id, created.status, "source", created.repo, created.error ?? "");
if (!id) process.exit(1);

const ws = new WebSocket(`${B.replace("https", "wss")}/tasks/${id}/live`, { headers: auth });
const done = new Promise((resolve) => {
  ws.addEventListener("message", (m) => {
    const e = JSON.parse(m.data);
    if (e.kind === "step" || e.kind === "steps" || e.kind === "snapshot" || e.kind === "claim") return;
    console.log(at(), e.kind, short(e));
    if (e.kind === "verdict") resolve();
  });
  ws.addEventListener("close", () => resolve());
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const run = await (await fetch(`${B}/tasks/${id}/run`, { method: "POST", headers: auth })).json();
console.log(at(), "run", run.status ?? JSON.stringify(run));
await Promise.race([done, new Promise((r) => setTimeout(r, 15 * 60_000))]);
// The base preview can land after the verdict on a fast race; give it a moment.
let task;
for (let i = 0; i < 12; i++) {
  task = await (await fetch(`${B}/tasks/${id}`, { headers: auth })).json();
  if (task.basePreview) break;
  await new Promise((r) => setTimeout(r, 5_000));
}
ws.close();

console.log("\nwinner", task.verdict?.winner, "ship", task.verdict?.ship?.status, "baseCommit", task.baseCommit);
console.log(task.verdict?.why?.split("\n").slice(0, 7).join("\n"));
const targets = [["base", task.basePreview?.url], ...task.agents.map((a) => [a.name, a.push?.preview?.url])];
for (const [name, url] of targets) {
  if (!url) { console.log("preview", name, "none"); continue; }
  const r = await fetch(url);
  const body = await r.text();
  console.log("preview", name, r.status, url, (body.match(/<td id="total">[^<]*|<li id="[^"]+">.*?<\/li>/)?.[0] ?? body.slice(0, 100)).replace(/\s+/g, " "));
}
for (const a of task.agents) console.log("agent", a.name, a.status, "pushes", a.push?.pushes, "cost", a.costUsd?.toFixed(2));
process.exit(0);
