import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPrice, slugify, wordCount } from "../src/text.ts";

test("slugify makes lower case words joined by hyphens", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Thunder   Brew  "), "thunder-brew");
});

// Fails on purpose: accents are dropped, not kept as plain letters.
test("slugify keeps accented letters as plain letters", () => {
  assert.equal(slugify("Café Crème"), "cafe-creme");
});

test("wordCount counts words split by white space", () => {
  assert.equal(wordCount("one two  three\nfour"), 4);
  assert.equal(wordCount("   "), 0);
});

test("formatPrice formats dollars and cents", () => {
  assert.equal(formatPrice(1999), "$19.99");
  assert.equal(formatPrice(450), "$4.50");
});

// Fails on purpose: cents below 10 lose their leading zero.
test("formatPrice pads cents to two digits", () => {
  assert.equal(formatPrice(1205), "$12.05");
  assert.equal(formatPrice(500), "$5.00");
});
