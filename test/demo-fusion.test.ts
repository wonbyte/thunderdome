// The fusion demo app (demo/fusion) end to end: real repos, real `npm test`, Clef stubbed. Two
// robots build the same parts differently and only one builds the rest; hunk fusion must keep the
// winner's parts and add the loser's others.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runFusion, type CommandResult } from "../src/judge/fusion";

const run = promisify(execFile);
const ID = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
async function exec(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...ID, ...env } });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
it("demo/fusion: a loser's cart line and price format join the winner's badge and sort", async () => {
  const root = mkdtempSync(join(tmpdir(), "demo-fusion-"));
  const src = join(root, "source");
  cpSync("demo/fusion", src, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main"], src);
  await exec(["git", "add", "-A"], src);
  await exec(["git", "commit", "-qm", "base"], src);
  const edit = async (name: string, f: (s: string) => string) => {
    const dir = join(root, name);
    await exec(["git", "clone", "-q", src, dir], root);
    const p = join(dir, "src/shop.ts");
    writeFileSync(p, f(readFileSync(p, "utf8")));
    await exec(["git", "commit", "-qam", name], dir);
    return dir;
  };
  const badge = (s: string, body: string) => s.replace('export function saleBadge(product: Product): string {\n  return "";\n}', `export function saleBadge(product: Product): string {\n${body}\n}`);
  const sort = (s: string, body: string) => s.replace("  return products;", body);
  const winner = await edit("winner", (s) =>
    sort(badge(s, '  if (product.saleCents === undefined) return "";\n  return `Sale -${Math.round((1 - product.saleCents / product.cents) * 100)}%`;'),
      '  const price = (p: Product): number => p.saleCents ?? p.cents;\n  if (sort === "price") return products.toSorted((a, b) => price(a) - price(b));\n  if (sort === "name") return products.toSorted((a, b) => a.title.localeCompare(b.title));\n  return [...products];'));
  const loser = await edit("loser", (s) =>
    sort(badge(s, '  const sale = product.saleCents;\n  return sale === undefined ? "" : `Sale -${Math.round(100 - (sale * 100) / product.cents)}%`;'),
      '  const list = [...products];\n  if (sort === "price") list.sort((a, b) => (a.saleCents ?? a.cents) - (b.saleCents ?? b.cents));\n  else if (sort === "name") list.sort((a, b) => a.title.localeCompare(b.title));\n  return list;')
      .replace("  return `${count} items`;", '  if (count === 0) return "Your cart is empty";\n  return `${count} ${count === 1 ? "item" : "items"} in your cart`;')
      // A function replacer: a "$$" in a replacement string would turn into "$".
      .replace('  const dollars = Math.floor(cents / 100);\n  const rest = String(cents % 100).padStart(2, "0");\n  return `$${dollars}.${rest}`;', () => '  const whole = Math.round(cents);\n  const dollars = Math.floor(whole / 100).toLocaleString("en-US");\n  return `$${dollars}.${String(whole % 100).padStart(2, "0")}`;'));
  await exec(["git", "clone", "-q", winner, join(root, "workspace/repo")], root);
  const local = (p: string) => (p.startsWith("/workspace") ? join(root, p) : p);
  const deps = {
    // No tester user here: run what asTester wraps (after "/bin/sh -c script tester timeout kill-after") as is.
    exec: (argv: string[], cwd: string, env?: Record<string, string>) => exec((argv[3] === "tester" ? argv.slice(6) : argv).map(local), local(cwd), env),
    ai: { run: async () => ({ answers: { better: { type: "noul", noul: 0.8 } } }) },
  };
  const result = await runFusion(deps, { task: "four parts", winner: "ponder", testsPassed: 6, candidates: [{ agent: "zippy", remote: loser, branch: "main", files: [], shared: ["src/shop.ts"] }] });
  // The loser's badge and sort conflict with the winner's and are not tried; its two other parts join.
  expect(result.tried.map((t) => [t.kind, t.status, t.tests])).toEqual([
    ["hunk", "added", { passed: 6, total: 6 }],
    ["hunk", "added", { passed: 6, total: 6 }],
  ]);
  const shipped = readFileSync(join(root, "workspace/repo/src/shop.ts"), "utf8");
  expect(shipped).toContain("Math.round((1 - product.saleCents / product.cents) * 100)"); // the winner's badge stays
  expect(shipped).toContain('"Your cart is empty"');
  expect(shipped).toContain('toLocaleString("en-US")');
  rmSync(root, { recursive: true, force: true });
  expect(result.tried.filter((t) => t.status === "added").map((t) => t.hunk?.name)).toEqual(["cartMessage", "formatPrice"]);
}, 30_000); // three real `npm test` runs
