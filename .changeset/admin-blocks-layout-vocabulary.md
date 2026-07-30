---
"@otta-sh/plugin": patch
---

Widen the admin Block Kit type surface and add the shared layout vocabulary the
six admin screens will build on (admin-UX density increment 1 + the engine half of
increment 2). Pure foundation: additive, no page file touched, no visual change
yet. Verified against the pinned em-dash **0.31.1**.

`packages/plugin/src/types.ts` — mirror the block types the renderer already
supports but Otta never declared: `ColumnsBlock`, `TabBlock`/`TabPanel`,
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
fields into a closed `accordion` labelled `Filters` or `Filters (2 active)` (a
COUNT only: a label is a control with a tight width budget), renders 1–2 fields
inline, and throws rather than hiding a problem in two cases: above 4 filter
fields, and when the form does not carry a prefill digest matching itself — i.e.
every filter form must come from `carriedForm`, unconditionally, or its React key
could not change when its prefilled values do (the `Clear filters` staleness bug).
Its `blockId` is required and stable across an apply.
`filterSummary(parts)` composes the human-readable `status: paid · last 30 days`
for the `section` beneath the panel — pass the same array to both so the count and
the summary cannot disagree. `emptyState(...)` emits a real `empty` block. There is
deliberately NO "filter fields in columns" helper: a form's fields always render
`flex flex-col` and `columns` takes `Block[][]`, so laying one filter out
horizontally would split its submit.

`admin/scaffold/list-detail.ts` — the engine recovers carried context from
`input.block_id` (`CustomActionApi.carried`, plus `readCarrier(input)` for a
screen's `parseOpen`), and the drill path is recoverable from the carrier as a
third, lowest-precedence source after `value.__path` / `values.__path`, both
unchanged. The path-carry injection recurses into layout containers via one
exhaustive `childBlockLists` helper — so a future container block is a compile
error rather than a silently re-broken guarantee — and stands down only for a
carrier naming the EXACT current path. `carried` holds the screen's OWN fields only
(the reserved `__path`/`__v` are stripped); the drill level arrives as
`carriedPath`.

NO EXCEPTION ESCAPES THE HANDLER, which matters because the helpers above throw by
design. Every path that runs screen code fails closed to a banner: a leaf's
`render`/`notFound` join `load` inside the try (a level's `onError()`), a custom
action gets the root list plus an explicit "Action outcome unknown — the action may
already have been applied" banner (never a bare failure, since the side effect may
have committed before the re-render failed), and a last-resort wrapper covers what
no inner try can reach — `createClient`, `parseOpen`, `filterFromValues`, and a
screen's own `onError()` throwing — including the compound case where the fallback
render throws too, which still reports the unknown outcome rather than a generic
error. Without this a throw became a non-2xx, which replaces the whole
`BlockRenderer` tree with a raw status panel, unmounts every accordion and tab, and
leaves an operator unable to tell whether a refund applied. Every contained failure
is logged (`console.error("[otta] …", err)`), because the fail-closed banner is
indistinguishable from an unreachable service and the log is the only place a
screen bug's cause survives.
