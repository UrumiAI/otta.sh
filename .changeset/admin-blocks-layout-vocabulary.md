---
"@urumi/plugin": patch
---

Widen the admin Block Kit type surface and add the shared layout vocabulary the
six admin screens will build on (admin-UX density increment 1 + the engine half of
increment 2). Pure foundation: additive, no page file touched, no visual change
yet. Verified against the pinned em-dash **0.31.1**.

`packages/plugin/src/types.ts` — mirror the block types the renderer already
supports but Urumi never declared: `ColumnsBlock`, `TabBlock`/`TabPanel`,
`AccordionBlock`, `EmptyBlock`, `MeterBlock`, `ImageBlock`,
`SectionBlock.accessory`, `TableColumn.sortable`, `ToggleElement`,
`ComboboxElement`, `text_input.multiline`, and `block_id` on every block. The
`Block` union is now RECURSIVE (a layout container holds `Block[]`). `ChartBlock`
is deliberately NOT mirrored: `chart` formats its own values and has no currency,
so money on it would be a display float on the money path. Each addition documents
the renderer behaviour a page team must design against — the `columns` 2-vs-3
grid, client-only tab/accordion state, and why `sortable` must not be set until
sort is threaded through the list ports (a sort click renders an ▲/▼ arrow and
silently drops the operator's filter).

`block_id` is now TYPED by who echoes it. Only `form` and `table` echo it back
(three sites in the renderer; a button — including a `section` accessory and an
`empty` block's actions — carries context in `value` instead), so `encodeCarrier`
returns a branded `CarrierBlockId` that only `FormBlock`/`TableBlock` accept.
Putting a carrier on an `actions`/`empty`/`section` block is now a compile error
instead of an `api.carried` that is silently `undefined` on a money path.

`ButtonElement.disabled` (and the same phantom on `text_input`/`number_input`/
`select`) is REMOVED: 0.31.1 has no such field and no renderer reads one, so a
"disabled" element rendered as a fully live control that merely looked handled. No
screen set it.

`admin/scaffold/carrier.ts` — the hidden-context carrier. Block Kit declares no
hidden form field, so every admin form threading context through a stateless submit
rendered a single-option `select` labelled with the raw internal field name.
`encodeCarrier(namespace, context)` puts it in a `<entity>:<verb>:u1.<base64url>`
`block_id` instead; `decodeCarrier` splits on the last marker and is TOTAL —
malformed, absent, over-long (4096-char bound) or hostile input yields `undefined`,
never a throw, never a partial record. Keys are serialized in sorted order, so the
token is a function of the context alone. **Never carry an idempotency key or
nonce**: derive it server-side as `${verb}:${id}:${amount}:${watermark}` — a
carried nonce can return with a different amount, and `refundOrder` resolves by key
alone, reporting the second legitimate command as an already-applied duplicate
(hardening tracked in #152).

`carriedForm({namespace, context, form})` is the helper screens should use: it also
folds a digest of the form's own prefilled `initial_value`s into the token, so
"prefill changed ⇒ React key changed ⇒ uncontrolled inputs refresh" holds by
construction. Without it, a form nested in an accordion is index-0-forever and a
`Clear filters` re-render leaves the fields showing the filter just cleared.

`admin/scaffold/layout.ts` — `filterPanel(...)` collapses a filter form of 3+
fields into a closed `accordion` whose label carries the active filter
(`Filters · status: paid · last 30 days`, dot-separated and truncated to 60 chars),
renders 1–2 fields inline, and throws above 4 fields rather than hiding a
design-spec violation; its `blockId` is required and stable across an apply.
`emptyState(...)` emits a real `empty` block. There is deliberately NO
"filter fields in columns" helper: a form's fields always render `flex flex-col`
and `columns` takes `Block[][]`, so laying one filter out horizontally would split
its submit.

`admin/scaffold/list-detail.ts` — the engine recovers carried context from
`input.block_id` (`CustomActionApi.carried`, plus `readCarrier(input)` for a
screen's `parseOpen`), and the drill path is recoverable from the carrier as a
third, lowest-precedence source after `value.__path` / `values.__path`, both
unchanged. The path-carry injection recurses into layout containers via one
exhaustive `childBlockLists` helper — so a future container block is a compile
error rather than a silently re-broken guarantee — and stands down only for a
carrier naming the EXACT current path.
