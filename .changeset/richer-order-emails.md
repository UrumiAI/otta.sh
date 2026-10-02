---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Order and sign-in emails now say what the shopper needs (QA U-3).

- **Order emails** (every state email, the late-payment notice, the refund notice,
  and the cancelled email with its refund line) list the order's own line snapshot
  (product name × quantity — line price; a blank title reads "Item"), then the order
  page's totals rows with its labels: Subtotal, "Discount · CODE" (or "No coupon
  applied"), Shipping, Tax, and "Paid" / "Total". Shipping or tax that was never
  calculated reads "Not calculated", as on the order page, never "$0.00". The ship-to
  address is shown only while a delivery is live (confirmation, processing, shipped,
  delivered). A "View your order" link points at the order page, and the email signs
  off with the store's display name when one is set. A refund email still leads with
  the amount refunded; its order total is labelled "Order total". The HTML part
  declares its language.
- **Money** is formatted by the storefront's formatter: "$100.00", "₹1,234.50",
  "¥1,500" — no more "100.00 USD".
- **Sign-in email**: names the store (Settings → "Store display name"), labels the
  link ("Sign in to <store>") with the URL kept as the plain-text link and a
  copy-paste fallback, and states the real lifetime ("expires in 15 minutes"),
  taken from the TTL the verifier is built with (`LOGIN_LINK_TTL_MS`).
- **Breaking (domain)**: `renderEmail(template, data, context)` now takes an
  `EmailRenderContext` — `formatMoney` (required), `storeName`, `orderPageUrl`,
  `locale`.
  The domain no longer formats money itself. `buildOrderEmailData` adds
  `subtotalCents`, `discountCents`, `shippingCents`, `taxCents`,
  `appliedCouponCode`, `shippingCalculated`, `taxCalculated` and
  `shippingAddress`. New export `EMAIL_NOT_CALCULATED_LABEL`.
- **Plugin**: the order link is `<origin of settings:loginLinkUrl>/orders/<id>` —
  the page checkout already sends the shopper to. Unset or invalid ⇒ no link;
  an `http:` URL other than localhost/127.0.0.1/[::1] ⇒ no link (a bearer link
  must not travel in clear text); never derived from a request's `Host`.
- **Plugin**: new export `STOREFRONT_LOCALE` ("en"), the one locale the site's
  `SITE_LOCALE`, its account pages and the order emails share. `STORE_DISPLAY_NAME_KEY` now lives in
  `email/email-render-context.ts` (still re-exported from the Settings form and
  the package root).
