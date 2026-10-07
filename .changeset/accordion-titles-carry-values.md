---
"@otta-sh/plugin": minor
---

Accordion labels state the values they hide, so the collapsed screen is readable
(admin-UX INC-15). A Block Kit console cannot draw cards, and a group whose label is a
bare noun — `Identity`, `Checkout & holds` — makes the operator open it just to find
out whether it holds anything. The labels now answer that, which is the cheapest
density win the surface allows.

- **Product detail.** `Identity — BRD-WAL-M`, `Classification & shipping — standard ·
  3200 g`, beside the `Price — $85.00 USD` label that already worked. The tax class
  renders as its natural-key slug rather than `name (id)`: the pair would consume the
  whole 60-character label budget on its own, leaving no room for the weight the group
  also exists to show.
- **Settings.** `Checkout & holds — 15 min hold · low stock at 5`, and each group now
  renders closed. The screen used to open `Store`, the one cosmetic field on it, pushing
  the group that holds operational state below an expanded form. This is the
  render-time kind of closing: no `block_id` changes to force a group shut, so no
  unsubmitted operator input is ever discarded.
- **An absent value is named, not implied.** `Identity — no SKU`, `Classification &
  shipping — no tax class · no weight`, `Store — no display name`, and — when the
  settings read fails — `Checkout & holds — not loaded` rather than a label
  reading `0 min hold · low stock at 0`.
- **A collapsed label reads as persisted state, so it only ever states persisted state.**
  On a REJECTED operational save the form keeps the attempted value for correction, and
  the label keeps stating what is actually persisted — a group reading
  `99999 min hold` after the save was refused would be reporting a value nothing
  stored.
- **An over-budget label loses a value, not the tail.** Right-truncation would delete the
  last segment outright and leave a label that looks complete, so the truncation costs
  the longest value and only by the overflow: a 50-character tax-class slug shortens and
  `· 3200 g` survives. Every label on both screens — the constant ones included — goes
  through that one helper.
- **The product identity strip is four entries, not six.** `SKU · Price · Status · Stock
  on hand` — the four operational facts, in two row-major pairs. `Title` restated the
  page header verbatim one block below it; `Kind` moved down into the Product panel — its
  summary row plus the Classification & shipping form, which is where it is changed. It
  took the slot `Inventory policy` held in that summary, a verbatim duplicate of the
  Stock panel's own row, so the policy now has one home and a deleted product (which
  renders no edit forms at all) still states its kind. Nothing replaced the Title row
  with a Title input: `product_commerce.title` is a CMS-owned single-writer cache
  (ADR-0013) and `ProductEditWire` has no `title` member, so one would not compile.

A Settings render also stops re-reading kv for what it already has, collapsing the
sequential `ctx.kv` gets the handler had already made at the top of the request and
running what remains concurrently.

No wire or schema change.
