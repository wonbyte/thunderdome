import { slugOf, type Product } from "./catalog.ts";
import { formatPrice } from "./money.ts";

export function renderPage(products: Product[]): string {
  const items = products
    .map(
      (product) =>
        `<li id="${slugOf(product)}"><strong>${product.title}</strong> ${formatPrice(product.cents)}<br>${product.blurb}</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Thunderdome Shop</title></head>
<body>
<h1>Thunderdome Shop</h1>
<ul>
${items}
</ul>
</body>
</html>`;
}
