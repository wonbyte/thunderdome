# Thunderdome Shop: reviews

A small Worker that Thunderdome agents edit: the shop page and its API. Every route goes
through `src/routes.ts`. It has no dependencies, so a sandbox can run the tests at once
with Node 22.18 or later:

```sh
npm test
```

Some tests fail on purpose. They describe the reviews feature that is not built yet.
