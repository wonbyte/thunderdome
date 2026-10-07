import { parseCart, priceCart, type Totals } from "./cart.ts";
import { PRODUCTS } from "./catalog.ts";
import { formatPrice } from "./money.ts";
import { slugify } from "./slug.ts";

// The shop's look: a store header and product cards. Element selectors, so new markup fits in.
const STYLE = "*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c2333;background:#f4f1ea}h1{margin:0;padding:18px 28px;font-size:22px;letter-spacing:.02em;color:#fff;background:linear-gradient(90deg,#1d2440,#3a2f6b)}h1::before{content:'';display:inline-block;width:12px;height:12px;margin-right:10px;border-radius:3px;background:linear-gradient(135deg,#f6c445,#f05a7e)}#cart{display:inline-block;margin:16px 28px 0;padding:5px 12px;border:1px solid #e3ddd0;border-radius:999px;background:#fff;color:#4b5368;font-size:13px}ul{list-style:none;margin:0;padding:16px 28px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}li{padding:14px 16px;border:1px solid #e6e0d4;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(20,24,40,.06);font-variant-numeric:tabular-nums}li strong{display:block;margin-bottom:6px;color:#141a2b;font-size:16px}li s{margin-left:4px;color:#9aa0ad;font-size:13px}.badge{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#e5484d;color:#fff;font:600 11.5px/1.5 system-ui,sans-serif}h2{margin:4px 28px 10px;font-size:16px}table{margin:0 28px 28px;min-width:320px;border-collapse:collapse;border:1px solid #e6e0d4;background:#fff}td{padding:8px 14px}tr+tr{border-top:1px solid #efeae0}@media (max-width:520px){h1{padding:14px 16px}#cart{margin:12px 16px 0}ul{padding:12px 16px 20px}h2{margin:4px 16px 10px}table{margin:0 16px 20px;min-width:0}}";

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
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thunderdome Shop</title><style>${STYLE}</style></head>
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
