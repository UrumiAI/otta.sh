---
"@otta-sh/plugin": patch
---

A currency typed into the admin must be a real ISO-4217 code. Creating a shipping rate
or a fixed-amount coupon in `XYZ` — three letters, so it passed the shape check — is now
refused ("XYZ is not an ISO-4217 currency"). The check uses a static snapshot of the
currencies in current use (`admin/currency-codes.ts`), not the host's ICU, so it answers
the same under Node and workerd. Values the system mints keep the shape-only check.
