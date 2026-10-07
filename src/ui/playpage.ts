// Run your own race: pick a demo app, edit the task, POST /play, then go watch it.
// Server text only ever goes into textContent; innerHTML is only for sprites.ts art.
import { AGENT_COLORS } from "./board";
import { robotSvg } from "./sprites";

interface Template {
  id: string;
  title: string;
  blurb: string;
  prompt: string;
}

/** The demo apps (demo/README.md) and their sample tasks. */
const TEMPLATES: [Template, ...Template[]] = [
  {
    id: "thunderdome-bugs",
    title: "Fix the cart",
    blurb: "A shop with 5 bugs in 4 files and 6 failing tests.",
    prompt: "The shop's cart is broken and the tests show it. Fix every failing test. The bugs are in more than one file. Do not change the tests.",
  },
  {
    id: "thunderdome-ui",
    title: "Restyle the shop",
    blurb: "A visible change: each robot's preview looks different.",
    prompt:
      'Make the shop page look like a real store: a responsive grid of product cards with a dark theme. Products on sale get a "Sale" badge and show the old price struck through. Add a sort control: `/?sort=price` lists the cheapest first (sale prices count), `/` keeps the catalog order. Make the failing tests pass and keep the rest green.',
  },
  {
    id: "thunderdome-clash",
    title: "Add reviews",
    blurb: "Every robot needs the same routes file, so claims clash.",
    prompt:
      "Add product reviews. `GET /api/products/:slug/reviews` returns `{ average, count, reviews }` (average to one decimal, `null` when there are none; 404 for an unknown product), and the shop page shows each product's star average and review count. Make the failing tests pass.",
  },
  {
    id: "thunderdome-fusion",
    title: "Four parts, one fusion",
    blurb: "Four separate parts, tests for two: losers' hunks can join the winner.",
    prompt:
      "The shop page in `src/shop.ts` has four parts. Build 1 and 2, which the tests cover: 1) Sale badge: a product on sale shows \"Sale -N%\" (the percent off, rounded). 2) Sort: `/?sort=price` lists the cheapest first (sale prices count), `/?sort=name` lists A to Z. Then Zippy and Snip build part 4 and everyone else builds part 3 (both are wanted; the judge can fuse them): 3) Cart line: `/?cart=0` says \"Your cart is empty\", 1 says \"1 item in your cart\", more says \"N items in your cart\". 4) Prices: round a fraction of a cent to the nearest cent and add a thousands comma (\"$1,299.00\").",
  },
];
const MIN = 10;
const MAX = 600;

let chosen: Template = TEMPLATES[0];
let inviteNeeded = false;
let remaining: number | undefined;

function byId<T extends HTMLElement>(id: string, type: new () => T): T;
function byId(id: string): HTMLElement;
function byId(id: string, type: new () => HTMLElement = HTMLElement): HTMLElement {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(text: string | undefined): void {
  const box = byId("error");
  box.hidden = text === undefined;
  box.textContent = text ?? "";
}

/** Picks a demo app. An edited task is kept; only the sample task is swapped for the new app's. */
function choose(t: Template): void {
  const prompt = byId("prompt", HTMLTextAreaElement);
  if (TEMPLATES.some((x) => x.prompt === prompt.value.trim()) || prompt.value.trim() === "") prompt.value = t.prompt;
  chosen = t;
  renderTemplates();
  renderCount();
}

/** Arrow keys move the choice in the radio group, as the ARIA radio group pattern asks. */
const ARROW_STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Draws the demo-app cards as an ARIA radio group with a roving tabindex: only the chosen card
 * is in the tab order, and the arrow keys move the choice and the focus together.
 */
function renderTemplates(): void {
  const group = byId("templates");
  const focused = group.contains(document.activeElement);
  const cards = TEMPLATES.map((t, i) => {
    const on = t === chosen;
    const card = el("button", `template${on ? " on" : ""}`);
    card.type = "button";
    card.tabIndex = on ? 0 : -1;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(on));
    card.append(el("b", undefined, t.title), el("span", undefined, t.blurb), el("code", undefined, t.id.replace(/^thunderdome-/, "demo: ")));
    card.addEventListener("click", () => choose(t));
    card.addEventListener("keydown", (event) => {
      const step = ARROW_STEP[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const next = TEMPLATES[(i + step + TEMPLATES.length) % TEMPLATES.length];
      if (next !== undefined) choose(next);
    });
    return card;
  });
  group.replaceChildren(...cards);
  if (focused) cards[TEMPLATES.indexOf(chosen)]?.focus();
}

function renderCount(): void {
  const n = byId("prompt", HTMLTextAreaElement).value.trim().length;
  const count = byId("count");
  count.textContent = `${n} / ${MAX}`;
  count.dataset.bad = String(n < MIN || n > MAX);
}

function renderQuota(): void {
  const quota = byId("quota");
  quota.textContent = remaining === undefined ? "" : remaining === 1 ? "1 race left today" : `${remaining} races left today`;
  quota.dataset.empty = String(remaining === 0);
  const go = byId("go", HTMLButtonElement);
  go.disabled = remaining === 0;
  if (remaining === 0) showError("Today's races are used up. Come back tomorrow, or watch a replay in the gallery.");
}

async function loadQuota(): Promise<void> {
  try {
    const res = await fetch("/play/quota", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { remaining?: unknown; invite?: unknown };
    remaining = typeof body.remaining === "number" ? body.remaining : undefined;
    inviteNeeded = body.invite === true;
    byId("invite-row").hidden = !inviteNeeded;
    renderQuota();
  } catch {
    // The form still works; the server checks the quota.
  }
}

/**
 * What POST /play does before it answers, in order, with when each step usually starts (ms after
 * the click). The server sends no progress, so the page moves on by these times; the last step
 * stays current until the answer comes, and only then is it ticked.
 */
const SETUP_STEPS: { at: number; text: string }[] = [
  { at: 0, text: "Copying the demo app into a fresh repo on Artifacts" },
  { at: 3_000, text: "Forking it for Ponder, Zippy, Testy, Snip and Sparkle" },
  { at: 9_000, text: "Starting 5 sandboxes, one container per robot" },
];
/** After this long the note says a cold start is still running. */
const SETUP_SLOW_MS = 60_000;

let setupTimer: ReturnType<typeof setInterval> | undefined;

/** Shows the setup steps and keeps them and the clock moving until stopSetup. */
function startSetup(): void {
  const started = Date.now();
  const panel = byId("setup");
  const items = SETUP_STEPS.map((step) => {
    const item = el("li", "todo");
    item.append(el("span", "setup-mark"), el("span", undefined, step.text));
    return item;
  });
  byId("setup-steps").replaceChildren(...items);
  byId("setup-note").textContent = "This usually takes 20 to 60 seconds. Keep this page open; the race page opens on its own.";
  byId("setup-title").textContent = "Setting up the race";
  panel.hidden = false;
  let shown = -1;
  const tick = (): void => {
    const elapsed = Date.now() - started;
    const s = Math.floor(elapsed / 1000);
    byId("setup-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const now = SETUP_STEPS.findLastIndex((step) => elapsed >= step.at);
    if (now !== shown) {
      shown = now;
      items.forEach((item, i) => (item.className = i < now ? "done" : i === now ? "now" : "todo"));
      byId("setup-now").textContent = `${SETUP_STEPS[now]?.text ?? ""}…`;
    }
    if (elapsed >= SETUP_SLOW_MS) byId("setup-note").textContent = "Still starting: sandboxes that have not run for a while take longer to boot. Keep this page open.";
  };
  tick();
  setupTimer = setInterval(tick, 500);
}

/** Stops the clock. Done ticks every step; otherwise the panel shows it stopped. */
function stopSetup(done: boolean): void {
  clearInterval(setupTimer);
  setupTimer = undefined;
  const panel = byId("setup");
  if (done) {
    for (const item of byId("setup-steps").children) item.className = "done";
    byId("setup-title").textContent = "Ready: opening the race";
    byId("setup-now").textContent = "Ready: opening the race.";
    return;
  }
  panel.hidden = true;
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const prompt = byId("prompt", HTMLTextAreaElement).value.trim();
  if (prompt.length < MIN || prompt.length > MAX) {
    showError(`The task must be ${MIN} to ${MAX} characters.`);
    return;
  }
  const invite = byId("invite", HTMLInputElement).value.trim();
  if (inviteNeeded && invite === "") {
    showError("This race needs an invite code.");
    return;
  }
  showError(undefined);
  const go = byId("go", HTMLButtonElement);
  go.disabled = true;
  go.textContent = "Starting the race…";
  go.classList.add("busy");
  startSetup();
  try {
    const res = await fetch("/play", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ template: chosen.id, prompt, ...(invite === "" ? {} : { invite }) }),
    });
    const body = (await res.json().catch(() => ({}))) as { page?: unknown; error?: unknown; reason?: unknown; remaining?: unknown };
    if (res.status === 202 && typeof body.page === "string" && /^\/race\/t-[0-9a-f]{8}$/.test(body.page)) {
      go.textContent = "Off they go…";
      stopSetup(true);
      location.assign(body.page);
      return;
    }
    if (res.status === 429) {
      remaining = body.reason === "daily" ? 0 : remaining;
      showError(body.reason === "ip" ? "You have started today's races for this network. Come back tomorrow." : "Today's races are used up. Come back tomorrow, or watch a replay in the gallery.");
    } else if (res.status === 403) {
      showError("That invite code is not right.");
    } else {
      showError(typeof body.error === "string" ? body.error : `The race did not start (HTTP ${res.status}).`);
    }
  } catch {
    showError("The race did not start. Try again in a moment.");
  }
  stopSetup(false);
  go.textContent = "▶ Start the race";
  go.classList.remove("busy");
  go.disabled = remaining === 0;
}

function main(): void {
  const bots = byId("hero-bots");
  for (const agent of ["ponder", "zippy", "testy"]) {
    const bot = el("div", "hero-bot");
    bot.innerHTML = robotSvg(AGENT_COLORS[agent] ?? "#8b8d98"); // sprites.ts output only
    bots.append(bot);
  }
  const prompt = byId("prompt", HTMLTextAreaElement);
  prompt.value = chosen.prompt;
  prompt.addEventListener("input", renderCount);
  byId("reset").addEventListener("click", () => {
    prompt.value = chosen.prompt;
    renderCount();
  });
  byId("play", HTMLFormElement).addEventListener("submit", (e) => void submit(e));
  renderTemplates();
  renderCount();
  void loadQuota();
}

main();
