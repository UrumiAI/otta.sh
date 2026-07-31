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
- **A collapsed label reads as persisted state, so it only ever states persisted state.**
  On a REJECTED operational save the form keeps the attempted value for correction, and
  the label keeps stating what the service actually holds — a group reading
  `99999 min hold` after the service refused 99999 would be reporting a value nothing
  stored.
- **An over-budget label loses a value, not the tail.** Right-truncation would delete the
  last segment outright and leave a label that looks complete, so the truncation costs
  the longest value and only by the overflow: a 50-character tax-class slug shortens and
  `· 3200 g` survives. Every label on both screens — the constant ones included — goes
  through that one helper.
- **The product identity strip is four entries, not six.** `SKU · Price · Status · Stock
  on hand` — the four operational facts, in two row-major pairs. `Title` restated the
  page header verbatim one block below it; `Kind` moved to the Classification & shipping
  form, which both states the current value and is where it is changed. Nothing replaced
  the Title row with a Title input: `product_commerce.title` is a CMS-owned
  single-writer cache (ADR-0013) and `ProductEditWire` has no `title` member, so one
  would not compile.
- **A blank token submit stops claiming it saved something.** The token fields render
  empty on every mount and a blank submit deliberately keeps the stored token, so the
  receipt now says `Nothing entered — admin token unchanged` instead of `Admin token
  saved` above a group labelled `token not set`.

A Settings render also stops re-reading kv for what it already has: seven sequential
`ctx.kv` gets become five, of which the last three run concurrently. Two were re-reads
of tokens the handler had fetched at the top of the request, and both booleans the
labels need are derivable from the tokens already in hand. A token save updates what its
own re-render is computed from, so a first-ever save reports the token it just persisted
as set rather than as missing.

No service, wire, or schema change.
