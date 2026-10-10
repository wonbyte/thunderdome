// Checkout: what an order costs. The shop promises its customers these rules:
// - The subtotal is each line's price times its quantity, added up.
// - The code SAVE10 takes 10% off the subtotal, rounded to the nearest cent.
// - Shipping is $5.99. An order of $50.00 or more ships free, counted after the discount.
// - An empty cart costs nothing: no shipping, a total of $0.00.
export const SHIPPING_CENTS = 599;
export const FREE_SHIPPING_CENTS = 50;

export interface CartLine {
  title: string;
  cents: number;
  qty: number;
}

export interface Totals {
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
}

export function checkout(lines: CartLine[], code?: string): Totals {
  const subtotal = lines.reduce((sum, line) => sum + line.cents * line.qty, 0);
  const discount = code === "SAVE10" ? Math.round(subtotal / 10) : 0;
  const shipping = subtotal >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
  return { subtotal, discount, shipping, total: subtotal - discount + shipping };
}

// An amount in cents as dollars: 1999 -> "$19.99".
export function formatPrice(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
