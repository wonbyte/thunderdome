import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCart, priceCart, SHIPPING_CENTS } from "../src/cart.ts";

test("parseCart reads slugs and quantities", () => {
  assert.deepEqual(parseCart("thunder-brew:3,thunderdome-mug"), [
    { slug: "thunder-brew", qty: 3 },
    { slug: "thunderdome-mug", qty: 1 },
  ]);
});

test("a small order pays shipping", () => {
  const totals = priceCart(parseCart("thunderdome-mug"));
  assert.equal(totals.shipping, SHIPPING_CENTS);
  assert.equal(totals.total, 1999 + SHIPPING_CENTS);
});

test("3 of one product get the bulk discount", () => {
  const totals = priceCart(parseCart("thunder-brew:3"));
  assert.equal(totals.lines[0]?.discount, 362);
  assert.equal(totals.subtotal, 3615 - 362);
});

test("an order of exactly $50.00 ships free", () => {
  const totals = priceCart(parseCart("judge-notebook:2"));
  assert.equal(totals.subtotal, 5000);
  assert.equal(totals.shipping, 0);
});

test("accented titles are found by their plain slug", () => {
  const totals = priceCart(parseCart("cafe-creme:2"));
  assert.equal(totals.lines[0]?.product.title, "Café Crème");
});
