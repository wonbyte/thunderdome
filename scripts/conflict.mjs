// Live conflict race check: node --env-file=.env scripts/conflict.mjs
// Runs two races at once on one source repo (a fresh fork of thunderdome-clash). Both change the
// routes and the page, so the race that ships second conflicts and starts the conflict race.
// Prints both verdicts' ship results. Prints no tokens. About $1 in agent spend.
const B = process.env.THUNDERDOME_URL ?? "https://thunderdome.wonbyte.dev";
const auth = { authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const REVIEWS =
  "Add product reviews. `GET /api/products/:slug/reviews` returns `{ average, count, reviews }` (average to one decimal, " +
  "`null` when there are none; 404 for an unknown product), and the shop page shows each product's star average and review count. " +
  "Make the failing tests pass.";
const SEARCH =
  "Add search. `GET /api/products?q=<text>` returns only the products whose name contains the text, ignoring case, and the shop " +
  "page has a search box that submits `/?q=<text>` and lists only the matching products. Add tests for both. Keep every passing test passing.";

async function create(body) {
  const res = await fetch(`${B}/tasks`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ...body, agents: 3 }) });
  const task = await res.json();
  if (!task.id) throw new Error(`create failed: ${JSON.stringify(task)}`);
  return task;
}

// Starts the race and resolves with the task once its verdict is saved.
async function race(label, id) {
  const ws = new WebSocket(`${B.replace("https", "wss")}/tasks/${id}/live`, { headers: auth });
  const done = new Promise((resolve) => {
    ws.addEventListener("message", (m) => {
      const e = JSON.parse(m.data);
      if (e.kind === "agent-end" || e.kind === "verdict") console.log(at(), label, e.kind, e.agent ?? e.verdict?.winner ?? "");
      if (e.kind === "verdict") resolve();
    });
    ws.addEventListener("close", () => resolve());
  });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const run = await (await fetch(`${B}/tasks/${id}/run`, { method: "POST", headers: auth })).json();
  console.log(at(), label, "run", run.status ?? JSON.stringify(run));
  await Promise.race([done, new Promise((r) => setTimeout(r, 25 * 60_000))]);
  ws.close();
  return (await fetch(`${B}/tasks/${id}`, { headers: auth })).json();
}

const a = await create({ template: "thunderdome-clash", prompt: REVIEWS });
console.log(at(), "reviews", a.id, "source", a.repo);
const b = await create({ repo: a.repo, prompt: SEARCH });
console.log(at(), "search", b.id, "source", b.repo);
const tasks = await Promise.all([race("reviews", a.id), race("search", b.id)]);

for (const task of tasks) {
  const ship = task.verdict?.ship;
  console.log(`\n${task.id} winner ${task.verdict?.winner} ship ${ship?.status} commit ${ship?.commit ?? "-"}`);
  if (ship?.resolve === undefined) continue;
  console.log("conflict in", ship.resolve.files.join(", "), "chosen", ship.resolve.chosen ?? "none", ship.resolve.error ?? "");
  for (const r of ship.resolve.attempts) {
    const tests = r.tests ? `${r.tests.passed}/${r.tests.total}` : "-";
    console.log(" ", r.agent, r.status, `${r.seconds}s`, "tests", tests, "cost", r.costUsd?.toFixed(2) ?? "-", r.note ?? "");
  }
  if (ship.resolve.kept) console.log("  kept", ship.resolve.kept.join(", "));
}
process.exit(tasks.some((t) => t.verdict?.ship?.resolve !== undefined) ? 0 : 2);
