---
"@otta-sh/domain": minor
"@otta-sh/plugin": patch
---

A currency typed into the admin must be a real ISO-4217 code. `@otta-sh/domain` exports
`CURRENCY_CODES` / `isIsoCurrencyCode` — a static snapshot of ICU 78.3's currency list
(2026-10-02) minus withdrawn currencies (ANG, BGN, CUC, HRK, SLL, ZWL) and non-cart units
(XDR, XSU), with a Node-only drift test. The Shipping rate and Coupon create screens refuse
`XYZ` ("XYZ is not an ISO-4217 currency"), and the rules client's `createRate` /
`createCoupon` refuse it too (`CommerceInputError` on `currency`). Reads and edits of
stored rows are unchanged.
