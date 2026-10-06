import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEMO_APPS, SAMPLE_FILES } from "../src/generated/sample-files";

const demoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "demo");
const sampleDir = join(demoDir, "sample-app");

// Test names that fail, from `node --test` TAP output, run in demo/<app>.
function failingTests(app: string): string[] {
  const dir = join(demoDir, app);
  const tests = Object.keys(DEMO_APPS[app] ?? {}).filter((file) => /^test\/.*\.test\.ts$/.test(file));
  const run = spawnSync("node", ["--test", "--test-reporter=tap", ...tests], { cwd: dir, encoding: "utf8" });
  return [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1] ?? "").toSorted();
}

describe("sample app", () => {
  it("is packed for seeding", () => {
    expect(Object.keys(SAMPLE_FILES)).toEqual(
      expect.arrayContaining(["package.json", "src/index.ts", "src/text.ts", "test/text.test.ts"]),
    );
  });

  it("has exactly the two task tests failing", () => {
    const run = spawnSync("node", ["--test", "--test-reporter=tap", "test/index.test.ts", "test/text.test.ts"], { cwd: sampleDir, encoding: "utf8" });
    const failed = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
    expect(failed).toEqual([
      "slugify keeps accented letters as plain letters",
      "formatPrice pads cents to two digits",
    ]);
  });
});

// Each demo app is a template for one demo task. Its failing tests are the task.
describe("demo apps", () => {
  it("are all packed, each with a Worker entry and npm test", () => {
    expect(Object.keys(DEMO_APPS).toSorted()).toEqual(["bugs", "clash", "sample-app", "ui"]);
    for (const files of Object.values(DEMO_APPS)) {
      expect(files).toHaveProperty("src/index.ts");
      expect(JSON.parse(files["package.json"] ?? "{}").scripts.test).toBe("node --test test/*.test.ts");
    }
  });

  it.each([
    [
      "bugs",
      [
        "3 of one product get the bulk discount",
        "accented titles are found by their plain slug",
        "an order of exactly $50.00 ships free",
        "cart API answers 400 for an unknown product",
        "home page shows the sample cart",
        "percentOf rounds to the nearest cent",
      ],
    ],
    [
      "ui",
      [
        "?sort=price lists the cheapest price first, using sale prices",
        "a product on sale shows a Sale badge, the sale price, and the old price struck through",
        "the page links to both sort orders",
      ],
    ],
    [
      "clash",
      [
        "page shows each product's star average and review count",
        "reviews API averages to one decimal and answers an empty list for no reviews",
        "reviews API returns a product's reviews and their average",
      ],
    ],
  ])("%s has exactly its task tests failing", (app, failing) => {
    expect(failingTests(app)).toEqual(failing);
  });
});
