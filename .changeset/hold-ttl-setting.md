---
"@otta-sh/plugin": minor
---

Wire the admin's `holdTtlMinutes` setting to the cart hold (issue #127).

The setting was persisted, validated and shown back in the admin, and the cron's `expire-holds` leg read it — but `InProcessCommerceClient` built its cart use-case deps without a `ttlMs`, so every add and adjust stamped the domain's fixed 15-minute default and every lazy cart read measured against it. Changing the setting changed nothing a shopper saw, and a store on a shorter window had its sweep and its cart reads disagree about when a hold lapsed.

`getCart`, `addCartLine` and `adjustCartLine` now read the saved window from the settings store on each call (one document read; a setting change takes effect on the next cart call). The unsaved default is still 15 minutes, so a store that never touched the setting behaves exactly as before.

New: `CommerceClient.getCartHoldTtlMinutes()`, and the public `storefront/product` route's success result carries `cartHoldMinutes`, so a theme's hold note can state the effective window instead of hard-coding the default.
