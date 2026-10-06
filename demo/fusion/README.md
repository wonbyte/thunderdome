# Thunderdome Shop: four parts

A small Worker that Thunderdome agents edit: a shop page built from four small parts in
`src/shop.ts` (the sale badge, the sort, the cart line and the price format). Each part is its
own function, far from the others, so one robot's work on one part can join another robot's
work on the rest. It has no dependencies, so a sandbox can run the tests at once with Node 22.18
or later:

```sh
npm test
```

Some tests fail on purpose. They cover only two of the four parts.
