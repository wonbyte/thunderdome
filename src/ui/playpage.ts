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

// The demo apps (demo/README.md) and their sample tasks.
const TEMPLATES: Template[] = [
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
];
const MIN = 10;
const MAX = 600;

let chosen: Template = TEMPLATES[0] as Template;
let inviteNeeded = false;
let remaining: number | undefined;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`#${id} is missing`);
  return node as T;
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

function renderTemplates(): void {
  byId("templates").replaceChildren(
    ...TEMPLATES.map((t) => {
      const card = el("button", `template${t === chosen ? " on" : ""}`);
      card.type = "button";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(t === chosen));
      card.append(el("b", undefined, t.title), el("span", undefined, t.blurb), el("code", undefined, t.id.replace(/^thunderdome-/, "demo: ")));
      card.addEventListener("click", () => {
        const prompt = byId<HTMLTextAreaElement>("prompt");
        // Keep an edited task; swap only the sample one.
        if (TEMPLATES.some((x) => x.prompt === prompt.value.trim()) || prompt.value.trim() === "") prompt.value = t.prompt;
        chosen = t;
        renderTemplates();
        renderCount();
      });
      return card;
    }),
  );
}

function renderCount(): void {
  const n = byId<HTMLTextAreaElement>("prompt").value.trim().length;
  const count = byId("count");
  count.textContent = `${n} / ${MAX}`;
  count.dataset.bad = String(n < MIN || n > MAX);
}

function renderQuota(): void {
  const quota = byId("quota");
  quota.textContent = remaining === undefined ? "" : remaining === 1 ? "1 race left today" : `${remaining} races left today`;
  quota.dataset.empty = String(remaining === 0);
  const go = byId<HTMLButtonElement>("go");
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

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const prompt = byId<HTMLTextAreaElement>("prompt").value.trim();
  if (prompt.length < MIN || prompt.length > MAX) {
    showError(`The task must be ${MIN} to ${MAX} characters.`);
    return;
  }
  const invite = byId<HTMLInputElement>("invite").value.trim();
  if (inviteNeeded && invite === "") {
    showError("This race needs an invite code.");
    return;
  }
  showError(undefined);
  const go = byId<HTMLButtonElement>("go");
  go.disabled = true;
  go.textContent = "Starting the race…";
  go.classList.add("busy");
  try {
    const res = await fetch("/play", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ template: chosen.id, prompt, ...(invite === "" ? {} : { invite }) }),
    });
    const body = (await res.json().catch(() => ({}))) as { page?: unknown; error?: unknown; reason?: unknown; remaining?: unknown };
    if (res.status === 202 && typeof body.page === "string" && /^\/race\/t-[0-9a-f]{8}$/.test(body.page)) {
      go.textContent = "Off they go…";
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
  const prompt = byId<HTMLTextAreaElement>("prompt");
  prompt.value = chosen.prompt;
  prompt.addEventListener("input", renderCount);
  byId("reset").addEventListener("click", () => {
    prompt.value = chosen.prompt;
    renderCount();
  });
  byId<HTMLFormElement>("play").addEventListener("submit", (e) => void submit(e));
  renderTemplates();
  renderCount();
  void loadQuota();
}

main();
