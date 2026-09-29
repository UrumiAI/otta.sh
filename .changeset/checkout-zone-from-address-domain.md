---
"@otta-sh/domain": minor
---

The checkout derives the shipping/tax zone from the shipping address (#305 part 2,
ADR-0021). Nobody supplies a zone any more, so nobody can choose a zero-tax one, and a
chosen shipping method must belong to the zone the address matched.

**BREAKING:**

- `QuoteCommand.zoneId` and `CreateOrderCommand.shippingZoneId` are removed. The quote
  takes `destination?: { country, region? }` and a required `requiresShipping`; the
  order derives both from its lines and its `shippingAddress`.
- **Every new order's address carries ISO codes.** The country must be an ISO 3166-1
  alpha-2 code (CLDR "regular", XK included) — `"United States"` is now
  `INVALID_SHIPPING_ADDRESS` — and a non-blank region a real ISO 3166-2 subdivision of it
  (`CA` or `US-CA`, stored as `CA`), else `SHIPPING_REGION_CODE_REQUIRED`. This holds in
  stores with no zones and for digital-only orders too. Existing orders are unchanged.
- In a store with zones, a cart with a physical line needs an address
  (`MISSING_SHIPPING_ADDRESS`) that matches a zone (`SHIPPING_ZONE_NOT_MATCHED`) and a
  method of that zone (`SHIPPING_METHOD_REQUIRED`, `SHIPPING_METHOD_NOT_IN_ZONE`). A
  digital-only cart ignores the address for pricing and refuses a method
  (`SHIPPING_METHOD_NOT_APPLICABLE`). All six are new `CreateOrderFailure` /
  `QuoteFailure` members, refused before anything is redeemed or minted. A same-key
  replay still returns the original order first.
- `NormalizeOrderAddressResult`'s failure now carries `reason: "INVALID" | "REGION_NOT_A_CODE"`.

**Added:** the ISO 3166 lists generated from CLDR 48.2 (`COUNTRY_CODES`,
`SUBDIVISIONS`; generator and vendored XML are dev-only, and the Unicode licence ships
in `THIRD_PARTY_NOTICES`), `normalizeCountryCode` / `normalizeSubdivision` /
`isCodeShapedRegion` / `parseZoneRegions` / `validateZoneRegionsInput`,
`resolveShippingZone` (exact codes, most specific wins, lowest id on a tie), and
`quoteShippingOptions` (a zone's methods priced for a cart: one `listMethods` plus one
rate read per method). The quote result carries its `destination` resolution, and the
order's shipping snapshot is `{ zoneId, methodId, matchedRegion }` when a zone matched.
`ShippingZone.regions` is documented as the ISO codes the matcher reads; the port and
every adapter are unchanged.
