import { formatPrice, slugify, wordCount } from "./text.ts";

export interface Product {
  title: string;
  cents: number;
  blurb: string;
}

export const PRODUCTS: Product[] = [
  { title: "Café Crème", cents: 450, blurb: "Smooth coffee with warm milk." },
  { title: "Thunder Brew", cents: 1205, blurb: "Cold brew for long days." },
  { title: "Thunderdome Mug", cents: 1999, blurb: "Holds one winning idea." },
];

export function renderPage(products: Product[]): string {
  const rows = products
    .map(
      (product) =>
        `<li id="${slugify(product.title)}"><strong>${product.title}</strong> ` +
        `${formatPrice(product.cents)} <small>(${wordCount(product.blurb)} words)</small></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Thunderdome Shop</title></head>
<body>
<h1>Thunderdome Shop</h1>
<ul>
${rows}
</ul>
</body>
</html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/products") {
      return Response.json(
        PRODUCTS.map((product) => ({ ...product, slug: slugify(product.title) })),
      );
    }
    return new Response(renderPage(PRODUCTS), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
