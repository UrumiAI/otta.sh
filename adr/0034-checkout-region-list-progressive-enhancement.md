# 0034. The checkout review may load one script, to swap the state/province list

- Status: accepted
- Date: 2026-10-09
- Supersedes in part: [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md)
  decision 2 (the client-JS fence) — it adds a third and last exception.

## Context

ADR-0012 fenced client JavaScript to `/checkout/pay` (Stripe Elements) and, by its 2026-07-28
amendment, to the cart's hold countdown, and said a third exception "should be a superseding
ADR rather than a third allowlist entry". This is that ADR.

The checkout review (`/checkout`) asks for the state/province as a pick list of the chosen
country's ISO 3166-2 subdivisions (ADR-0021, amended 2026-10-08). Without JavaScript the list
can only be the one the server rendered, so a buyer who changes country must press Update
for that country's list. Six review rounds of no-JS edge cases (a region picked for one
country and posted with another, a preselected region mistaken for a pick, a blank country
refilled, countries reset after a failed place, contradictory notices) came from the server
trying to infer, after the fact, which list a posted region was picked from. The user chose
to let the list follow the country in the browser where it can, and to keep one simple server
rule for where it cannot.

## Decision

1. **`/checkout` may load exactly one script**: `public/scripts/region-picker.js`, through
   `src/components/RegionPicker.astro`. It is external and first-party (no inline code — so a
   future CSP needs only `script-src 'self'`), has no framework and no imports, and stays
   under 45 lines. `checkout-client-js.test.ts` names exactly the pair
   `checkout/index.astro → RegionPicker.astro` and checks the script's shape.
2. **Progressive enhancement only.** When a country select changes, the script refills its
   state/province list from `GET /checkout/regions?country=XX` (the same server-built list,
   JSON, cacheable, no cookies read) and hides the no-JS-only Update control and hints
   (`data-region-update`). It ignores a stale answer; a new country's list always starts
   empty (a state code never carries over — CA is California and Cádiz), while a refill
   for the same country keeps a still-valid pick; it keeps the hidden record of which
   country the list was drawn for in step. The region select itself carries
   `autocomplete="address-level1"`, so browsers autofill it natively; a lost autofilled
   state is safe (the buyer picks it, and zoned stores re-ask), a wrong one is not. On any failure the no-JS page comes back, Update
   included. Every mutation stays a server-rendered `<form method="POST">` → 303, and the
   checkout is fully functional without JavaScript.
3. **One server rule for both blocks**, plus one record on the address block. If a posted
   region is a code but not one of the posted country's subdivisions, it is dropped and the
   review asks again with that country's list shown and the field marked, keeping the
   buyer's country. The address block (whose country the buyer types in, with no delivery
   re-pricing) also posts which country its list was drawn for (`regionCountry`, kept in
   step by the script): a region posted from another country's list is asked again even
   when the code exists in both (GA is Georgia and Goa), and a no-JS buyer who never saw
   the new country's list is shown it once — the region stays optional after that.
4. **Nothing else.** No other page, component or behaviour gains client JS under this record;
   `js.stripe.com` stays the only third-party origin, and `allowedHosts` is untouched.

## Consequences

- The claim becomes "the storefront ships no client JS outside `/checkout/pay`, the cart's hold
  countdown and the checkout's region list". The fence remains a test, an equality, so a
  fourth exception is again a decision someone has to write down.
- JS-on buyers never see a stale list; no-JS buyers get one rule with one message.
- `/checkout/regions` is a new public read endpoint serving fixed CLDR-derived data only.
