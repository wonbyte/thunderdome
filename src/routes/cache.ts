// The edge cache for public reads. A Worker's response is never cached by the edge on its own, so
// hot read routes go through `caches.default` here. The cache is injected, so tests use a fake.

/** What the helper needs of a Cache. */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * The cached response for a GET, else `produce()`'s, stored for `ttlSeconds` when it is a 200.
 * A response that already says how long it may be cached (the cards: a year) keeps its own
 * header. Anything but a GET, or no cache (local tests), goes straight to `produce()`.
 */
export async function cached(cache: EdgeCache | undefined, request: Request, ttlSeconds: number, produce: () => Promise<Response>, waitUntil: (work: Promise<unknown>) => void): Promise<Response> {
  if (cache === undefined || request.method !== "GET") return produce();
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit !== undefined) return hit;
  const response = await produce();
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", `public, max-age=${ttlSeconds}`);
  const copy = new Response(response.body, { status: response.status, headers });
  // Two bodies are needed: one for the cache, one for the client.
  const [forCache, forClient] = [copy.clone(), copy];
  waitUntil(cache.put(key, forCache).catch((cause: unknown) => console.error({ event: "cache.put_failed", url: request.url, error: String(cause) })));
  return forClient;
}
