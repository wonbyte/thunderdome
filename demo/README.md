# Demo apps

Each folder here is a small Worker that Thunderdome seeds into an Artifacts repo
(`scripts/build-sample.mjs` packs them into the Worker). Seed a template once, then race on it
as often as you like: a task with `template` forks it into a fresh source repo first, so the
merge never changes the template.

```sh
curl -X POST $THUNDERDOME/spike/seed -H "authorization: Bearer $ADMIN_TOKEN" -d '{"repo":"thunderdome-trap","app":"trap"}'
curl -X POST $THUNDERDOME/tasks -H "authorization: Bearer $ADMIN_TOKEN" -d '{"template":"thunderdome-trap","prompt":"...","agents":3}'
```

| App | Template repo | What it shows |
| --- | --- | --- |
| `sample-app` | `thunderdome-sample`, `thunderdome-template` | The first sample: 2 one-line bugs in 1 file. |
| `bugs` | `thunderdome-bugs` | Bug fix: 6 failing tests, 5 bugs in 4 files. The home page is a 500 until the slug bug is fixed, so the previews change. Off `/play` since Oct 10: every robot wrote the same fix. |
| `trap` | `thunderdome-trap` | Trap: one failing test (small orders ship free) whose quick fix (the threshold in dollars, not cents) passes it, while two shop rules in its README stay broken: free shipping counts after the discount, and an empty cart costs $0.00. On Oct 10 every robot found and fixed both in all 4 races (rules in the code comment or the README, Zippy capped at 6 turns or not), so the scores stayed close; it is a plain bug-fix demo, not a spread. |
| `ui` | `thunderdome-ui` | Visible UI change: the tests pin down a sale badge and a price sort, the look is up to each agent, so the previews differ. |
| `clash` | `thunderdome-clash` | Claim clash: a reviews feature that every agent must route through `src/routes.ts`. |
| | | `clash-full` is the same app with a bigger prompt: the tests cover only the GET API and the stars on the page, so the POST API, the quoted review and the "Top rated" badge are left to each agent. The fixes differ, and task fit decides more than claim order. |
| `fusion` | `thunderdome-fusion` | Fusion: four parts in four functions of `src/shop.ts`, far apart, with failing tests for two. The prompt splits the two untested parts by robot (Zippy and Snip build part 4, the rest part 3), so whoever wins, a robot on the other part has a hunk in a function the winner never touched, and the fusion round can add a loser's hunk (say, the cart line) to the winner's fix. |

`HOTFIX=1 node --env-file=.env scripts/race.mjs fusion` adds a teammate's hotfix mid-race: at
the first robot push, it pushes a commit to the race's source that changes the `saleBadge` line every robot
replaces, so the winner's merge conflicts and three resolvers race to fix it (`ship.resolve`).

## Prompts

**trap**

> Small orders ship free, and they should not: a test shows it. Fix the checkout. Do not change
> the existing tests.

**bugs**

> The shop's cart is broken and the tests show it. Fix every failing test. The bugs are in
> more than one file. Do not change the tests.

**ui**

> Make the shop page look like a real store: a responsive grid of product cards with a dark
> theme. Products on sale get a "Sale" badge and show the old price struck through. Add a sort
> control: `/?sort=price` lists the cheapest first (sale prices count), `/` keeps the catalog
> order. Make the failing tests pass and keep the rest green.

**clash**

> Add product reviews. `GET /api/products/:slug/reviews` returns `{ average, count, reviews }`
> (average to one decimal, `null` when there are none; 404 for an unknown product), and the shop
> page shows each product's star average and review count. Make the failing tests pass.

**fusion**

> The shop page in `src/shop.ts` has four parts. Build 1 and 2, which the tests cover: 1) Sale badge: a product on sale shows "Sale -N%" (the percent off, rounded). 2) Sort: `/?sort=price` lists the cheapest first (sale prices count), `/?sort=name` lists A to Z. Then Zippy and Snip build part 4 and everyone else builds part 3 (both are wanted; the judge can fuse them): 3) Cart line: `/?cart=0` says "Your cart is empty", 1 says "1 item in your cart", more says "N items in your cart". 4) Prices: round a fraction of a cent to the nearest cent and add a thousands comma ("$1,299.00").

**clash-full** (template `thunderdome-clash`; the video race)

> Add product reviews to the shop. The tests only cover part of this; build all of it.
> 1. `GET /api/products/:slug/reviews` returns `{ average, count, reviews }` (average to one
> decimal, `null` when there are none; 404 for an unknown product).
> 2. `POST /api/products/:slug/reviews` with a JSON body `{ stars, text }` adds a review.
> `stars` must be a whole number from 1 to 5 and `text` 1 to 280 characters after trimming;
> otherwise answer 400 with `{ error }` naming the bad field. 404 for an unknown product.
> On success answer 201 with the product's new `{ average, count, reviews }`.
> 3. The shop page shows each product's star average and review count, quotes its first
> review, and marks the best-rated product (highest average, at least 2 reviews) with a
> "Top rated" badge.
