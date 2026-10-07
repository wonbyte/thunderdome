// Sharing a race: the pages with their og tags, and GET /race/:id/card.png. The card is drawn
// with Browser Rendering on its first request, after the verdict, and kept in the task's room.
import { launch } from "@cloudflare/puppeteer";
import { CARD, CARD_MAX_BYTES, cardHtml, metaHtml, raceTags, siteTags } from "./card";
import type { Task } from "../room/task";

type ShareEnv = Pick<Env, "TASK_ROOM" | "ASSETS" | "BROWSER">;

/** Browser Rendering gets this long to draw a card. */
const RENDER_TIMEOUT_MS = 20_000;
/** A card never changes once drawn: the verdict is final. */
const CARD_CACHE = "public, max-age=31536000, immutable";

const PAGE_TAGS: Record<string, { title: string; description: string }> = {
  "/races.html": { title: "Thunderdome races", description: "AI agents race on forks of one repo. A judge picks the best change, and it ships. Every race, ready to replay." },
  "/play.html": { title: "Run a race · Thunderdome", description: "Pick a demo app, give a task, and watch AI agents race on forks of one repo while a judge ships the best change." },
};

/**
 * A page asset with its og tags added to `<head>`. The race page's tags come from its task
 * (the prompt, the winner, the card); the gallery and the play form get the site's.
 */
export async function sharePage(request: Request, env: ShareEnv, asset: string, taskId: string | undefined): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL(asset, request.url));
  if (!page.ok) return page;
  const origin = new URL(request.url).origin;
  const site = PAGE_TAGS[asset];
  const tags = taskId !== undefined ? raceTags(await taskOf(env, taskId), origin) : site === undefined ? raceTags(undefined, origin) : siteTags(origin, site.title, site.description);
  const meta = metaHtml(tags);
  return new HTMLRewriter()
    .on("head", {
      element(head) {
        head.append(meta, { html: true });
      },
    })
    .transform(page);
}

/** The task for its tags, or null when the room cannot answer (a reset right after a deploy): the page still serves. */
async function taskOf(env: Pick<Env, "TASK_ROOM">, taskId: string): Promise<Task | null> {
  try {
    return await env.TASK_ROOM.getByName(taskId).state();
  } catch (cause) {
    console.error({ event: "share.state_failed", taskId, error: String(cause) });
    return null;
  }
}

/**
 * GET /race/:id/card.png: the saved card, else one drawn now and saved. 404 before the verdict or
 * with no winner (the page's tags point at the static image then). A render that fails (the
 * browser limit, a timeout) is a 503 nobody caches, so the next request tries again.
 */
export async function handleCard(env: ShareEnv, taskId: string): Promise<Response> {
  try {
    const room = env.TASK_ROOM.getByName(taskId);
    const saved = await room.card();
    if (saved !== null) return cardResponse(saved.type, saved.body);
    const task = await room.state();
    if (task === null || task.verdict === undefined || task.verdict.winner === null) return Response.json({ error: "no card yet" }, { status: 404 });
    const card = await renderCard(env, task);
    await room.saveCard(card.type, card.body);
    return cardResponse(card.type, card.body);
  } catch (cause) {
    // The browser limit, a timeout, or the room resetting after a deploy: nothing is cached, so the next request tries again.
    console.error({ event: "card.failed", taskId, error: String(cause) });
    return Response.json({ error: "could not draw the card" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "30" } });
  }
}

function cardResponse(type: string, body: ArrayBuffer): Response {
  return new Response(body, { headers: { "content-type": type, "cache-control": CARD_CACHE, "content-length": String(body.byteLength) } });
}

/** Draws the card at 1200x630: PNG, or JPEG when the PNG would be too big for a row. */
async function renderCard(env: Pick<Env, "BROWSER">, task: Task): Promise<{ type: string; body: ArrayBuffer }> {
  const browser = await launch(env.BROWSER);
  const timer = setTimeout(() => void browser.close().catch(() => undefined), RENDER_TIMEOUT_MS);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: CARD.width, height: CARD.height });
    await page.setContent(cardHtml(task), { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    let shot: Uint8Array = await page.screenshot({ type: "png" });
    let type = "image/png";
    if (shot.byteLength > CARD_MAX_BYTES) {
      shot = await page.screenshot({ type: "jpeg", quality: 70 });
      type = "image/jpeg";
    }
    return { type, body: shot.buffer.slice(shot.byteOffset, shot.byteOffset + shot.byteLength) as ArrayBuffer };
  } finally {
    clearTimeout(timer);
    await browser.close().catch((cause: unknown) => console.error({ event: "card.close_failed", error: String(cause) }));
  }
}
