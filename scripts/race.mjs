// Live race check: node --env-file=.env scripts/race.mjs <prompt>   (trap, ui, clash, clash-full, fusion; prompts in demo/README.md)
// AGENTS=5 races 5 robots instead of 3. TEMPLATE=<repo> races another template repo with the same prompt (to try a demo change).
// HOTFIX=1 plays a teammate: at the first robot push (a minute at most) it pushes a small fix to the race's source repo on a line the robots
// must edit (see HOTFIXES), so the winner's merge conflicts and the conflict race runs. Needs the `cf` login; +$0.10–0.30.
// Creates a task from template thunderdome-<app> (the prompt name up to its first "-") with the prompt in demo/README.md, watches
// /tasks/:id/live until the verdict, then fetches the base and agent previews. Prints no tokens.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The teammate's hotfix per app: one line every robot's fix replaces, so the merge must conflict.
// Base tests that pass keep passing, so a resolver can still ship.
const HOTFIXES = {
  fusion: {
    file: "src/shop.ts",
    find: '  return "";\n',
    replace: '  return product.saleCents === undefined ? "" : "Sale";\n',
    message: "Hotfix: show a Sale badge on sale items",
  },
};

const B = process.env.THUNDERDOME_URL ?? "https://thunderdome.wonbyte.dev";
const app = process.argv[2];
const md = readFileSync(new URL("../demo/README.md", import.meta.url), "utf8");
const block = md.split(`**${app}**`)[1]?.split("**")[0] ?? "";
const prompt = block.split("\n").filter((l) => l.startsWith(">")).map((l) => l.replace(/^>\s?/, "").trim()).join(" ");
if (!prompt) throw new Error(`no prompt for ${app}`);
const hotfix = process.env.HOTFIX ? HOTFIXES[app.split("-")[0]] : undefined;
if (process.env.HOTFIX && !hotfix) throw new Error(`no hotfix for ${app} (have: ${Object.keys(HOTFIXES).join(", ")})`);

const auth = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const short = (e) => JSON.stringify(e, (k, v) => (k === "why" || k === "text" || k === "summary" ? undefined : v)).slice(0, 220);

const created = await (await fetch(`${B}/tasks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ template: process.env.TEMPLATE ?? `thunderdome-${app.split("-")[0]}`, prompt, agents: Number(process.env.AGENTS ?? 3) }),
})).json();
const id = created.id;
console.log(at(), "task", id, created.status, "source", created.repo, created.error ?? "");
if (!id) process.exit(1);

const ws = new WebSocket(`${B.replace("https", "wss")}/tasks/${id}/live`, { headers: auth });
const done = new Promise((resolve) => {
  ws.addEventListener("message", (m) => {
    const e = JSON.parse(m.data);
    // The hotfix goes in on the first robot push: well before the ship, after the base preview.
    if (hotfix && e.kind === "push") fireHotfix();
    if (e.kind === "step" || e.kind === "steps" || e.kind === "snapshot" || e.kind === "claim") return;
    console.log(at(), e.kind, short(e));
    if (e.kind === "verdict") resolve();
  });
  ws.addEventListener("close", () => resolve());
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const run = await (await fetch(`${B}/tasks/${id}/run`, { method: "POST", headers: auth })).json();
console.log(at(), "run", run.status ?? JSON.stringify(run));
if (hotfix) setTimeout(fireHotfix, 60_000); // fallback; the first robot push usually fires it sooner
// A conflict race adds up to 5 minutes of resolvers plus the ship.
await Promise.race([done, new Promise((r) => setTimeout(r, (hotfix ? 25 : 15) * 60_000))]);
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
const resolve = task.verdict?.ship?.resolve;
if (resolve) {
  console.log("conflict in", resolve.files.join(", "), "chosen", resolve.chosen ?? "none", resolve.error ?? "");
  for (const r of resolve.attempts) {
    const tests = r.tests ? `${r.tests.passed}/${r.tests.total}` : "-";
    console.log(" ", r.agent, r.status, `${r.seconds}s`, "tests", tests, "cost", r.costUsd?.toFixed(2) ?? "-", r.note ?? "");
  }
} else if (hotfix) console.log("no conflict race (ship", task.verdict?.ship?.status, ")");
process.exit(0);

let hotfixFired = false;
function fireHotfix() {
  if (hotfixFired) return;
  hotfixFired = true;
  void pushHotfix(created.repo).catch((e) => console.log(at(), "hotfix failed:", e.message));
}

// Clones the source with a 10-minute write token, applies the hotfix and pushes it. The token
// goes only in git's env (an extra header), never in a URL, the config or the output.
async function pushHotfix(repo) {
  const state = await (await fetch(`${B}/tasks/${id}`, { headers: auth })).json();
  const forkRemote = state.agents?.[0]?.remote;
  if (typeof forkRemote !== "string") throw new Error("no fork remote on the task");
  const remote = forkRemote.replace(/[^/]+\.git$/, `${repo}.git`);
  const out = execFileSync("cf", ["artifacts", "namespaces", "tokens", "create", "thunderdome", "--repo", repo, "--scope", "write", "--ttl", "600"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const token = JSON.parse(out).plaintext;
  if (typeof token !== "string") throw new Error("token create returned no plaintext");
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
  const dir = mkdtempSync(join(tmpdir(), "hotfix-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    git("clone", "--quiet", remote, ".");
    const path = join(dir, hotfix.file);
    const before = readFileSync(path, "utf8");
    if (!before.includes(hotfix.find)) throw new Error(`hotfix line not found in ${hotfix.file}`);
    writeFileSync(path, before.replace(hotfix.find, hotfix.replace));
    git("-c", "user.name=Teammate", "-c", "user.email=teammate@thunderdome.invalid", "commit", "--quiet", "-am", hotfix.message);
    git("push", "--quiet", "origin", "HEAD");
    console.log(at(), "hotfix pushed to", repo, git("rev-parse", "--short", "HEAD").trim(), hotfix.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
