---
"@otta-sh/plugin": minor
---

**New public route `storefront/shopper-state` (`STOREFRONT_SHOPPER_STATE_ROUTE`,
`ShopperStateResult`)** and `CommerceClient.getShopperState({ cartId?, sessionToken? })`:
the storefront header's cart state and unit count plus a yes/no for a live session —
never who. At most one cart-document read and one session-document read, no kv and no
price join; unusable input reads nothing.

**BREAKING** for an out-of-tree `CommerceClient` implementation: `getShopperState` is a
new required method.
