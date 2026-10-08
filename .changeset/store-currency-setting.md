---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
---

Store currency setting. `OperationalSettings` gains an optional `currency` (an ISO 4217 code
from the currency table, checked by `updateSettings`; absent means never saved) and
`effectiveStoreCurrency` (never saved ⇒ `"USD"`), persisted in the same settings document as
the hold time, threshold and tax block — saving one never drops another. A cart created without
a currency (the storefront's `ensureCartId`) is now in the store currency; an explicit currency
still wins, and existing carts keep theirs. A store that never saves the setting behaves exactly
as before: USD carts and USD admin defaults. No migration.

Admin: Settings → Store gets a "Store currency" select (the familiar ten first, then by code —
`CURRENCY_CHOICES`/`currencyChoiceLabel`, now shared from `@otta-sh/admin-presentation`) with
copy that changing it affects new carts only. The unpriced product's currency picker, the
shipping rate filter / new-rate currency and the coupon form's currency hint follow it.

**For out-of-tree `AdminRulesSurface` implementations:** the interface gains
`getStoreCurrency()`.
