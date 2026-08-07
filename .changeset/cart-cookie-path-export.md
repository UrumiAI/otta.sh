---
"@otta-sh/plugin": patch
---

Export `CART_COOKIE_PATH` alongside `CART_COOKIE_NAME`, so the cart cookie's path
has one home rather than a literal repeated at each end. `cartCookieDescriptor`
now reads the constant instead of an inline `"/"`, and a theme shim clearing the
cookie can import the same value rather than restating it — a delete whose path
does not match the setter's silently deletes nothing, and the two were previously
free to drift.

Additive and behavior-neutral: the emitted `Set-Cookie` is byte-identical, and the
constant's value is the `"/"` the descriptor already carried. The cookie's other
attributes — `httpOnly`, `secure`, `sameSite` — are unchanged and still declared on
the descriptor alone.
