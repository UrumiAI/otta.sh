---
"@otta-sh/plugin": minor
---

Admin Settings checks what it saves and says what it holds (QA U-8).

- **Payment keys are trimmed and shape-checked.** The Stripe secret key must start
  `sk_live_`/`sk_test_` (or restricted `rk_live_`/`rk_test_`), the webhook signing secret
  `whsec_`; any other key must be one line with no spaces. A wrong shape is refused naming the field, never the
  value, and the key already stored stays.
- **Key fields are password inputs** (`secret_input`, always empty, no `has_value`). Each
  label says "— set" or "— not set", and a set key has a **Remove** button behind a confirm
  (new action `clear-payment-secret`, value `{ secret: <field id> }`).
- **The Payments & email label states the truth**: Stripe test/live (from the key prefix),
  webhook set or not, email set or not. The optional x402 and edge keys no longer read
  as missing.
- **Checkout settings are all-or-nothing.** A blank, signed, fractional, non-numeric or
  out-of-range hold time or low-stock threshold is refused by name and nothing is saved —
  it used to be dropped while the screen said "Settings saved". "Settings saved" now states
  the new values.
- **The sign-in page address must be `https://`** (or `http://` on localhost, 127.0.0.1 or
  [::1]) to be saved, because the emailed link carries a sign-in token. A value saved before
  this release is still used.
- Each key shows its expected shape as help text above the field. Remove on a key that is not
  stored says so, and after a removal the notice says where to find the key again. A stored
  clear-text sign-in page saved before the https rule shows a warning (sending is not blocked).
  A refused payment-settings save names every problem at once and keeps what was typed.
- **Plain wording.** Labels and help text no longer say "service", "write-only", "TTL" or
  "CAIP-2". Two labels and a button changed: "Cart hold time (minutes)", "Sign-in page
  address", "Save checkout settings". Action ids and field ids are unchanged.
