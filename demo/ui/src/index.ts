import { PRODUCTS, slugOf } from "./catalog.ts";
import { renderPage } from "./page.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/products") {
      return Response.json(PRODUCTS.map((product) => ({ ...product, slug: slugOf(product) })));
    }
    return new Response(renderPage(PRODUCTS), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
