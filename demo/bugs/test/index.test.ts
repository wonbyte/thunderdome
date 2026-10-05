import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.ts";

const get = (path: string) => worker.fetch(new Request(`https://shop.test${path}`));

test("cart API prices a cart", async () => {
  const response = await get("/api/cart?items=thunderdome-mug");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subtotal: 1999, shipping: 599, total: 2598 });
});

test("cart API answers 400 for an unknown product", async () => {
  const response = await get("/api/cart?items=space-pen:1");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Unknown product: space-pen" });
});

test("home page shows the sample cart", async () => {
  const response = await get("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<td id="total">\$/);
});
