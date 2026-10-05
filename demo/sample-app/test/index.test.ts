import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { PRODUCTS, renderPage } from "../src/index.ts";

test("page lists every product", () => {
  const html = renderPage(PRODUCTS);
  for (const product of PRODUCTS) assert.ok(html.includes(product.title));
});

test("products API returns a slug for each product", async () => {
  const response = await worker.fetch(new Request("https://shop.test/api/products"));
  const products = (await response.json()) as { slug: string }[];
  assert.equal(products.length, PRODUCTS.length);
  assert.ok(products.every((product) => product.slug.length > 0));
});
