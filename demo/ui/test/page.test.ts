import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCTS, slugOf } from "../src/catalog.ts";
import worker from "../src/index.ts";

const page = async (path = "/") => (await worker.fetch(new Request(`https://shop.test${path}`))).text();

// The HTML of one product's element: from its id="<slug>" to the next product's id or the end.
function productHtml(html: string, slug: string): string {
  const start = html.indexOf(`id="${slug}"`);
  assert.ok(start >= 0, `no element with id="${slug}"`);
  const next = PRODUCTS.map((product) => html.indexOf(`id="${slugOf(product)}"`, start + 1)).filter((at) => at > start);
  return html.slice(start, next.length > 0 ? Math.min(...next) : undefined);
}

// Product slugs in page order.
function order(html: string): string[] {
  return PRODUCTS.map(slugOf)
    .map((slug) => ({ slug, at: html.indexOf(`id="${slug}"`) }))
    .sort((a, b) => a.at - b.at)
    .map((item) => item.slug);
}

test("page lists every product with its price", async () => {
  const html = await page();
  for (const product of PRODUCTS) assert.match(productHtml(html, slugOf(product)), new RegExp(product.title));
  assert.match(productHtml(html, "thunderdome-mug"), /\$19\.99/);
});

test("products API returns a slug for each product", async () => {
  const response = await worker.fetch(new Request("https://shop.test/api/products"));
  const products = (await response.json()) as { slug: string }[];
  assert.deepEqual(products.map((product) => product.slug), PRODUCTS.map(slugOf));
});

test("a product on sale shows a Sale badge, the sale price, and the old price struck through", async () => {
  const html = productHtml(await page(), "thunder-brew");
  assert.match(html, /class="[^"]*\bbadge\b[^"]*"[^>]*>\s*Sale\s*</);
  assert.match(html, /\$9\.99/);
  assert.match(html, /<s\b[^>]*>\s*\$12\.05\s*<\/s>/);
});

test("a product not on sale has no badge", async () => {
  assert.doesNotMatch(productHtml(await page(), "thunderdome-mug"), /badge|<s\b/);
});

test("?sort=price lists the cheapest price first, using sale prices", async () => {
  assert.deepEqual(order(await page("/?sort=price")), ["cafe-creme", "fork-stickers", "thunder-brew", "judge-notebook", "thunderdome-mug"]);
});

test("without ?sort the catalog order is kept", async () => {
  assert.deepEqual(order(await page()), PRODUCTS.map(slugOf));
});

test("the page links to both sort orders", async () => {
  const html = await page();
  assert.match(html, /href="\/?\?sort=price"/);
  assert.match(html, /href="\/"/);
});
