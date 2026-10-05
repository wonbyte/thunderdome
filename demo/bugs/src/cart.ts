import { findProduct, type Product } from "./catalog.ts";
import { percentOf } from "./money.ts";

// Buy this many of one product and that line gets BULK_PERCENT off.
export const BULK_QTY = 3;
export const BULK_PERCENT = 10;
// Orders of at least this much (after discounts) ship free.
export const FREE_SHIPPING_CENTS = 5000;
export const SHIPPING_CENTS = 599;

export interface CartLine {
  slug: string;
  qty: number;
}

export interface PricedLine extends CartLine {
  product: Product;
  cents: number; // qty × price, before the discount
  discount: number;
}

export interface Totals {
  lines: PricedLine[];
  subtotal: number; // after discounts
  shipping: number;
  total: number;
}

export class UnknownProductError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`Unknown product: ${slug}`);
    this.slug = slug;
  }
}

// Parses "thunder-brew:3,thunderdome-mug" (qty defaults to 1).
export function parseCart(items: string): CartLine[] {
  return items
    .split(",")
    .filter((item) => item !== "")
    .map((item) => {
      const [slug = "", qty = "1"] = item.split(":");
      return { slug, qty: Number(qty) };
    });
}

export function priceCart(lines: CartLine[]): Totals {
  const priced = lines.map((line) => {
    const product = findProduct(line.slug);
    if (product === undefined) throw new UnknownProductError(line.slug);
    const cents = product.cents * line.qty;
    const discount = line.qty > BULK_QTY ? percentOf(cents, BULK_PERCENT) : 0;
    return { ...line, product, cents, discount };
  });
  const subtotal = priced.reduce((sum, line) => sum + line.cents - line.discount, 0);
  const shipping = subtotal > FREE_SHIPPING_CENTS || subtotal === 0 ? 0 : SHIPPING_CENTS;
  return { lines: priced, subtotal, shipping, total: subtotal + shipping };
}
