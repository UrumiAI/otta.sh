---
"@otta-sh/domain": minor
---

Shoppers no longer see the order id: an order is named by what was bought.

- **`orderLabel(lines)`** (new, pure) — the one shopper-facing name of an order:
  `"Otta Tee"` for one line, `"Otta Tee × 3"` when it was bought more than once,
  `"Otta Tee and 2 more"` for several lines. A blank or missing title is skipped
  when choosing which title leads; with no usable title at all it is `"Your order"`
  (`ORDER_LABEL_FALLBACK`) — never the id, never an empty string. Titles are
  normalised first — control characters (CR/LF included) and whitespace runs become
  one space — and clamped to `ORDER_LABEL_TITLE_MAX_LENGTH` (80) code points with an
  ellipsis, because the label now reaches email subjects and page titles. Exported with its
  input type `OrderLabelLine` (`{ title?: string | null; quantity: number }`) so every
  surface — the order emails here, the storefront through `@otta-sh/plugin` — spells
  the same order the same way.
- **Order emails** — all eight order templates now say `"Order confirmed — Otta Tee
  and 1 more"` rather than `"Order confirmed — order <uuid>"`, and their bodies read
  `Order: <label>` (HTML-escaped in the HTML part). The label is built from the
  `lines` `buildOrderEmailData` already passes; `data.orderId` is unchanged and still
  carried for the dispatcher — it is simply no longer rendered.
