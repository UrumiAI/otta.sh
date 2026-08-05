---
"@otta-sh/admin-react": patch
---

The row that tints on hover gets a target. Orders and Pricing & inventory rows have tinted
on hover and on focus-within since they were migrated, but the cursor computed `auto` and a
click anywhere except the small link in the primary cell was inert — a tint promising a
target across the whole row when the target existed in one corner of it. The whole row now
opens the record.

- **One delegated listener, not one per row.** `Table` takes an `onActivateRow` callback and
  attaches a single handler to the table body; each row carries its record id in
  `data-row-id`, which the handler reads off the closest row. A forty-row page adds one
  listener, not forty, and a table that passes no callback — the four detail tables — is
  unchanged.
- **The link stays the row's only tab stop.** No `tabindex`, no `role` and no keydown handler
  goes on the row. Enter already opens the record because the primary cell's link already
  does, and a second stop per row would double keyboard traversal on every list in the
  console. Measured before and after: two stops per row on both lists, unchanged.
- **A click inside a control belongs to that control.** Activation bails when the event
  target sits inside a link, button, input, select, textarea, summary or label — which is
  what stops the drill-in link navigating twice, and the copy button copying *and*
  navigating.
- **Selecting text is not clicking.** The press position is recorded on `mousedown` and a
  click that landed more than 4px away is treated as a drag, as is a click that ends with a
  live selection inside the row. Dragging across a SKU selects it and goes nowhere. The
  `code` element the SKU renders in is deliberately not exempted from activation: exempting
  it would make the one cell an operator most needs the one cell that does nothing.
- **A modified click on a bare cell does nothing.** The row is not a link and has no address
  for a new tab to be opened at, so ctrl/cmd/shift-click on bare cells is inert rather than
  approximate. Middle-click needed no work at all — `click` does not fire for it, so the link
  still opens a tab and the row still does nothing.
- **The pointer stops at the controls.** `cursor: pointer` on an activatable row,
  `cursor: auto` on its interactive descendants, so the pointer never promises row activation
  over a button that copies.

No service, wire, or schema change, and no new dependency. Verified with unit tests over the
activation guard and with headless Playwright against a locally served admin console with the
admin route intercepted; both lists were exercised for each behaviour above.
