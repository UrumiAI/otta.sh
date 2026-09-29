---
"@otta-sh/plugin": minor
---

The storefront checkout is priced for where the order goes (#305 part 2, ADR-0021): the
shipping/tax zone is derived from the address, the review offers the matched zone's
delivery options, and the Shipping admin keeps zone regions to ISO codes.

**BREAKING:**

- `QuoteRequestWire.shippingZoneId` and `CheckoutRequestWire.shippingZoneId` are removed;
  a caller that still sends one (past the type) is refused with a `CommerceInputError`.
  The quote takes `destination?: { country, region? }`.
- The checkout and quote reasons gain `INVALID_SHIPPING_ADDRESS` (quote),
  `MISSING_SHIPPING_ADDRESS`, `SHIPPING_ZONE_NOT_MATCHED`,
  `SHIPPING_REGION_CODE_REQUIRED`, `SHIPPING_METHOD_NOT_IN_ZONE`,
  `SHIPPING_METHOD_NOT_APPLICABLE` and (checkout) `SHIPPING_METHOD_REQUIRED`.
- `storefront/checkout/place` refuses (`INVALID_INPUT`) a `shippingAddress` whose country
  is not two letters or whose region is not code-shaped; a code-SHAPED value that is not
  a real code reaches the domain's typed refusal. Every new order needs an ISO country.
- The rules client refuses zone regions that are not ISO codes, and stores them
  uppercased.

**Added / changed:**

- `quoteCheckout` replies with `requiresShipping`, `destination` { status, zoneId,
  matchedRegion } and `discountedSubtotalCents`; new `listShippingOptions`, fed only
  from the quote's own reply. A zone tie-break is logged with ids only.
- `storefront/checkout/summary` takes `destination`. Its view gains `shipping`
  { status, matchedRegion, noOptions, options }, `requiresShipping`,
  `addressRequired`, `readyToPlace`, `uncalculatedReason`, `selection.destination` and
  `selectionErrors.destination`. A refused destination drops the method with it; a
  method on a digital-only cart is dropped silently; a lone priced option is
  preselected. The locked review is `readyToPlace` exactly while its order is pending.
- The Shipping console validates regions (naming each bad token with a hint), refuses
  a code another zone already lists, labels legacy tokens "never matches", and warns
  about such zones on the landing page and the zone's methods screen.
- Exports `COUNTRY_CODES` and `isCodeShapedRegion` for a storefront's country picker.
- The published package includes `THIRD_PARTY_NOTICES` (Unicode licence for the bundled
  CLDR data).
