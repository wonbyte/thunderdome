import assert from "node:assert/strict";
import { test } from "node:test";

import { checkout, SHIPPING_CENTS } from "../src/checkout.ts";
import worker from "../src/index.ts";

const mug = { title: "Thunderdome Mug", cents: 2000, qty: 1 };
const desk = { title: "Arena Desk", cents: 6000, qty: 1 };

test("the subtotal adds up every line", () => {
  assert.equal(checkout([mug, { ...desk, qty: 2 }]).subtotal, 14000);
});

test("SAVE10 takes 10% off", () => {
  const totals = checkout([desk], "SAVE10");
  assert.equal(totals.discount, 600);
  assert.equal(totals.total, 5400);
});

test("a $60 order ships free", () => {
  assert.equal(checkout([desk]).shipping, 0);
});

test("a $20 order pays shipping", () => {
  const totals = checkout([mug]);
  assert.equal(totals.shipping, SHIPPING_CENTS);
  assert.equal(totals.total, 2000 + SHIPPING_CENTS);
});

test("the page shows the sample order's total", async () => {
  const html = await (await worker.fetch(new Request("https://shop.test/"))).text();
  assert.match(html, /id="total"/);
});
