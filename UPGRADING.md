# Upgrading an Otta store

A store made from the one-click template ([`DEPLOYMENT.md`](./DEPLOYMENT.md) §2.6) gets Otta
as a dependency, `@urumi.ai/otta-store`. Most releases need nothing from you: merge the
Dependabot pull request and Workers Builds deploys it.

Two kinds of release need you.

**A release that moves EmDash, Astro or React.** `@urumi.ai/otta-store` declares them as peer
dependencies (EmDash and `@emdash-cms/cloudflare` exactly, the others to the minor), and the
template's Dependabot never updates them, because a mismatch would install a second EmDash. So
such a release does **not** arrive as a working Dependabot pull request: Dependabot holds back
the Otta update, or the build stops at `npm install` with an `ERESOLVE` error, before Otta's
own checks run. It is announced in the release notes. Bump the versions its section below
lists in `package.json` by hand, together with the `@urumi.ai/*` packages, and push.

**A release that changes your repository's other files** (a new binding in `wrangler.jsonc`,
a new file) raises the **template contract**, the number your `astro.config.mjs` passes as
`otta({ template: N })`
([ADR-0045](./adr/0045-the-store-ships-as-an-astro-integration-for-one-click-deploy.md)).
Until you make the change, that release's build fails with

```text
@urumi.ai/otta-store <version> needs template contract <N>, but astro.config.mjs passes
otta({ template: <yours> }) …
```

and nothing is deployed: the store keeps running the last version that built. Follow the
section for each contract number between yours and the new one, in order, then set
`template` to the new number and push. This message covers template-file changes only; a
version move announces itself as above.

## Your own middleware runs before Otta's

`otta()` registers the store's middleware after EmDash's (`order: "post"`), and Astro runs a
site's own `src/middleware.ts` between the two. So **a store's own middleware runs before
Otta's**, which holds the cross-site request check and, until the store is claimed, the
setup-link gate (ADR-0042). A site middleware that answers a request itself instead of calling
`next()` skips both for that request. Call `next()` for every path you do not own, and never
answer `/_emdash/*` or the cart, checkout and account routes.

## Template contract 1

The first contract, `@urumi.ai/otta-store` 0.2.0. A store on it has:

- `astro.config.mjs`: the `@astrojs/cloudflare` adapter and `otta({ template: 1 })`;
- `src/worker.ts`: `export { default, PluginBridge } from "@urumi.ai/otta-store/worker";`;
- `src/live.config.ts`, which calls `defineLiveCollection` itself (Astro gives it to this
  file only):

  ```ts
  import { defineLiveCollection } from "astro:content";
  import { ottaLiveCollections } from "@urumi.ai/otta-store/live-config";

  export const collections = ottaLiveCollections(defineLiveCollection);
  ```

- `package.json`: exact pins of `@urumi.ai/otta-store`, `@urumi.ai/otta-plugin`,
  `@urumi.ai/otta-admin-react`, `emdash`, `@emdash-cms/cloudflare`, `astro`,
  `@astrojs/cloudflare`, `@astrojs/react`, `react`, `react-dom` and `wrangler`, and
  `"emdash": { "seed": "node_modules/@urumi.ai/otta-store/seed/seed.json" }`;
- `wrangler.jsonc`: `DB` (D1), `MEDIA` and `DOWNLOADS` (two different R2 buckets), `SESSION`
  (KV), `IMAGES`, `RATE_LIMIT_AUTH` and `RATE_LIMIT_WRITES`, the `* * * * *` cron,
  `nodejs_compat`, and Workers Logs on with invocation logs off.

There is nothing to upgrade from: it is the first.
