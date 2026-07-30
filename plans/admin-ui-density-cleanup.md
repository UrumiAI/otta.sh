# Plan — Admin UI density & layout cleanup

Status: **ready to build** (2026-07-30, amended three times — most recently to match the spec's revision 4, after increment 3 shipped). Scope: the **seven** Urumi admin screens
under `packages/plugin/src/admin/` — Orders, Pricing & inventory, Coupons, Tax, Shipping, Reports
and Settings (`admin-route.ts:83-101`). Earlier revisions said "six". Verified against a live local staging admin (Orders, order
detail, Pricing & inventory) and against the em-dash Block Kit that staging actually runs.

> **This plan sets scope; [`docs/admin/ADMIN-CONSOLE.md`](../docs/admin/ADMIN-CONSOLE.md) sets
> visual structure.** Where they disagree on *which increment ships what*, this plan wins. Where
> they disagree on *what a screen looks like*, the spec wins. Three items in this plan were
> **withdrawn** during the spec's review because the renderer cannot support them as written —
> they are struck below and listed in the spec's §0.1 A. Read the spec's §0.1 before starting
> any increment.

## The problem

The admin screens read as a printed API response rather than a console: every block renders
full-width in a single vertical stack, so the Orders list spends ~350px of scroll on a filter
form before the first order, and the order detail runs ~3,200px tall over eleven sections.
Concretely, observed on the running app:

- **Filter forms are a vertical stack of full-width fields** — Orders has status + two dates +
  search each on its own row, ~1,100px wide.
- **You cannot click a table row.** Every list has a separate "Open X" select + button
  *below* the table, so you re-pick the row you were just looking at.
- **Forms show fake dropdowns for internal plumbing.** Single-option `select` fields whose
  label is the raw `action_id` — `orderId`, `currency`, **`nonce`**, `expectedAmountCents`,
  `expectedRateBps`, `expectedUpdatedAt`, `expectedFlag`, `classId`, `zoneId`, `methodId`.
  The refund form asks a human to pick an idempotency nonce.
- **Empty sections cost as much as real ones** — "No sessions (guests never sign in)" gets a
  full section heading and table.
- **Destructive emphasis is inverted.** "Mark refunded" is a red button; "Cancel order
  (cannot be undone)" is a plain form submit with no confirm dialog. The three "Move status"
  buttons each occupy their own `actions` block, so they stack vertically.
- **Badge noise** — Pricing & inventory renders a column of identical black `physical` pills.
- **Totals break reading order** — a two-column `fields` grid puts Subtotal/Shipping/Total on
  the left and Discount/Tax on the right.

## Why it happens (and why most of it is cheap to fix)

The pages emit a deliberately narrow Block Kit subset — `header`, `section`, `context`,
`table`, `fields`, `form`, `actions`, `banner` (documented as such at
`packages/plugin/src/types.ts:210`). All of those render full-width in one stack.

Two findings make this mostly a plugin-side fix:

1. **emdash 0.31.1 — the exact version `origin/main`'s `sites/staging` pins — already renders
   all 18 block types**, including `columns`, `tab`, `accordion`, `empty`, `meter` and `code`.
   Verified against the installed `renderer.tsx` dispatch and `packages/blocks/src/blocks/`.
   Nothing needs a version bump.
2. **`FormSubmit` carries `block_id`**, and the form renderer forwards it
   (`packages/blocks/src/blocks/form.tsx:57`, `block_id: block.block_id` on submit). So all the
   fake carrier dropdowns can move into an encoded `block_id` token and be deleted from the
   visible UI. A `table`'s sort/load-more does the same (`table.tsx:55,64`); a **`button` does
   not** (`elements/button.tsx:15-21` sends `{type, action_id, value}` only), so every
   button-triggered action carries its context in `button.value` instead — see the spec's B-1.

The whole of `packages/blocks/src` is **byte-identical between 0.29.0 and 0.31.1** (both
`git diff` against the tags and `diff -rq` over the two installed `dist/` trees are empty), so
this analysis holds against current upstream and the row-click gap is still real upstream today.
**Resolve versions from a worktree off `origin/main`** — several long-lived branches still carry
a 0.29.0 lockfile.

## Increments

Each is one PR, tagged `[Plugin]`, verified against the **workerd-on-Node sandbox** (per
`CLAUDE.md`), with a screenshot attached.

**Correction to this plan's original test premise.** It claimed the per-page
`*-page.sandbox.test.ts` suites "assert by searching for blocks by type (not by index), so they
survive re-layout". That is true for **reordering** and **false for nesting**: every search is
flat over the top-level array, while `BlockRenderer` recurses into `columns`/`tab`/`accordion`.
The moment a screen moves into `tab > accordion`, those searches return `undefined`/`[]` and the
suites pass while asserting nothing. Measured: Orders has **89** flat type searches and 17
`section`-as-heading assertions across 1541 lines. So the programme ships recursive test helpers in
`packages/plugin/test/helpers/blocks.ts`, and **each screen ports its own suite onto them as the first,
behaviour-free commit of its own PR** — see the spec's §15 V-1a. (Also: there is no
`reports-page.sandbox.test.ts`; Reports and Settings are covered by `*-widget.sandbox.test.ts`.)

**Two corrections to the ownership this plan implied** (2026-07-30, after increment 3 shipped):

1. The **helpers were not shipped by the foundation.** Increment 1 (PR #151) did not contain them;
   increment 3 wrote them (`aa2bd97`). They exist and are delivered — do not re-author them.
2. **`assertBlockContract` has no owner in this plan and does not exist**, so **30 mechanically-
   decidable spec rules are enforced by nothing shared**, including the banned-phrase guard — which
   matters because the only two live violations are on Pricing & inventory. It is assigned to the
   **second per-screen increment to start**, as a **standalone PR**, and it **must land before the
   third screen** (spec §15 V-3a).

### 1 — Shared layout vocabulary in the scaffold

Widen `packages/plugin/src/types.ts` with the block types the renderer already supports:
`ColumnsBlock`, `TabBlock`/`TabPanel`, `AccordionBlock`, `EmptyBlock`, `MeterBlock`, and
`TableColumn.sortable`. Add scaffold helpers so the seven pages share one layout language rather
than each inventing it. No page behaviour change yet.

~~a `filterRow()` that lays a filter form's fields out via `columns`~~ — **WITHDRAWN.** A
`form`'s fields always render `flex flex-col gap-4` (`form.tsx:63`) and `ColumnsBlock` takes
`Block[][]`, so laying one filter out horizontally means splitting it across several `form`
blocks — several independent submits, each losing the others' unsubmitted edits. Shipped
`filterPanel()` instead (collapse the whole form; the collapsed label carries the active filter),
plus `emptyState()` for a real `empty` block. **Any screen PR that planned a horizontal filter
row must re-plan** against the spec's L-2/L-3.

Also in scope for this increment, added by the spec's review (§0.1 B–D): `SectionBlock.accessory`,
a `combobox` field spec, `multiline` on the text-input spec; the carrier codec's
`encodeCarrier(namespace, context)` → `<entity>:<verb>:u1.<b64>` grammar; `filterPanel`'s
`blockId` becoming **required**; splitting `filterPanelLabel` into a count-based label plus a
`" · "`-joined `filterSummary`; `filterPanel` **throwing** at 5+ fields and at a prefilled form
whose token carries no digest; and `carriedForm({ namespace, context, form })`, which folds a digest
of a form's own prefilled values into its `block_id` under the reserved key `__v` and hands the form
back ready to emit. Also `readBoolean`, without which every `toggle` silently fails to persist
(`readString` returns `undefined` for a boolean, `scaffold/list-detail.ts:334`).

### 2 — Kill the carrier dropdowns (the biggest single win)

Replace the per-file `hiddenCarrier` / `idCarrier` / `stockCarrier` helpers with **one**
scaffold helper that encodes carried context into the form's `block_id`, and teach
`list-detail.ts` to read context from `input.block_id` (it already reads `value.__path` /
`values.__path`; this is the same idea one level up). Then delete every single-option carrier
`select` across orders / products / coupons / tax / shipping.

**The `nonce` picker is deleted, not relocated** (spec F-2a — this supersedes this plan's earlier
"minted server-side per submission" wording, which would give every confirm click a fresh key and
make a double-click double-refund). Every admin write derives its idempotency key
deterministically from its content **with the observed watermark as a key component** —
`admin-refund:${orderId}:${amountCents}:${refundedSoFarCents}`. No nonce is minted at render time,
carried in a `block_id`, or put in a `button.value`.

This removes ~15 fake dropdowns and is what makes the forms stop looking like debug output.
Update the sandbox suites' carrier assertions to assert the `block_id` token instead.

### 3 — Orders list + order detail

Two sub-PRs: (a) port the orders suite onto the recursive helpers, no behaviour change;
(b) the re-layout. Per the spec's §11. **Shipped as PR #161** (`aa2bd97` → `3c7f037`), which also
authored `test/helpers/blocks.ts` and produced the errata now recorded in the spec's §0.2. That PR is
**revised after** the spec's round-3 amendment lands, not before.

- Collapse the filter form into a `filterPanel` accordion (**not** a `columns` row — withdrawn
  above), label carrying an active-filter count, values in a `section` below it with
  `Clear filters`.
- Order detail into a `tab` block with **four task-named panels** — `Order` · `Fulfilment` ·
  `Money` · `History` (spec D-2). The earlier `Overview`/`Actions`/`History` split is superseded:
  actions live beside the data they act on, and there is no "Actions" junk drawer.
- Collapse Cancellation and Refunds into `accordion`s, closed by default — they are rare,
  irreversible, and currently sit open in the scroll path.
- Render the totals ladder as a two-column `table` (spec M-4); `fields` is row-major, so no
  ordering of `fields` entries can make a five-line ladder read downward. Drop the
  `physical`-style badge on single-valued columns — **including the refunds ledger's `Kind`**, whose
  value is the order's own gateway capability and is therefore constant down the table (spec T-5).

~~the list table gains `sortable` on Created/Total~~ — **WITHDRAWN.** A sort header fires
`page_action_id` with `{sort}` and no cursor (`table.tsx:52-57`), so the click silently discards
the operator's filter and ignores the sort it asked for. Blocked until `ListLevelDef.fetchPage`
threads an ordering parameter into the service list ports (spec T-3).

~~Real `empty` blocks for the guest/no-data sections~~ — **WITHDRAWN.** Collides with the spec's
E-2/D-7: `empty` is a large centered illustration earned by a screen's *primary* collection at
true zero. A secondary empty collection folds into one parent `context` line ("Guest checkout — no
account, no saved addresses, no sign-in history.").

### 4 — Consistent destructive-action language

One rule across all seven pages: destructive ⇒ `style: "danger"` **and** a `confirm` dialog.
Cancel-order, refund and remove-stock are currently forms, and `FormBlock` has no confirm — so
restructure each per the spec's §8, which gives **three** shapes rather than one, chosen by what
input the act needs: DA-2 (no input) · DA-2b (closed set or an already-known value — one danger
button per value, **no staging**, which is the majority path for both cancel and refund) · DA-3
(free text or a typed amount — stage then confirm, **two** action ids, no `-edit`). Two rules
that are easy to get silently wrong: forcing the state-2 group open needs **both** a changed
`block_id` and `default_open: true` (spec B-6), and every confirm handler **re-reads the record
and refuses on a watermark mismatch** (spec DA-3a).

Put the "Move status" buttons in a single `actions` block. The one-block-per-button split **does**
still reproduce and is not a renderer bug: `actions.tsx:14` keys elements by
`action_id ?? index`, so duplicate `action_id`s collide as React keys. The fix is distinct
per-state ids **derived from the `ORDER_STATES` constant**, with `customActions` built from the
same constant and any service-offered state outside it not rendered — otherwise
`admin-route.ts:130` falls through to `{blocks: []}` and the console goes blank (spec DA-6).

### 5 — The remaining six screens

Apply increments 1–4's vocabulary to Pricing & inventory, Coupons, Tax and Shipping, each against
its own block listing in the spec's §12 (§12.1–§12.4) — **plus Reports and Settings** (see the
paragraph at the end of this increment). Six screens, not four; the heading said "four" from the era
when the programme miscounted the console at six screens.

**Read the spec's front-matter rule N-1 and its §0.2 before starting any of the six.** N-1 settles
what to do when a §12 listing contradicts a spec rule (the rule wins, and the listing is a defect you
report); §0.2 is the errata list increment 3 produced by building against these listings for the first
time. Three of its four substantive defects came from following a listing that contradicted a rule, so
this is not a formality. Tax and Shipping render an edit form
**plus** delete button inline for *every* row simultaneously — those become per-row `accordion`s
so the list stays scannable. Three constraints the original bullet missed:

- The per-row accordion list is a **runtime branch**, not a replacement: it applies only when the
  fetched page is complete and ≤25 rows, because `table.next_cursor` + "Load more" is the only
  paging affordance in the vocabulary. Both branches ship (spec L-9), and the **zero-row** case
  renders an `empty` block because the accordion branch has no table to carry `empty_text`
  (spec L-9b). Shipping's rates level is exempt — it is a 0-or-1-row currency lookup (spec L-9a).
- **Do not split the coupon edit form.** `updateCoupon` is a `PUT` and the service coerces absent ⇒
  `null` (`rules-admin.ts:434-443`), so a split save would silently wipe `startsAt`, `expiresAt`,
  `maxUses` and `maxUsesPerCustomer`. It stays one `condition`-gated form (spec F-5a, F-5c). The
  sibling-form split is legal for **products only**, where the sparse PATCH is verified end to end.
- The button-in-row `View rates` / `View methods` drill-in needs `value: {target: encodePath(...)}`
  carrying the **full** path, plus each screen's `parseOpen` reading `input.value?.target` — today
  it reads `input.values` only and the click bounces to the root list (spec §12.7).
- `toggle` lands in this increment (it is the first consumer) and is **mount-only** with a
  mandatory `initial_value` (spec F-6, F-6b).

This increment also owns Reports and Settings, which are neither lists nor details and get their
own skeleton (spec §4.1, §12.5, §12.6): bring both onto the `{variant, title, description}` banner
shape (they emit the legacy `{variant, text}`, whose body the renderer drops), format Reports'
money via `formatMoney` and **keep a two-column revenue table — no `chart`**, since `chart` cannot
format money; register `REPORTS_ACTION_IDS` so the newly-required `page_action_id` cannot blank the
console; and make every Settings save re-render the whole page (`save-display` currently returns
two blocks and discards the other three forms).

## Follow-up (separate, needs a fork change)

**Table row click.** `packages/blocks/src/blocks/table.tsx` has no row click/link support —
rows only handle sort and load-more. That is the sole reason the "Open X" select+button exists
on every list. Add an optional `row_action_id` to `TableBlock` in the em-dash fork
(`/home/azureuser/emdash-fork`, branched from freshly-synced `main`), then delete the
open-forms plugin-side. Route it upstream the same way as the conditional-writes PRs — set the
commit author to `Vedanshu <vedanshu@urumi.ai>` and follow the PR template.

Until that lands, the open-select stays; increments 1–5 do not depend on it.

## Out of scope

Storefront theme work (tracked separately under the "Tempered" direction) and any change to
the commerce service or domain. This is presentation-only: no port, wire-format, or money
handling changes.
