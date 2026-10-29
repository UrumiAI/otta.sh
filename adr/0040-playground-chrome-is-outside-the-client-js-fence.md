# 0040. The playground's injected chrome sits outside the client-JS fence

- Status: accepted
- Date: 2026-10-29
- Refines: [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md)
  decision 2 (the client-JS fence), as extended by
  [ADR-0034](./0034-checkout-region-list-progressive-enhancement.md) and
  [ADR-0039](./0039-add-to-cart-mints-a-key-per-submission.md). It adds **no** fifth
  allowlist entry: the storefront's list of four stands, and ADR-0034's "third and last" is
  read against the storefront.

## Context

The fence in ADR-0012 decision 2 is a promise about the storefront: client JavaScript reaches
only the pages on a named list. `checkout-client-js.test.ts` enforces it by walking each
`.astro` page's imports. It cannot see anything that is not imported by a page.

The playground build (`__OTTA_PLAYGROUND__`, `astro.config.playground.ts`) is the disposable
per-visitor demo at `try.otta.sh`. Its middleware (`withPlaygroundBanner`) rewrites every HTML
response to add a note and a GitHub star prompt, and the prompt loads
`/scripts/playground-star.js`. That includes `/cart`, `/checkout` and `/checkout/pay`. No page
imports it, so the test passes, and the page-level fence says nothing about it. Left unwritten,
the next reader finds script on a checkout page that the ADRs say has none.

## Decision

1. **Playground-only middleware chrome is outside the fence.** What
   `injectBanner` (`src/lib/playground-banner.ts`) adds to a response in the playground build
   is not a page's client JS and is not on the allowlist. It is bound by the conditions below.
2. **Conditions.** All of these hold today, and a change to any one needs a new ADR:
   - **Playground build only.** `withPlaygroundBanner` and `playgroundGate` return the response
     untouched unless `__OTTA_PLAYGROUND__` is true. `astro.config.ts` defines it `false`.
     `playground-gate.test.ts` pins that, with the flag off, `withPlaygroundBanner` returns the
     same response with no `otta-star` and no `<script`, and that `/_otta/stars` answers only
     with the flag on. (The script file sits in `public/` and so ships with both builds, but no
     storefront page references it.)
   - **One script, ours.** The injected chrome carries exactly one `<script>`, external and
     first-party (`/scripts/playground-star.js`). `playground-star.test.ts` counts script tags
     in the injected output, checks that one's `src`, and checks that no element has an `on*`
     attribute or a `javascript:` value. `playground-gate.test.ts` counts them again through
     `withPlaygroundBanner`.
   - **Same origin only.** The script's only network call is `fetch("/_otta/stars")`. The
     Worker, not the browser, asks `api.github.com`, with fixed headers and none of the
     visitor's cookies. The prompt links to github.com as a plain `target="_blank"` anchor.
     No third-party script origin is added, so `js.stripe.com` stays the only one
     (ADR-0034 decision 5).
   - **No order data.** The script reads and writes only its own `.otta-star` element, the
     `otta-star:*` storage keys and the position of EmDash's playground toolbar. Its document
     keydown listener reads `event.key`, `defaultPrevented`, and the tag, role and editability
     of the event's path and the focused element, never a value. Nothing on `/cart`,
     `/checkout` or `/checkout/pay` is read.
   - **No behaviour, no mutation.** It changes no form, no request and no route, and the
     page works unchanged without it. Every mutation stays a `<form method="POST">` → 303.
3. **Why it is safe to leave outside.** The playground has no real buyers and no connected
   card payments (the note says so on every page), and an hour-long database that is thrown
   away. The fence exists to keep the *storefront* a no-script checkout; the playground's
   purpose is to show the store, and a star prompt is the cost of the free demo.

## Consequences

- The claim stays "the storefront ships no client JS outside `/checkout/pay`, the cart's hold
  countdown, the checkout's region list and the product page's add-to-cart key". The
  playground is a different build with the chrome described above.
- The fence test is still an equality over `.astro` imports, and does not cover this. The
  script-count test in `playground-star.test.ts` is its stand-in for the injected chrome.
- Adding a second script, a third-party origin, or reading form data in the chrome is a new
  ADR, not an edit to the star prompt.
- A storefront build that injected this chrome would break ADR-0012. The `withPlaygroundBanner`
  test with the flag off is what makes that a red test.
