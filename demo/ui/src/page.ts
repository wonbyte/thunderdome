import { slugOf, type Product } from "./catalog.ts";
import { formatPrice } from "./money.ts";
import { STYLES } from "./styles.ts";

export function renderPage(products: Product[]): string {
  const items = products
    .map(
      (product) =>
        `<li id="${slugOf(product)}"><strong>${product.title}</strong> ${formatPrice(product.cents)}<br>${product.blurb}</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thunderdome Shop</title>
<style>${STYLES}</style>
</head>
<body>
<h1>Thunderdome Shop</h1>
<ul>
${items}
</ul>
</body>
</html>`;
}
