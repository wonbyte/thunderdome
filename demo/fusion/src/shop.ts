// The four parts of the shop page. Each one is its own function, so each can change on its own.
import type { Product } from "./catalog.ts";

// ---------------------------------------------------------------------------------------------
// Part 1: the sale badge.
// A product on sale shows "Sale -N%": N is the percent off, rounded to a whole number.
// A product not on sale shows no badge ("").
// ---------------------------------------------------------------------------------------------
export function saleBadge(product: Product): string {
  return "";
}

// ---------------------------------------------------------------------------------------------
// Part 2: the sort.
// "price" lists the cheapest first (a sale price counts), "name" lists A to Z, anything else
// keeps the catalog order. The list passed in is never changed.
// ---------------------------------------------------------------------------------------------
export function sortProducts(products: Product[], sort: string | null): Product[] {
  return products;
}

// ---------------------------------------------------------------------------------------------
// Part 3: the cart line.
// The line above the products that says what is in the cart.
// ---------------------------------------------------------------------------------------------
export function cartMessage(count: number): string {
  return `${count} items`;
}

// ---------------------------------------------------------------------------------------------
// Part 4: the price format.
// An amount in cents as dollars: 1999 -> "$19.99".
// ---------------------------------------------------------------------------------------------
export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${rest}`;
}
