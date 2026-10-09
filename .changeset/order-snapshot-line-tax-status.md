---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
---

Each order now remembers every line's tax status (#427). The frozen v1 tax snapshot
(`order_totals.taxBreakdown`, ADR-0030) gains an optional per-line `taxStatus` —
`taxable`, `shipping_only` or `none` — the product's status as the tax calculator was
asked at checkout. A later edit to the product no longer leaves an old order unable to
explain why a line was or was not taxed (refunds, audits, support).

Backward compatible: the snapshot stays `v: 1`. A line written before this has no
`taxStatus` and `readOrderTaxSnapshot` returns it without one — unknown, never defaulted
to "taxable". A present but unrecognised value makes the snapshot unreadable, as any
other malformed field does. Snapshots are still written once and never rewritten, so a
replay under the same idempotency key returns the same bytes.

The admin order detail's wire (`OrderLineWire.taxStatus`, optional) carries the frozen
status, and the Line items table marks a line that was not ordinarily taxed beside its
title — "· Tax: None" or "· Tax: Shipping only", the product form's own labels
(`orderLineTaxStatusNote`). A taxable line, or one from an older order, shows nothing.
