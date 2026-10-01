# 0021. Checkout derives the shipping/tax zone from the shipping address (ISO 3166 codes)

- Status: accepted
- Date: 2026-09-29
- Amends: [ADR-0009](./0009-checkout-address-capture.md) — **Decision 3** (required-for-physical is
  now enforced, scoped to stores with zones), **Decision 5** (the address IS a pricing input: it
  decides the zone) and its zone/address-divergence consequence (divergence can no longer happen).
  Supersedes #73's "regions are opaque config the engine never reads".
- Issue: #305 part 2 (part 1: the coupon and the shipping method reach the quote and the order).
- Amended: 2026-09-30 — **Decision 9's referrer clause only**: `/checkout` sends `same-origin`, not
  `no-referrer`, and the responses to its own POSTs send `no-referrer`. See "Amended 2026-09-30"
  at the end of this record.

## Context

Until now the checkout priced tax from a `zoneId` the caller supplied and shipping from a
`methodId` the caller supplied, and nothing tied the two together (`computeQuote` took the method's
rate and ignored `method.zoneId` for tax). A client could pick the zero-tax zone and any zone's
cheapest method — the **cross-pairing bug**. The storefront sent no zone at all, so every order was
untaxed. Zone regions were free text the engine never read ("United States", "EU", "Bavaria").
Tax rates are keyed by the same zones, so fixing the zone fixes both shipping and tax. ADR-0009 had
named "the address is a record, not a pricing input" as a deliberate, temporary simplification.

## Decision

1. **The zone comes from the address, and only from it.** A pure domain function
   (`resolveShippingZone`) derives it from the normalised ship-to. `shippingZoneId` is removed
   from `CreateOrderCommand`, `QuoteCommand` (`zoneId`) and the commerce-client wire types; the
   public storefront routes never read such a key, and the in-process client refuses a cast one
   as a programmer error (`CommerceInputError`) no buyer can reach. Tax follows the matched zone.
   A chosen method must belong to it (`SHIPPING_METHOD_NOT_IN_ZONE`).
2. **Codes from CLDR, pinned.** Countries are **CLDR's `regular` regions restricted to the ISO
   3166-1 officially assigned alpha-2 codes, plus XK** — 250 codes. CLDR `regular` is wider
   than "officially assigned": it also lists the ISO 3166-1 **exceptionally reserved** codes
   AC, CP, CQ, DG, EA, IC and TA, which a payment provider need not accept as a shipping
   country (an order to one could be minted and then fail at payment). The generator excludes
   exactly those, through an explicit `EXCEPTIONALLY_RESERVED` list, and a test pins them
   absent. **XK** (user-assigned, Kosovo) is kept (D11); the officially assigned uninhabited
   territories (AQ, BV, HM, UM) are kept too — they are ISO countries. EU, UN, ZZ and the
   reserved/private-use ranges are not `regular` and never appear. Subdivisions are ISO 3166-2
   codes with status `regular`, minus any of an excluded country. Both are generated from
   **CLDR 48.2** (`unicode-org/cldr` tag `release-48-2`, `common/validity/{region,subdivision}.xml`)
   into `packages/domain/src/pricing/iso-3166.generated.ts` by the committed
   `packages/domain/scripts/generate-iso-3166.ts`, over the vendored XML (dev-only, D14). A test
   re-runs the generator and requires the committed file **byte for byte**; the file is in
   `.prettierignore`, so the generator — not oxfmt — owns its layout. The Unicode License v3
   notice ships in `THIRD_PARTY_NOTICES` inside the published `@otta-sh/domain` and
   `@otta-sh/plugin` tarballs (the plugin bundles the domain); `scripts/` is not published.
   Matching ignores case and surrounding spaces, uses **exact codes only — no hierarchy**
   (`FR-IDF` does not cover `FR-75C`), and the **most specific** zone wins: an exact
   subdivision beats its country. Legacy non-code regions stay stored as they are (no
   migration) and never match; the admin refuses non-codes from now on.
3. **Regions are codes everywhere — checked in two layers.** The route parsers and the site
   check SHAPE only (a two-letter country; a region matching `^([A-Za-z]{2}-)?[A-Za-z0-9]{1,3}$`),
   so malformed input is `INVALID_INPUT` before any store work. MEMBERSHIP is the domain's: a
   code-shaped value that is not a real code (`XX`, `ZZ`) reaches the domain and is refused with a
   typed reason the buyer can act on (`SHIPPING_REGION_CODE_REQUIRED`, `INVALID_SHIPPING_ADDRESS`)
   — never `INVALID_INPUT`, never a bounce to `/cart`.
   - The **code validity of a non-blank region applies to every order** — digital-only ones and
     stores with no zones included. `CA` and `US-CA` are accepted and stored as the bare `CA`
     (D13; the full `US-CA` is on the order's snapshot as `matchedRegion`).
   - The **blank-region rule applies only when the cart requires shipping**: a blank region is
     allowed unless the country has any subdivision-level zone, and then it is
     `SHIPPING_REGION_CODE_REQUIRED` (no fallback to the country zone). A digital-only order to
     (US, blank) in a store with a US-CA zone orders.
   - **Residual:** a typo that is itself a valid code (CO for CA) still misprices. Removing it
     needs address verification, which is out of scope.
4. **No match refuses.** If any zones exist and the address matches none, checkout refuses with
   `SHIPPING_ZONE_NOT_MATCHED` ("We don't ship to this address.") and creates nothing. A store with
   **no zones** keeps today's behaviour: no shipping, no tax, no address required.
5. **Which carts need what.**
   - A cart with a physical line, in a store with zones, needs an address
     (`MISSING_SHIPPING_ADDRESS`) and a method of the matched zone (`SHIPPING_METHOD_REQUIRED`).
   - **Digital-only** carts: the address is never used for pricing and never refused on zone
     grounds, and the quote does not even read the zones for them. A stored address must still
     be valid (ISO country, code-or-blank region). A method is refused
     (`SHIPPING_METHOD_NOT_APPLICABLE`, D10) at the domain and at place; the storefront summary
     drops a stale one **silently**. The summary deliberately does not pre-validate a digital
     cart's address: it ignores it. The `SHIPPING_REGION_CODE_REQUIRED` copy ("Enter your
     state/province code (e.g. CA), or leave it blank if your country doesn't use one.") assumes
     no delivery, and no site page shows it for a digital cart (the review has no address block
     there). Location-based tax on digital goods is a future ADR.
   - Mixed carts: the address is required, and the zone's rates apply to every line.
6. **Every new order carries an ISO alpha-2 country** — stores with no zones included. Free-text
   countries are `INVALID_SHIPPING_ADDRESS`, free-text regions `SHIPPING_REGION_CODE_REQUIRED`.
   This breaks API callers; the changesets say so. Existing snapshots are unchanged.
7. **What the order records.** When a zone matched, the order's shipping snapshot is
   `{ zoneId, methodId, matchedRegion }`; otherwise it is `null`.
8. **Replays keep the original.** A same-key replay returns the original order and re-evaluates
   neither the address nor the method — the idempotency short-circuit runs first. The locked
   review page relies on this: its place form sends the key, the email and the coupon echo only
   (no address, no method). A changed selection on replay is a follow-up
   (`CHECKOUT_REPLAY_MISMATCH`).
9. **Data in URLs.** The storefront review is priced by
   `GET /checkout?country=&region=&method=&coupon=` (plus `error=` on a failure redirect), and the
   delivery form's hidden `fromCountry`/`fromRegion` echo the destination it was rendered for, so a
   changed destination drops a method chosen for the old one — compared **normalised** (uppercase,
   the country prefix stripped: `ca` = `CA` = `US-CA`). Only the coarse country, a region code,
   the opaque method id, the coupon code and an error token ever go in a URL; never a name,
   street, city, postcode, phone or email (`checkoutPath` knows no other key). `/checkout` sends
   `no-referrer`. *(Amended 2026-09-30: it sends `same-origin`, and its POSTs' responses send
   `no-referrer` — see the end of this record.)*
10. **Overlaps.** The admin refuses a code another zone already lists, naming that zone. If one
    slips through (a zone written before this rule), the lowest zone id wins and the tie is logged
    with zone ids and the matched code only (`{ zoneId, ambiguousWith, matchedRegion }`).
11. **The review offers the matched zone's options** (`listShippingOptions`: one `listMethods` plus
    one rate read per method, once per render, fed only from the quote's own reply — never route
    input). A zone with exactly one option priced in the cart's currency is preselected, never over
    an explicit method and never on the locked page; when that preselect replaces a method dropped
    as `SHIPPING_METHOD_NOT_IN_ZONE`, no notice is raised (the page states the method charged).
    The summary's fallback re-quotes are bounded at four quotes (five product reads) including the
    preselect. On the locked page `readyToPlace` is `phase === "payable"` and nothing is quoted.

## Consequences

- A delivery step (country, region code, method radios) is required on the review for a cart that
  ships in a zoned store; resubmitting it loses typed address fields (the coupon form's trade-off).
- Merchants whose zones hold legacy text get every physical checkout to those destinations refused
  until they fix them; the Shipping landing page and the zone's methods screen warn, and each zone
  row labels the tokens that never match. The staging seed has no zones.
- **Zones with no regions (`null` or `[]`) now match no address.** Before this ADR a blank
  regions list was normal — nothing read it — and a method can only live in a zone. A store whose
  zones all have blank regions therefore refuses **every** physical checkout until codes are added
  (`SHIPPING_ZONE_NOT_MATCHED`); a store with a mix refuses the destinations no zone lists. The
  Shipping landing page and the affected zone's methods screen warn ("Some zones match no
  address … add codes such as US, US-CA"), and each zone row says "Matches no address".
- No "rest of world" zone, no wildcards, no postcode matching yet.
- The CLDR data is refreshed per release by a generator run (vendor the XML, bump the version,
  regenerate, update `THIRD_PARTY_NOTICES`). About 20 KB of generated source ships in the plugin
  bundle.
- Stripe receives a valid alpha-2 country and a bare state code.
- An unknown tax class resolving to 0 bps is out of scope (separate issue).
- Changesets for `@otta-sh/domain` and `@otta-sh/plugin` flag the breaking changes.

## Alternatives rejected

The buyer picks the zone; accept the client's zone and cross-check it; fuzzy region names; fall back
to the country zone when a subdivision zone exists; shape-only subdivision codes (no membership);
subdivision hierarchy; wildcard zones; postcode matching; fetching CLDR at generation time only
(the generator test could not re-derive the file offline).

## Amended 2026-09-30 — Decision 9's referrer clause, and only that clause

Everything above is left as written except the pointer in Decision 9. The rest of Decision 9 —
which keys may ride a URL, and that no personal data ever does — is unchanged.

- **`/checkout` sends `Referrer-Policy: same-origin`, not `no-referrer`.** Under `no-referrer`,
  browsers send `Origin: null` on the page's own form POSTs (Fetch's "append a request `Origin`
  header" sets it to `null` when the policy is `no-referrer`). The site's origin guard
  (`src/lib/origin-guard.ts`) correctly reads `null` as cross-site, so `/checkout/place` and
  `/checkout/new-cart` answered 403 and no order could be placed from a browser. This is the bug
  #329 fixed on `/account/verify`. `same-origin` still sends no Referer to any other origin, so
  the coupon never leaves on an outbound link or any cross-origin request. The policy is also sent
  as a **response header**, as defence in depth: it covers every subresource fetched before the
  parser reaches the `<meta>` (which arrives through the head slot, after the layout's preloads).
- **The responses to `/checkout`'s own POSTs send `Referrer-Policy: no-referrer`.** Under
  `same-origin` those POSTs carry the full `/checkout?coupon=…` URL as their Referer, and a 303
  keeps the request's referrer, so the page the redirect lands on — `/checkout/pay`, where
  js.stripe.com runs — would hold the code in `document.referrer`. A redirect response's
  `Referrer-Policy` replaces the policy for the follow-up request, so every response from
  `/checkout/place` and `/checkout/new-cart` carries `no-referrer` and the redirected GET carries
  no referrer at all. It is on every response rather than only the 303 to `/checkout/pay`, so no
  path can forget it.

ADR-0012's `no-referrer` for the order page (Decision 6, the client secret) is not changed here.
The same `Origin: null` rule is why the order page's dead-end door ("Go to your cart") is a GET
link to `/cart` (which is not `no-referrer` and offers the `POST /checkout/new-cart` for the
checked-out cart) rather than a form on the order page itself.
