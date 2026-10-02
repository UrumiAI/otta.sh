---
"@otta-sh/plugin": patch
---

A duplicate id on the Shipping, Tax or Coupons create screens now says so. The
in-process rules client answers a store collision (a zone, method, rate, tax class,
tax rate or coupon id already taken, or a coupon code already claimed) as the create's
`{ ok: false, status: 409 }` refusal — a missing parent zone or method as `404` —
instead of rejecting. Those errors are raised before anything is written, so they no
longer reach the console's custom-action net as "Action outcome unknown — the action may
already have been applied". The screens name the conflict ("A tax rate with the ID
"std-us" already exists") and keep the operator's typing on the create screen. Any other
store failure still rejects.
