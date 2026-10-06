import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCTS } from "../src/catalog.ts";
import worker from "../src/index.ts";
import { formatPrice, saleBadge, sortProducts } from "../src/shop.ts";

const bySlug = (slug: string) => PRODUCTS.find((p) => p.slug === slug)!;

test("the page lists every product", async () => {
  const html = await (await worker.fetch(new Request("https://shop.test/"))).text();
  for (const product of PRODUCTS) assert.match(html, new RegExp(`id="${product.slug}"`));
});

test("a whole price shows dollars and cents", () => {
  assert.equal(formatPrice(1999), "$19.99");
  assert.equal(formatPrice(600), "$6.00");
});

test("a product on sale shows its percent off", () => {
  assert.equal(saleBadge(bySlug("judge-notebook")), "Sale -28%");
  assert.equal(saleBadge(bySlug("thunder-brew")), "Sale -17%");
});

test("a product not on sale shows no badge", () => {
  assert.equal(saleBadge(bySlug("thunderdome-mug")), "");
});

test("sort=price lists the cheapest first, sale prices count", () => {
  assert.deepEqual(
    sortProducts(PRODUCTS, "price").map((p) => p.slug),
    ["fork-stickers", "thunder-brew", "judge-notebook", "thunderdome-mug", "arena-desk"],
  );
});

test("no sort keeps the catalog order and never changes the list", () => {
  const before = PRODUCTS.map((p) => p.slug);
  assert.deepEqual(sortProducts(PRODUCTS, null).map((p) => p.slug), before);
  sortProducts(PRODUCTS, "price");
  assert.deepEqual(PRODUCTS.map((p) => p.slug), before);
});
