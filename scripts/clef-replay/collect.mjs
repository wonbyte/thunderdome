// Clones each fork of the given races and saves its function-context diff, as the judge builds it.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
const [dir, ...ids] = process.argv.slice(2);
const LIVE = "https://thunderdome.wonbyte.dev";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
for (const id of ids) {
  const task = await (await fetch(`${LIVE}/tasks/${id}`)).json();
  const judge = await (await fetch(`${LIVE}/tasks/${id}/judge`)).json();
  const forks = [];
  for (const slot of task.agents) {
    const own = (slot.push?.log ?? []).filter((l) => !(l.message ?? "").startsWith("Thunderdome fusion"));
    const head = own.at(-1)?.commit;
    const judged = judge.output?.forks?.find((f) => f.agent === slot.name);
    if (head === undefined || judged === undefined) { console.log(id, slot.name, "skip: no head or not judged"); continue; }
    const ns = new URL(slot.remote).pathname.split("/")[2];
    const tok = JSON.parse(run("cf", ["artifacts", "namespaces", "tokens", "create", ns, "--repo", slot.fork, "--scope", "read", "--ttl", "600"])).plaintext;
    const repo = `${dir}/git/${slot.fork}`;
    if (existsSync(repo)) rmSync(repo, { recursive: true });
    const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${tok}` };
    run("git", ["clone", "--quiet", "--no-checkout", slot.remote, repo], { env, stdio: ["ignore", "ignore", "pipe"] });
    const diff = run("git", ["-C", repo, "diff", "--no-renames", "--function-context", task.baseCommit, head]);
    const numstat = run("git", ["-C", repo, "diff", "--no-renames", "--numstat", task.baseCommit, head]);
    forks.push({ agent: slot.name, head, diff, numstat, input: judged.input });
  }
  mkdirSync(`${dir}/races`, { recursive: true });
  writeFileSync(`${dir}/races/${id}.json`, JSON.stringify({ id, task: task.prompt, winner: judge.output?.winner ?? null, decidedBy: judge.output?.scores?.tie?.by, forks }));
  console.log(id, forks.length, "forks");
}
