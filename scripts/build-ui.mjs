// Bundles the page scripts into public/: src/ui/app.ts → race.js (a race) and src/ui/races.ts → races.js (the gallery),
// src/ui/playpage.ts → play.js (run your own race).
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;

await build({
  absWorkingDir: root,
  entryPoints: [
    { in: "src/ui/app.ts", out: "race" },
    { in: "src/ui/races.ts", out: "races" },
    { in: "src/ui/playpage.ts", out: "play" },
  ],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  outdir: "public",
  logLevel: "warning",
});
console.log("Bundled the page scripts into public/race.js, races.js and play.js");
