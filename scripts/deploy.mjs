// Runs `wrangler deploy` and fails loudly when the Artifacts push trigger did not register.
// A deploy once lost that step to a Cloudflare 500 ("partially updated", nothing rolled back);
// without the trigger, previews stop building and nothing else says so.
import { spawn } from "node:child_process";

/** What wrangler prints when every event trigger in wrangler.jsonc is registered. */
const TRIGGERS_LINE = /event triggers: 1\b/;

const child = spawn("wrangler", ["deploy", ...process.argv.slice(2)], { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
// Both streams are scanned: wrangler's summary may go to either.
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});
child.on("close", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (!TRIGGERS_LINE.test(output)) {
    console.error("\n✘ The deploy did not report the Artifacts push trigger (\"event triggers: 1\"). Previews will not build: run `npm run deploy` again.");
    process.exit(1);
  }
});
