# Thunderdome Shop: storefront

A small Worker that Thunderdome agents edit: the shop's product page. It has no dependencies,
so a sandbox can run the tests at once with Node 22.18 or later:

```sh
npm test
```

Some tests fail on purpose. They pin down what the page must do, not how it looks.
