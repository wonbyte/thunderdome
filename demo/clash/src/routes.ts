// The one router. Every route the Worker serves is listed here.
import { PRODUCTS, slugOf } from "./catalog.ts";
import { renderPage } from "./page.ts";

export async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/products") {
    return Response.json(PRODUCTS.map((product) => ({ ...product, slug: slugOf(product) })));
  }
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(renderPage(PRODUCTS), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
