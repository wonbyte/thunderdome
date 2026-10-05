import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCTS, slugOf } from "../src/catalog.ts";
import worker from "../src/index.ts";

const get = (path: string) => worker.fetch(new Request(`https://shop.test${path}`));

// The HTML of one product's element: from its id="<slug>" to the next product's id or the end.
function productHtml(html: string, slug: string): string {
  const start = html.indexOf(`id="${slug}"`);
  assert.ok(start >= 0, `no element with id="${slug}"`);
  const next = PRODUCTS.map((product) => html.indexOf(`id="${slugOf(product)}"`, start + 1)).filter((at) => at > start);
  return html.slice(start, next.length > 0 ? Math.min(...next) : undefined);
}

test("page lists every product", async () => {
  const html = await (await get("/")).text();
  for (const product of PRODUCTS) assert.match(productHtml(html, slugOf(product)), new RegExp(product.title));
});

test("unknown paths answer 404", async () => {
  assert.equal((await get("/nope")).status, 404);
});

test("reviews API returns a product's reviews and their average", async () => {
  const response = await get("/api/products/cafe-creme/reviews");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { average: number; count: number; reviews: { stars: number }[] };
  assert.equal(body.count, 3);
  assert.equal(body.average, 4);
  assert.deepEqual(body.reviews.map((review) => review.stars), [5, 4, 3]);
});

test("reviews API averages to one decimal and answers an empty list for no reviews", async () => {
  const mug = (await (await get("/api/products/thunderdome-mug/reviews")).json()) as { average: number };
  assert.equal(mug.average, 4.5);
  const notebook = (await (await get("/api/products/judge-notebook/reviews")).json()) as { average: number | null; count: number };
  assert.deepEqual(notebook, { average: null, count: 0, reviews: [] });
});

test("reviews API answers 404 for an unknown product", async () => {
  const response = await get("/api/products/space-pen/reviews");
  assert.equal(response.status, 404);
});

test("page shows each product's star average and review count", async () => {
  const html = await (await get("/")).text();
  assert.match(productHtml(html, "thunderdome-mug"), /class="[^"]*\bstars\b[^"]*"[^>]*>[^<]*4\.5/);
  assert.match(productHtml(html, "thunderdome-mug"), /2 reviews/);
  assert.match(productHtml(html, "thunder-brew"), /1 review\b/);
  assert.match(productHtml(html, "judge-notebook"), /No reviews yet/);
});
