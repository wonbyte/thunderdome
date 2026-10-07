// Prints the site's link-preview card (src/routes/card.ts siteCardHtml) as a page. Shoot it at
// 1200x630 in any browser and save it as public/og.png:
//   node scripts/build-og.mjs > /tmp/og.html
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/routes/card.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent",
});
const code = out.outputFiles[0]?.text ?? "";
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
process.stdout.write(mod.siteCardHtml());
