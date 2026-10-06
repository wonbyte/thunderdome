// The shop page: the cart line, then every product with its price and badge, sorted by ?sort=.
// ?cart=N sets how many items the sample cart holds.
import { PRODUCTS } from "./catalog.ts";
import { cartMessage, formatPrice, saleBadge, sortProducts } from "./shop.ts";

function renderPage(sort: string | null, cart: number): string {
  const items = sortProducts(PRODUCTS, sort)
    .map((p) => {
      const price = p.saleCents === undefined ? formatPrice(p.cents) : `${formatPrice(p.saleCents)} <s>${formatPrice(p.cents)}</s>`;
      const badge = saleBadge(p);
      return `<li id="${p.slug}"><strong>${p.title}</strong> ${price}${badge === "" ? "" : ` <em class="badge">${badge}</em>`}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thunderdome Shop</title>
<style>body { font-family: system-ui, sans-serif; margin: 2rem; } li { margin-bottom: .75rem; } .badge { color: #b00; }</style>
</head>
<body>
<h1>Thunderdome Shop</h1>
<p id="cart">${cartMessage(cart)}</p>
<ul>
${items}
</ul>
</body>
</html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const cart = Number.parseInt(url.searchParams.get("cart") ?? "0", 10);
    return new Response(renderPage(url.searchParams.get("sort"), Number.isFinite(cart) && cart >= 0 ? cart : 0), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
