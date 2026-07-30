---
"@otta-sh/plugin": minor
---

Coupon management admin UI (admin-UX Increment 3, slice 4): a new `/coupons`
admin screen — a keyset-paged coupons list (search = case-insensitive EXACT
code match, the enumerate capability PR #74 added) drilling into a per-coupon
detail/edit leaf, with create, LWW full-replace edit, and delete with the
forbid-if-redeemed audit-trail conflict rendered honestly. Built entirely on
the existing list/detail scaffold and `AdminRulesClient` — no domain or
service change.

UNCHANGED-vs-CLEAR, presented honestly: coupon UPDATE is the documented LWW
exception (PR #71) and its wire is a FULL replacement — the service coerces
every omitted field to null, so the wire cannot say "leave this field alone".
The edit form therefore pre-fills EVERY editable field with the current value
and always submits all of them (explicit null for a blanked field, never
relying on omission): "leave unchanged" = don't touch the pre-fill, "clear" =
blank the field, and the form's own copy says exactly that. The one axis with
no "unset" — the primary economic value (`amount` for fixed_amount, `rate`
for percentage; the domain requires it) — refuses to blank at the plugin
boundary. Identity/kind (`id`, `code`, `type`, fixed-amount `currency`) are
immutable and render read-only. The detail load is the exact-code list search
(not `GET /coupons/:code`) because only the list projection carries
`startsAt`/`expiresAt` — a full-replace form that couldn't pre-fill the
window would silently clear it on every save. Date bounds are normalized to
ISO-8601 UTC at the boundary (the domain compares window strings
lexicographically against an ISO-UTC now).

Money is TEXT inputs parsed by the shared `money-input` exact-integer helper
(never a float, never `number_input`); percentage rates reuse the Tax
console's exact bps parser/formatter. A percentage coupon is
currency-agnostic, so its cap/minimum render as plain decimals — no invented
currency symbol. Cross-type inputs (a rate on a fixed_amount create, an
amount on a percentage create) are explicit boundary errors, never silently
dropped.

Delete carries danger copy (in-flight carts recompute; placed orders keep
their snapshotted discount); a redeemed coupon's detail withholds the delete
button and says why, and the server-side 409 renders the same audit-trail
copy for the race where a redemption lands after render. Every failure path
is a generic fail-closed banner — no raw HTTP status/URL ever reaches the
admin UI.
