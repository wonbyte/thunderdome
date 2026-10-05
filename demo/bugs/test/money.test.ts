import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPrice, percentOf } from "../src/money.ts";

test("formatPrice pads cents to two digits", () => {
  assert.equal(formatPrice(1999), "$19.99");
  assert.equal(formatPrice(1205), "$12.05");
});

test("percentOf rounds to the nearest cent", () => {
  assert.equal(percentOf(1000, 10), 100);
  assert.equal(percentOf(1205, 10), 121);
});
