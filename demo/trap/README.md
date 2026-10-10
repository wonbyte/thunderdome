# Thunderdome Shop: checkout

A small Worker that Thunderdome agents edit: a checkout in `src/checkout.ts` and a page that
shows a sample order. It has no dependencies, so a sandbox can run the tests at once with Node
22.18 or later:

```sh
npm test
```

One test fails on purpose.

## Shop rules

What the shop promises its customers at checkout:

- The subtotal is each line's price times its quantity, added up.
- The code SAVE10 takes 10% off the subtotal, rounded to the nearest cent.
- Shipping is $5.99. An order of $50.00 or more ships free, counted after the discount.
- An empty cart costs nothing: no shipping, a total of $0.00.
