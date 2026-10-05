# Demo apps

Each folder here is a small Worker that Thunderdome seeds into an Artifacts repo
(`scripts/build-sample.mjs` packs them into the Worker). Seed a template once, then race on it
as often as you like: a task with `template` forks it into a fresh source repo first, so the
merge never changes the template.

```sh
curl -X POST $THUNDERDOME/spike/seed -H "authorization: Bearer $ADMIN_TOKEN" -d '{"repo":"thunderdome-bugs","app":"bugs"}'
curl -X POST $THUNDERDOME/tasks -H "authorization: Bearer $ADMIN_TOKEN" -d '{"template":"thunderdome-bugs","prompt":"...","agents":3}'
```

| App | Template repo | What it shows |
| --- | --- | --- |
| `sample-app` | `thunderdome-sample`, `thunderdome-template` | The first sample: 2 one-line bugs in 1 file. |
| `bugs` | `thunderdome-bugs` | Bug fix: 6 failing tests, 5 bugs in 4 files. The home page is a 500 until the slug bug is fixed, so the previews change. |
| `ui` | `thunderdome-ui` | Visible UI change: the tests pin down a sale badge and a price sort, the look is up to each agent, so the 3 previews differ. |
| `clash` | `thunderdome-clash` | Claim clash: a reviews feature that every agent must route through `src/routes.ts`. |
| | | `clash-full` is the same app with a bigger prompt: the tests cover only the GET API and the stars on the page, so the POST API, the quoted review and the "Top rated" badge are left to each agent. The fixes differ, and task fit decides more than claim order. |

## Prompts

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
