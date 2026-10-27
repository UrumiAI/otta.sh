# 0039. The product page may load one script, to mint an add-to-cart key per submission

- Status: accepted; **extended 2026-10-27** by
  [ADR-0019's amendment of that date](./0019-commerce-aggregates-are-one-document-each.md#amendment-2026-10-27--a-plain-cart-create-may-carry-the-callers-key)
  (issue #39): the browser-minted key now also keys a first add's cart create; the rendered
  fallback key is marked `pdp:` and never does
- Date: 2026-10-21
- Supersedes in part: [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md)
  decision 2 (the client-JS fence) and [ADR-0034](./0034-checkout-region-list-progressive-enhancement.md)
  decision 5 ("nothing else"). It adds a fourth exception.

## Context

The product page's add-to-cart form posts an `idempotencyKey` that the plugin mints once
per rendered page (`product-view-model.ts`). That key is what makes a double-click safe:
both POSTs carry it, and the store replays the second one instead of adding a second line.

It also means the key belongs to the page, not to the press (issue #37). A shopper who adds
the product, lands on `/cart`, goes Back and presses Add to cart again usually gets the same
document back from the browser's history cache, with the same key in it. The second add is
replayed as the first. The shopper sees the cart they already had and no error. The same
thing happens anywhere a rendered page is shown twice. A cached copy of the cookieless
product page served from a shared cache is one case, and then every visitor posts one key.

The server cannot fix this by itself. A replay of the same press and a second press look
the same once they reach `/cart/add`. Only the page knows whether this is a new press. The
options were:

1. **Stop the browser reusing the page** (`Cache-Control: no-store` on every product page,
   `autocomplete="off"`). That turns off shared caching of the catalog. It also does not stop
   every history-cache restore: browsers increasingly keep `no-store` pages in the history
   cache too.
2. **Mint the key in the browser for each submission.** This is a small script, and the
   rendered key stays as the no-JS fallback.

## Decision

1. **`/products/<slug>` may load exactly one script**: `public/scripts/add-to-cart-key.js`,
   through `src/components/AddToCartKey.astro`. The page renders that component, never the
   theme view, and only when there is an add-to-cart form. The script is external and
   first-party, with no inline code, no framework, no imports and no network calls, and it
   stays under 40 lines. `checkout-client-js.test.ts` names the pair
   `products/[slug].astro → AddToCartKey.astro` and checks the script's shape.
2. **A key per submission.** On submit of `form[action="/cart/add"]` the script writes
   `crypto.randomUUID()` into the form's `idempotencyKey` field. There are two exceptions:
   - **The same submission again keeps its key.** If the form body, without the key, is the
     same as the last one sent in this page life, the key is kept. A double-click, or a
     re-press while the first request is still in flight, then replays at the store. A
     changed quantity is a different submission and gets a new key, so one key never names
     two different commands.
   - **A history-cache restore starts a new page life** (`pageshow` with `persisted: true`).
     The next press is a new add.
3. **No-JS fallback: one key per render, documented.** Without the script, or without
   `crypto.randomUUID` (for example on a non-secure origin), the form posts the key the
   server rendered, and everything else is unchanged. A no-JS shopper who goes Back to a
   history-restored product page and presses again gets a replay. The cart page they land on
   shows the quantity they actually have, so the result is visible, not silent corruption. A
   reload or a fresh visit mints a new key. We accept this rather than option 1's costs.
4. **Nothing else.** `/cart/add` still forwards the form's key verbatim and never invents
   one. The plugin's key rules, the cart-rotation retry (which reuses the form's key) and the
   busy-page reload (which re-POSTs the same body) are unchanged.

## Consequences

- The storefront ships client JS on `/checkout/pay`, on the cart's hold countdown, on the
  checkout's region list, and on the product page's add-to-cart key. The fence is still an
  equality test, so adding a fifth is again a decision someone has to write down.
- With JS, pressing Add to cart again adds again, even on a history-restored or
  shared-cached page. Double-clicks and in-flight re-presses still dedupe.
- There is one known JS-on edge. If the first request reached the server but the browser
  showed a network error, and the shopper then goes Back to a history-restored page and
  presses again, that press counts as a new add. The cart shows two, and the shopper can
  change it. We prefer this to silently dropping intentional adds.
- There is one known edge in the other direction. A Shift- or Ctrl/Cmd-click on Add to cart
  submits into a new tab or window, so the original page stays in the same page life. A
  second press there, with the same quantity, is "the same submission again": it keeps the
  key and replays, so it does not add a second unit. The cart shows one, and pressing again
  after a reload or a fresh visit adds as usual.
