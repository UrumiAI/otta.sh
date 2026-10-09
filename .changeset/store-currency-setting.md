---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
---

Store currency setting. `OperationalSettings` gains an optional `currency` (an ISO 4217 code
from the currency table, checked by `updateSettings`; absent means never saved) and
`effectiveStoreCurrency` (never saved ⇒ `"USD"`), persisted in the same settings document as the
hold time, threshold and tax block — saving one never drops another. A cart created
without a currency (the storefront's `ensureCartId`) is now in the store currency; an explicit
currency still wins, and existing carts keep theirs. A store that never saves the setting
behaves exactly as before: USD carts and USD admin defaults. No migration.

Admin: Settings → Store gets a "Store currency" select (the familiar ten first, then by code —
`CURRENCY_CHOICES`/`currencyChoiceLabel`, now shared from `@otta-sh/admin-presentation`) with
copy that changing it affects new carts only, and that it should be decided before pricing (a
product's or coupon's currency can't be changed). The unpriced product's currency picker and
price-edit hint, the shipping rate filter / new-rate currency and the coupon form's currency
hint follow it; when the admin cannot read the store currency it guesses none. Saving the
select unchanged writes nothing (a never-saved store stays never-saved).

**Storefront / theme authors:** `storefront/cart/create` now honours `currency` alongside
`replacesCartId` (it used to be ignored there). A spent cart's replacement is in the currency
the request names, else the SAVED store currency, else the spent cart's — so a theme that sends
`currency` with `replacesCartId` keeps that currency; omit it to follow the store currency.

**For out-of-tree `AdminRulesSurface` implementations:** the interface gains
`getStoreCurrency()`.
