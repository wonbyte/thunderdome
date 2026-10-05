import { parseCart, priceCart, type Totals } from "./cart.ts";
import { PRODUCTS } from "./catalog.ts";
import { formatPrice } from "./money.ts";
import { slugify } from "./slug.ts";

// The cart shown on the home page.
export const SAMPLE_CART = "cafe-creme:2,thunder-brew:3";

export function renderPage(totals: Totals): string {
  const products = PRODUCTS.map(
    (product) => `<li id="${slugify(product.title)}"><strong>${product.title}</strong> ${formatPrice(product.cents)}</li>`,
  ).join("\n");
  const lines = totals.lines
    .map(
      (line) =>
        `<tr><td>${line.product.title} × ${line.qty}</td><td>${formatPrice(line.cents)}</td>` +
        `<td>${line.discount > 0 ? `-${formatPrice(line.discount)}` : ""}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Thunderdome Shop</title></head>
<body>
<h1>Thunderdome Shop</h1>
<ul>
${products}
</ul>
<h2>Sample cart</h2>
<table>
${lines}
<tr><td>Subtotal</td><td id="subtotal">${formatPrice(totals.subtotal)}</td></tr>
<tr><td>Shipping</td><td id="shipping">${formatPrice(totals.shipping)}</td></tr>
<tr><td>Total</td><td id="total">${formatPrice(totals.total)}</td></tr>
</table>
</body>
</html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/cart") {
      const totals = priceCart(parseCart(url.searchParams.get("items") ?? ""));
      return Response.json({ subtotal: totals.subtotal, shipping: totals.shipping, total: totals.total });
    }
    return new Response(renderPage(priceCart(parseCart(SAMPLE_CART))), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
