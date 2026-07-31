---
"@otta-sh/plugin": minor
---

Accordion labels state the values they hide, so the collapsed screen is readable
(admin-UX INC-15). A Block Kit console cannot draw cards, and a group whose label is a
bare noun — `Identity`, `Service connection` — makes the operator open it just to find
out whether it holds anything. The labels now answer that, which is the cheapest
density win the surface allows.

- **Product detail.** `Identity — BRD-WAL-M`, `Classification & shipping — standard ·
  3200 g`, beside the `Price — $85.00 USD` label that already worked. The tax class
  renders as its natural-key slug rather than `name (id)`: the pair would consume the
  whole 60-character label budget on its own, leaving no room for the weight the group
  also exists to show.
- **Settings.** `Checkout & holds — 15 min hold · low stock at 5` and `Service
  connection — token set · service token not set`, and each group now renders closed.
  The screen used to open `Store`, the one cosmetic field on it, pushing the two groups
  that hold operational and connection state below an expanded form. This is the
  render-time kind of closing: no `block_id` changes to force a group shut, so no
  unsubmitted operator input is ever discarded.
- **A token's label states a FACT about the credential, never any part of it.** "Token
  set" is derived from a boolean the render already had; neither token value is in
  scope where the labels are built, and the whole-response no-echo pins cover the
  labels along with everything else. Both tokens stay write-only and never render back.
- **An absent value is named, not implied.** `Identity — no SKU`, `Classification &
  shipping — no tax class · no weight`, `Store — no display name`, and — when the
  secondary `GET /settings` fails — `Checkout & holds — not loaded` rather than a label
  reading `0 min hold · low stock at 0`.
- **The duplicated `Title` row on product detail is gone.** It restated the page header
  verbatim one block below it, spending a row of the densest block on the screen. The
  title still renders as the header, its CMS ownership is still stated by the Identity
  group's own context line, and nothing replaced the row with a Title input:
  `product_commerce.title` is a CMS-owned single-writer cache (ADR-0013) and
  `ProductEditWire` has no `title` member, so one would not compile.

A Settings render also stops re-reading kv for what it already has: seven sequential
`ctx.kv` gets become five, of which the last three run concurrently. Two were re-reads
of tokens the handler had fetched at the top of the request, and both booleans the
labels need are derivable from the tokens already in hand. A token save updates what its
own re-render is computed from, so a first-ever save reports the token it just persisted
as set rather than as missing.

No service, wire, or schema change.
