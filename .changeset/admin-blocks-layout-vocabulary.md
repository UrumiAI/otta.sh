---
"@urumi/plugin": patch
---

Widen the admin Block Kit type surface and add the shared layout vocabulary the
six admin screens will build on (admin-UX density increments 1 + the engine half
of 2). Pure foundation: additive, no page file touched, no visual change yet.

`packages/plugin/src/types.ts` — mirror the block types em-dash 0.29.0's renderer
already supports but Urumi never declared: `ColumnsBlock`, `TabBlock`/`TabPanel`,
`AccordionBlock`, `EmptyBlock`, `MeterBlock`, `TableColumn.sortable`, and
`BlockBase.block_id` on every block. The `Block` union is now RECURSIVE (a layout
container holds `Block[]`). Each addition documents the renderer behaviour a page
team has to design against — the `columns` 2-vs-3 grid, client-only tab/accordion
state, and why `sortable` must not be set until sort is threaded through the list
ports.

`ButtonElement.disabled` (and the same phantom on `text_input`/`number_input`/
`select`) is REMOVED: em-dash 0.29.0 has no such field and no renderer reads one,
so a "disabled" element rendered as a fully live control that merely looked
handled. No screen set it.

`admin/scaffold/carrier.ts` — the hidden-context carrier. Block Kit has no hidden
form field, so every admin form that had to thread internal context through a
stateless submit rendered a single-option `select` labelled with the raw internal
field name (operators were asked to pick an `orderId`, an `expectedAmountCents`,
even an idempotency `nonce`). A block's `block_id` IS echoed back on the
interaction it fires (`blocks/form.tsx:57`, `blocks/table.tsx:55,64`), so
`encodeCarrier`/`decodeCarrier` put that context in an opaque, prefixed token
instead. Decode is total — malformed, absent or hostile input yields `undefined`,
never a throw, never a partial record.

`admin/scaffold/layout.ts` — `filterPanel(...)` collapses a filter form of 3+
fields into an `accordion` whose label carries the active filter (`Filters —
status: paid, last 30 days`) so a closed filter still says what you are looking
at, and renders 1–2 fields inline; `emptyState(...)` emits a real `empty` block.
There is deliberately NO "filter fields in columns" helper: a form's fields always
render `flex flex-col` and `columns` takes `Block[][]`, so laying one filter out
horizontally would mean splitting it across independent submits.

`admin/scaffold/list-detail.ts` — the engine recovers carried context from
`input.block_id` (`CustomActionApi.carried`, plus `readCarrier(input)` for a
screen's `parseOpen`), and the drill path is now recoverable from the carrier as a
third, lowest-precedence source after `value.__path` / `values.__path` — both of
which keep working unchanged. The path-carry injection now recurses into layout
containers, so collapsing a deep filter form cannot silently re-filter the root
list.
