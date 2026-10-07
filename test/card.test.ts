import { describe, expect, it } from "vitest";

import type { Task } from "../src/room/task";
import { CARD, cardHtml, cardTaskId, escapeHtml, metaHtml, raceTags, siteTags } from "../src/routes/card";

const id = "t-0123abcd";
const origin = "https://thunderdome.example";
const parts = { tests: 45, taskFit: 13, clarity: 8, look: 10, claim: 10 };

function task(over: Partial<Task> = {}): Task {
  return {
    id,
    repo: "r",
    prompt: "Fix the cart <b>now</b> & keep the tests green",
    status: "finished",
    createdAt: "2026-10-07T18:00:00.000Z",
    agents: [
      { name: "ponder", status: "done" },
      { name: "zippy", status: "done" },
      { name: "testy", status: "done" },
    ],
    ...over,
  } as Task;
}

const verdict: Task["verdict"] = {
  winner: "ponder",
  why: "Winner: ponder",
  judgedAt: "2026-10-07T18:05:00.000Z",
  ship: { status: "merged", winner: "ponder", commit: "abc", locks: [] },
  headline: "Decided by code: ponder's fix scored 1.9 more points than zippy's.",
  scores: [
    { agent: "zippy", total: 85.34, eligible: true, parts },
    { agent: "ponder", total: 87.24, eligible: true, parts },
    { agent: "testy", total: 85.28, eligible: true, parts },
  ],
  fusion: { tried: [{ agent: "zippy", files: ["a.ts"], status: "added" }] },
};

const tag = (tags: { property: string; content: string }[], p: string) => tags.find((t) => t.property === p)?.content;

describe("card route", () => {
  it("C1: cardTaskId reads only GET /race/:id/card.png", () => {
    expect(cardTaskId(`/race/${id}/card.png`)).toBe(id);
    expect(cardTaskId(`/race/${id}`)).toBeUndefined();
    expect(cardTaskId(`/race/${id}/card.jpg`)).toBeUndefined();
    expect(cardTaskId(`/race/bad/card.png`)).toBeUndefined();
    expect(cardTaskId(`/tasks/${id}/card.png`)).toBeUndefined();
  });

  it("C2: a race's tags carry the prompt, the winner with the headline, and the card image", () => {
    const tags = raceTags(task({ verdict }), origin);
    expect(tag(tags, "og:title")).toBe("Fix the cart <b>now</b> & keep the tests green");
    expect(tag(tags, "og:description")).toBe("Ponder won: Decided by code: Ponder's fix scored 1.9 more points than Zippy's.");
    expect(tag(tags, "og:image")).toBe(`${origin}/race/${id}/card.png`);
    expect(tag(tags, "og:url")).toBe(`${origin}/race/${id}`);
    expect(tag(tags, "twitter:card")).toBe("summary_large_image");
    expect(tag(tags, "og:image:width")).toBe(String(CARD.width));
  });

  it("C3: a live race, a judging race and no winner keep the static image", () => {
    expect(tag(raceTags(task({ status: "running" }), origin), "og:description")).toBe("A live race: Ponder, Zippy, Testy on their own forks of one repo.");
    expect(tag(raceTags(task({ status: "running" }), origin), "og:image")).toBe(`${origin}/og.png`);
    expect(tag(raceTags(task(), origin), "og:description")).toBe("The judge is scoring every fork.");
    const none = raceTags(task({ verdict: { ...verdict, winner: null, headline: undefined } }), origin);
    expect(tag(none, "og:description")).toBe("No winner: no fork passed.");
    expect(tag(none, "og:image")).toBe(`${origin}/og.png`);
    expect(tag(raceTags(null, origin), "og:title")).toBe("Thunderdome race");
  });

  it("C4: a long prompt is cut on one line for the title", () => {
    const long = task({ prompt: `${"word ".repeat(40)}\n\nmore` });
    const title = tag(raceTags(long, origin), "og:title") ?? "";
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("\n");
  });

  it("C5: metaHtml escapes every attribute, so a prompt cannot close the tag", () => {
    const html = metaHtml([{ property: "og:title", content: `"><script>alert('x')</script>` }, { property: "twitter:card", content: "summary" }]);
    expect(html).toContain('content="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"');
    expect(html).not.toContain("<script");
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("C6: the card shows the winner, the podium best first, the fused count and the escaped prompt", () => {
    const html = cardHtml(task({ verdict }));
    expect(html).toContain("Ponder won");
    expect(html.indexOf("Ponder</span>")).toBeLessThan(html.indexOf("Zippy</span>"));
    expect(html.indexOf("Zippy</span>")).toBeLessThan(html.indexOf("Testy</span>"));
    expect(html).toContain("87.2");
    expect(html).toContain("+ 1 fused from the losers");
    expect(html).toContain("Fix the cart &lt;b&gt;now&lt;/b&gt; &amp; keep the tests green");
    expect(html).not.toContain("<b>now</b>");
    expect(html).toContain(`<title>Ponder won</title>`);
  });

  it("C7: an older verdict without scores gets a winner-only card, and no winner a plain one", () => {
    const plain = cardHtml(task({ verdict: { ...verdict, scores: undefined, fusion: undefined } }));
    expect(plain).not.toContain("<ol>");
    expect(plain).toContain("Ponder won");
    const none = cardHtml(task({ verdict: { ...verdict, winner: null, headline: undefined } }));
    expect(none).toContain("No winner");
  });

  it("C8: the site's tags name the static image with its size", () => {
    const tags = siteTags(origin, "Thunderdome races", "Every race.");
    expect(tag(tags, "og:image")).toBe(`${origin}/og.png`);
    expect(tag(tags, "og:image:height")).toBe("630");
  });
});
