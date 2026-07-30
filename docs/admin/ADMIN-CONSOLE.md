# Urumi admin console — design spec

Status: **normative** (2026-07-30, revision 4, plus two amendments. **(1)** DA-3a-ii is **replaced**
and DA-3a-iii added, because the scaffold gained a render-state channel in `ce5eecb` and
revision 4's DA-3a-ii said it had none. **(2)** Four rules kept their requirements and had their
**stated reasons** corrected, each having confused the emitted response with what the operator sees:
**D-5** and **X-18** are scoped explicitly to the emitted response — a screenshot showing two open
groups is not an X-18 finding; **DA-2c** is restated on emphasis grounds, its "~1100px" geometry
being wrong (`actions` is one horizontal row); **F-5a-i** is new, because F-5a's sibling-discard
hazard may no longer be excused as "realistically one group is open" — open state is sticky, so a
split form set must carry a `context` line saying so (X-45); and **DA-3**'s outermost-group rule
keeps its wording but drops "the confirm is invisible", which was checkably false, for the real
ground: a response must not depend on client state it did not set.) Applies to all **seven** admin
screens under
`packages/plugin/src/admin/` — Orders, Pricing & inventory, Coupons, Tax, Shipping, Reports and
Settings, as registered at `admin-route.ts:83-101`. (Earlier revisions said "six"; the count was
wrong and five parallel teams read this line.)

## Verification basis — read this before citing a renderer fact

`origin/main` pins **emdash 0.31.1** exact (`sites/staging/package.json`). Resolve versions and
read `node_modules` from a worktree off `origin/main` — several long-lived branches still carry a
0.29.0 lockfile, and an earlier revision of this document was written against one of them.

Everything below was verified three ways:

1. **The installed 0.31.1 types**, in a worktree off `origin/main`:
   `node_modules/.pnpm/@emdash-cms+blocks@0.31.1_*/node_modules/@emdash-cms/blocks/dist/validation-5vL6669b.d.ts`
   (authoritative types) and `validation-Dq-a7CXm.js` (the compiled validator).
2. **Every renderer** in `/home/azureuser/emdash-fork/packages/blocks/src/`.
3. **The 0.29.0 → 0.31.1 delta, which is nothing.** `diff -rq` over the two installed `dist/`
   trees is **empty** (the content-hashed filenames are even identical), and in the fork both
   `git diff @emdash-cms/blocks@0.29.0 HEAD -- packages/blocks/src` and
   `git diff @emdash-cms/blocks@0.31.1 HEAD -- packages/blocks/src` are **empty**. The block
   renderers did not change between the two tags.

So the fork checkout is a faithful read of what staging runs. **Citations in this document are to
the fork source and the installed 0.31.1 dist; they are valid for 0.29.0 as well.** Do not send a
team diffing against the 0.29.0 tag — the repo no longer uses it.

**How to use this document.** Rules are numbered (`P-1`, `L-3`, `T-5`…). A reviewer cites the
number and marks pass/fail against the diff. Every rule here is decidable by reading the diff or
by running the shared assertion helper (§15); no rule requires a judgment call. If one seems to,
it is a defect — file it, don't improvise.

---

## ⚠ PRECEDENCE — the rule beats the listing. Read this before §11 or §12.

This document has **two normative layers**: the **rule tables** (§5–§10, §13) and the **per-screen
listings** (§11, §12). They are not always consistent, and this is the single rule that decides what
to do when they are not:

> **N-1.** Where a §11 or §12 per-screen listing conflicts with a §5–§10 rule or a §13
> anti-pattern, **the rule wins**, and the listing is a **defect to be reported** in the
> implementing PR — not silently followed, and not silently deviated from.

**Why this is rule number one.** Revision 4 exists because the first screen built against revision 3
shipped four substantive defects and **three of them came from following a §11.2 listing that
contradicted a rule.** That is the correct instinct — a listing written *for your screen* is more
specific than a general table — and it will happen again on the six screens that follow. N-1 does not
ask you to spot the contradiction; it tells you what to do the moment you feel one.

**In practice, three obligations:**

| | |
|---|---|
| **Implementer** | Build the **rule**. Add a `### Listing defects` heading to your PR body naming the listing line, the rule it violates, and what you built. One line each. |
| **Reviewer** | A diff that follows a listing against a rule is a **fail**, even when the listing says otherwise. So is a deviation that is correct but undisclosed. |
| **This document** | Every defect reported this way is folded into the listing in the next revision. §0.2 is the current backlog. |

N-1 is deliberately blunt about the alternative: an implementer who silently deviates is right once
and leaves six teams to rediscover it, and an implementer who silently complies ships the bug. The
only outcome that compounds is the reported one.

**N-1 does not license taste.** It resolves *conflicts with a stated rule*, nothing else. A listing
line you merely dislike is not a defect; build it. If no rule speaks to the conflict at all, that is
a **gap** — build the listing, report the gap.

---

**Precedence — against the plan.** Where this document and
[`plans/admin-ui-density-cleanup.md`](../../plans/admin-ui-density-cleanup.md) disagree on
*visual structure*, this document wins. Where they disagree on *scope* (which increment ships
what), the plan wins — **except** for the three plan items withdrawn in §0.1 A, which are
withdrawn outright and have been struck from the plan in the same commit as this revision.

**Three absolute voice rules.** (1) The phrase "no oversell" / "never oversold" / "no overselling"
must not appear in any admin **copy** — describe the mechanism ("the store stops selling at zero
stock"), never the slogan. This governs rendered strings only; the same words inside a **code
comment** documenting the domain invariant are correct and must not be "fixed" (§13, X-20).
The two live violations are on Products — see the warning at the top of §12.1.
(2) Degraded-state copy is honest, not apologetic: no "sorry", no "oops", no blame, no raw HTTP
status or URL. It also does not assert a cause it cannot know (E-7), and it never narrates a design
decision to the operator (DA-7a).
(3) **British spelling in rendered copy; American in code.** `Fulfilment` is the panel label and the
word in every operator-facing string; `fulfillment` stays in the wire field, the client method and the
action id (`orders:record-fulfillment`). Mixed **by design**, and the seam is exactly the render
boundary — do not "unify" either side.

---

## 0. Renderer facts you must design against

Verified behaviours of the renderer, not preferences. Every rule downstream follows from one of
them.

| # | Fact | File | Consequence |
|---|---|---|---|
| R-1 | `form` renders its fields `flex flex-col gap-4` — **one field per row, full width, always**. | `blocks/form.tsx:63` | Form fields **cannot** be laid out in columns. Density comes from field *count* and collapsing, never from a grid. |
| R-2 | `columns` uses `grid-cols-2` when `min(len,3) === 2`, otherwise `grid-cols-3`. | `blocks/columns.tsx:11-12` | A 1-entry `columns` renders at **33% width**; a 4-entry one renders 3 + 1 orphan. Forbidden on these screens anyway (§2). |
| R-3 | `fields` is a **row-major** `grid-cols-2`, values `truncate`d with a `title` tooltip. | `blocks/fields.tsx:5,9` | Entries read left→right, then down. Author in pairs. A ladder of 5 labels can never read downward inside one `fields` block. |
| R-4 | Every block sits in an outer `flex flex-col gap-4`; `divider` adds `my-4` on top. | `renderer.tsx:76`, `blocks/divider.tsx` | A divider costs ~48px of nothing. |
| R-5 | Only two text weights exist: `header` = `h2 text-xl font-bold`; `section`/`context` = body text. | `blocks/header.tsx:4`, `blocks/section.tsx:13`, `blocks/context.tsx:4` | There is **no mid-level heading**. `section` used as a heading reads as body prose — the single biggest cause of the current flat look (§14 item 1, §16). |
| R-6 | `table` `format:"badge"` renders a bare Kumo `<Badge>` with **no variant** — every badge looks identical regardless of value. | `blocks/table.tsx:23` | A badge adds zero information beyond its text. It only earns its ink by making a *state* column visually chunk. |
| R-7 | `table` cells carry only `px-3 py-2`: **no alignment, no width control, and `<tr>` has no click/link handler** — rows handle only column sort and load-more. | `blocks/table.tsx:98-106` | Every list needs an explicit drill-in control, and "money in the last column" is the only alignment lever there is. Tracked fork follow-up (§14). |
| R-8 | A sortable header fires `page_action_id` with `value:{sort}` and **no `cursor`**; it does send `block_id`. | `blocks/table.tsx:52-57` | Pre-foundation this decodes to `null` and resets to the unfiltered root list. Post-foundation the `page` fallback is `renderPath(readNavPath(input) ?? [])`, so a sort click **keeps the drill path** and loses only the filter and the sort itself. Either way `sortable` stays forbidden (T-3). |
| R-9 | `table` with 0 rows **and** `empty_text` renders one centered muted line — no header row, no table chrome. | `blocks/table.tsx:69-71` | `empty_text` is already cheap. It is the default empty treatment. |
| R-10 | `form` has no `confirm`. Only `button` does. | types `ConfirmDialog`, `elements/button.tsx:48-66` | A destructive act must be triggered by a button (§8). |
| R-11 | `ButtonElement` has **no `disabled`**, and neither do `text_input`/`number_input`/`select`. Urumi's mirror declared it **four times** (`types.ts:157,165,179,207`); no renderer reads it. | `elements/*.tsx` (grep: nothing) | `disabled` was a phantom — a "disabled" control rendered fully live. The foundation **deletes all four**, so after PR #151 a `disabled` button is a **compile error**, not a review catch. |
| R-12 | **Mount-only** (value read once, at mount): `text_input`, `number_input`, `select`, **`toggle`**, `secret_input`. **Effect-synced**: `combobox`, `date_input`, `checkbox`, `radio`. | `elements/text-input.tsx:42`, `number-input.tsx:45`, `select.tsx:33`, `toggle.tsx:15`, `secret-input.tsx:15`; `combobox.tsx:22`, `date-input.tsx:16`, `checkbox.tsx:17`, `radio.tsx:17` | The server cannot repopulate a mounted mount-only control. Refreshing a form's prefill requires a **remount** (§10, B-3). |
| R-12a | The effect-synced four resync their **own display state only** — the `useEffect` calls `setValue`/`setSelected` and **never `onChange`**, while `form.tsx:44-46` seeds `values` once at mount. | `combobox.tsx:22-24`, `date-input.tsx:16-18` | After a re-render the operator **sees the new value and submits the old one** (or nothing, if the field had no `initial_value` at mount). A silent display/submit divergence, strictly worse than "cannot refresh" — it is why F-6 restricts `combobox` to non-prefilling fields. |
| R-12b | `form.tsx:27-35` seeds `values` **only** from fields that declare an `initial_value`. | `blocks/form.tsx:30` | An untouched control with no `initial_value` is **absent from `values`**, not defaulted. A handler doing `Boolean(values.x)` on an untouched `toggle` silently writes `false` (F-6b). |
| R-13 | `BlockRenderer` keys children by `block.block_id ?? index`; `actions`/`empty` key elements by `action_id ?? index`; `form` keys fields by `action_id`. | `renderer.tsx:78`, `blocks/actions.tsx:14`, `blocks/empty.tsx:18`, `blocks/form.tsx:68` | Block state (form values, accordion open, active tab) persists while the key is stable. Duplicate `action_id`s in one `actions` block collide — that, not a renderer bug, is why the transition buttons were split one-per-block. |
| R-13a | A block nested inside `accordion`/`tab`/`columns` is keyed by its index **within that container's own `BlockRenderer` call**. | `blocks/accordion.tsx:20` → `renderer.tsx:78` | A sole child of an accordion is `block_id ?? 0` — index **0 forever**. The incidental remount a top-level block gets when a banner is prepended and shifts indices **does not happen inside a container**. This is why B-3a exists. |
| R-14 | `tab` keeps `activeTab` in local state and renders `panels[activeTab]?.blocks ?? []`. | `blocks/tab.tsx:14,26` | If the panel count shrinks between renders while the tab block's key is stable, the operator sees a **blank panel**. The panel set must be constant (§4, D-3). |
| R-14a | `accordion` reads `default_open` **once**, at mount: `useState(block.default_open ?? false)`. | `blocks/accordion.tsx:14` | A changed `block_id` remounts the group — and the remount **re-reads `default_open`**. Forcing a group open therefore needs **both** (§10, B-6). |
| R-15 | `validateBlocks` does **not** include `"tab"` in `BLOCK_TYPES` — all 17 others are there. Re-verified on the installed 0.31.1. | `validation-Dq-a7CXm.js:325-343` | Runtime is unaffected (`validateBlocks` is exported but invoked nowhere in the runtime or admin app), but any test or tool that validates reports `Unknown block type 'tab'`. Trivial fork fix (§14). |
| R-16 | `stats` is a non-wrapping `flex` row of bordered cards; `empty` always uses a fixed Package icon; `code` renders a syntax-highlighted snippet. | `blocks/stats.tsx:34`, `blocks/empty.tsx:25`, `blocks/code.tsx` | `stats` max 4 items; `empty.command_line` is never appropriate here; `code` has no use on these screens. |
| R-17 | `SelectElement` has **no `placeholder`**. Re-verified on the installed 0.31.1. | types `SelectElement` | Nothing can be shown in an unresolved trigger. Fork fix in §14 item 3. |
| R-17a | **The `select` trigger — and only `select` — renders the raw resolved *value*, never the option label, and renders empty when that value is `""`, `null` or absent.** `select.tsx:30-42` passes the options as **children** and passes no `items`, `placeholder` or `renderValue`. Kumo 2.6.0 wraps **Base UI** (`@base-ui/react ^1.5.0`; 1.6.0 installed), **not Radix**. With `items === undefined`, Base UI's `SelectValue` falls through to `resolveSelectedLabel(value, undefined, undefined)` → `stringifyAsLabel` → `serializeValue(value)`, i.e. the value string; and its `hasSelectedValue` selector treats `""` as "no value" exactly as it does `null`/`undefined`. | `elements/select.tsx:30-42`; `@base-ui/react/select/value/SelectValue.js:41-58`, `internals/resolveValueLabel.js` (`resolveSelectedLabel`), `select/store.js:20-32` | This is the **real** cause of every blank select — not an unresolvable `initial_value` and not the `""` option value; both earlier diagnoses were wrong. Kumo's own `Select` *does* accept `renderValue`/`placeholder`, so the fork can fix it (§14 item 3). Two consequences: F-6a's rules remove the blank, and F-6c — a `select`'s option **value is operator-visible**. Scope this to `select`: `combobox` behaves differently (R-17b), and `radio` renders each option's label as its own row caption. |
| R-17b | **`combobox` renders the option LABEL, and it has a real `placeholder`.** `combobox.tsx:50-52` passes `items={element.options}` **and** a whole-option object as `value`, so Base UI resolves a label instead of falling through to `serializeValue`; `Combobox.TriggerInput` takes `element.placeholder ?? "Search..."`; and an `initial_value` that matches no option resolves to `null` (`:16-19`), which shows the placeholder rather than a blank 36px box. `ComboboxElement` declares `placeholder?: string` (`types.ts:82-89`); `SelectElement` does not (R-17). | `elements/combobox.tsx:16-19,50-52`; fork `types.ts:82-89` | **This is the correction that matters most in revision 4.** Revisions 1–3 said selects show the raw value and named "the order picker reads a raw UUID" as the worst instance. That wart **does not exist** — the picker is a `combobox` and reads `maya.iyer@example.com · $95.00 · processing`. Consequences: F-6c binds on `select`/`radio` only; a record picker whose option value is an opaque id **must** be a `combobox` (L-7); and §14 item 3 is worth less than claimed. |
| R-18 | `banner.variant` is `"default" \| "alert" \| "error"` and is passed straight into Kumo. `banner` renders `{title, description}` only — a legacy `text` field is dropped. | types `BannerBlock`, `blocks/banner.tsx:7,21,24` | `"info"`/`"success"` are **phantoms**: Urumi's mirror allows them, the renderer forwards them unvalidated to Kumo. Constrain to the three real values (M-9). |
| R-19 | `chart` **cannot format money.** `TimeseriesChartConfig` exposes only `style`/`series`/`x_axis_name`/`y_axis_name`/`height`/`gradient`; series data is `[number, number][]`; and for a `custom` chart `formatter` is stripped as a DANGEROUS_KEY. | types `TimeseriesChartConfig`, `blocks/chart.tsx:53,108-118` | A chart renders **raw minor units** on the axis and in tooltips. Plotting major units instead puts a display float on the money path. `chart` is therefore forbidden here (§2, §12.5). |
| R-20 | `meter` takes a bare `number` with no currency, and renders `custom_value` verbatim when present. | types `MeterBlock`, `blocks/meter.tsx:7-13` | Money in `value`/`max` is unlabelled minor units. `custom_value` is **mandatory** whenever they are (M-8). |
| R-21 | `TableBlock.page_action_id` is **required** by the authoritative type. Urumi's mirror keeps it optional (a pre-existing MOD-3 divergence). | types `TableBlock` | A table without it typechecks in Urumi today and violates the renderer's contract. Reports has four such tables (§12.5). Always set it (T-6). |
| R-22 | `FormField` includes `ButtonElement`, and `form.tsx:68` renders it. But a button inside a form fires a bare `block_action` carrying **only `element.value`** — no access to the form's typed `values`, and no `block_id`. | types `FormField`, `blocks/form.tsx:64-69`, `elements/button.tsx:16-20` | A confirming button *can* sit visually inside a form; it still cannot read that form's fields. Do not conclude from `FormField ⊃ ButtonElement` that R-10 or DA-1 is wrong. |
| R-23 | `FormField` carries an optional `condition` (`{field, eq}` / `{field, neq}`), evaluated against the form's live `values` on every render. | types `FieldCondition`, `blocks/form.tsx:16-25,65-67` | A form can hide fields that do not apply to the currently-selected kind. This is the only way to keep a polymorphic create form inside the field budget (F-5b). |
| R-24 | Non-2xx from the admin route **unmounts the whole block tree**: `SandboxedPluginPage` sets `error` to `Plugin responded with ${status}: ${text}` and, when `error` is set, returns an error panel **instead of** `BlockRenderer`. | `packages/admin/src/components/SandboxedPluginPage.tsx:38-41,83-95` | A thrown or non-200 handler resets every accordion and tab and echoes the status and body to the operator. Every interaction must return **200** (E-6). |
| R-25 | `BlockRenderer` recurses into `columns.columns[]`, `tab.panels[].blocks` and `accordion.blocks`. | `blocks/columns.tsx:18`, `blocks/tab.tsx:26`, `blocks/accordion.tsx:20` | Any test that searches the top-level block array stops seeing blocks the moment they move into a container. This is what §15's recursive helpers exist for. |
| R-26 | There is **no declared hidden-field type**: `FormField` is the visible element union. | types `FormField` | Context that must cross a stateless submit rides in `block_id` (forms, tables) or `button.value` (§10, B-1). **A conditional-field trick was considered and rejected:** `getInitialValues` iterates *all* fields while the render pass skips condition-false ones, so a field with an `initial_value` and an unsatisfiable `condition` would be submitted but never drawn. That is emergent upstream behaviour a future release could legitimately change, and it does nothing for tables. Do not use it. |

### 0.1 Preconditions — read before starting any screen

Everything in this section must land **before** the first per-screen increment. PR **#151**
(`feat/admin-blocks-vocab`) is the foundation and is **open, not merged**. This spec depends on
it, and on four changes it does not yet contain.

#### A. Amendments to the plan (three items withdrawn)

| Plan item | Withdrawn because |
|---|---|
| Increment 1's **`filterRow()`** — filter fields laid out via `columns` | A form's fields are always `flex flex-col` (R-1) and `ColumnsBlock` takes `Block[][]`, so one filter across columns means several `form` blocks — several independent submits, each losing the others' unsubmitted edits. PR #151 already shipped `filterPanel()` instead; the plan text now says so. |
| Increment 3's **`sortable` on Created/Total** | Not "sort is unwired" alone — the click's *observable behaviour* is wrong. A sort header fires `page_action_id` with `{sort}` and no cursor (R-8), so post-foundation the operator's filter is silently discarded and the sort they asked for is ignored, while the drill path survives. A control that visibly does the wrong thing is worse than no control. Forbidden until `ListLevelDef.fetchPage` threads an ordering parameter into the service list ports (T-3). |
| Increment 3's **`empty` blocks for the guest/no-data sections** | Collides with E-2 and D-7. `empty` is a large centered illustration earned by a screen's *primary* collection at true zero; a secondary empty collection folds into one parent `context` line. |

#### B. Type additions, with the increment that owns each

Beyond what PR #151 adds (`ColumnsBlock`, `TabBlock`/`TabPanel`, `AccordionBlock`, `EmptyBlock`,
`MeterBlock`, `BlockBase.block_id` on every block, `TableColumn.sortable`, and the deletion of
`disabled` from all four element interfaces), this spec requires the following in
`packages/plugin/src/types.ts`. Each is **owned by one increment** — no other increment widens
these types, so the six screen teams cannot invent six conflicting shapes.

| Needed | Current gap | Used by | **Owner** |
|---|---|---|---|
| `SectionBlock.accessory?: Element` | `types.ts:233-236` has `type` + `text` only | L-6 `Clear filters`, §11.1 | **Foundation (#151 revision)** |
| `combobox` element + field spec | absent from `Element` (`types.ts:186`) and from `FormBlock.fields` (`types.ts:352`) | L-7 drill-in picker, §11.1 | **Foundation (#151 revision)** |
| `multiline?: boolean` on the text-input field spec | `FormFieldSpec` (`types.ts:310-316`) has no `multiline`; upstream `TextInputElement` does | §11.2 History "Note" | **Foundation (#151 revision)** |
| `toggle` element + field spec | absent from both unions | F-6, §12.3 Tax (`Applies to shipping`) — **the only consumer**; §12.4 Shipping has none | **The Tax screen**, not "increment 5" — increment 5 is **six** parallel screens (Pricing, Coupons, Tax, Shipping, Reports, Settings) and is not an owner |
| `ImageBlock` in the `Block` union | `types.ts`' union ends at `FormBlock`; upstream has `image` | §2 image row, §12.1 product detail *if* a product image URL ever lands | **Deferred** — add with the first real consumer, not before |

`chart` is **not** needed (R-19). `stats` already exists.

#### C. Carrier codec: the namespace moves into the token

PR #151's `encodeCarrier(context)` emits a **bare** `u1.<base64url>` and `decodeCarrier` requires
`token.startsWith("u1.")`, which contradicts B-1's grammar and leaves sibling collisions for
callers to solve. The codec changes, not the spec:

```ts
encodeCarrier(namespace: string, context: CarriedContext): string
  // → `${namespace}:u1.${base64url(json)}`   e.g. "orders:refund:u1.eyJvcmRlcklkIjoi…"
decodeCarrier(token: unknown): CarriedContext | undefined
  // splits on the LAST occurrence of ":u1." ; everything before it is the namespace
```

Three things this buys, all of which the bare form loses:

1. B-1's actual rationale survives — a `block_id` is always entity-prefixed, so a carrier token
   can never collide with an index key or with a plain semantic `block_id`.
2. Tokens are legible in devtools: a reviewer reads `orders:refund:u1.…` and knows what fired.
3. **Sibling collisions are solved for free.** Two forms in one block list carrying identical
   context no longer share a React key, because their namespaces differ. `carrier.ts` currently
   raises this hazard and delegates it to callers; after this change there is nothing to
   delegate.

Decode stays **total**: absent, non-string, no `:u1.`, non-base64, non-JSON, array, scalar,
nested, non-string-valued and `__proto__`-bearing input all return `undefined`, never a throw,
never a partial record. *Owner: foundation (#151 revision).*

#### D. Four foundation-helper defects that must be fixed in the helper, not per screen

All four concern PR #151's `packages/plugin/src/admin/scaffold/layout.ts` (a new file; it does not
exist on `main`). Fixing them per screen would give seven screens seven behaviours.

**Naming note.** Items 2 and 4 are the two places the spec and the foundation had drifted apart.
Item 4 resolves **in the foundation's favour** — the spec now says `carriedForm({...})` and `__v`.
Item 2 resolves **in the spec's favour** — the foundation had implemented an earlier ruling that put
the `" · "` join and a 60-char truncation in the accordion label; L-3/L-6 as written here supersede
it, and the foundation is implementing the two-helper split. Where a §12 listing and a shipped
helper disagree on anything else, raise it rather than guessing.

1. **`filterPanel`'s `blockId` is optional.** A screen that omits it gets `block_id: undefined`,
   the accordion keys by array index, and B-7's stability guarantee is silently void. Make it
   **required**. It must also **throw when handed a prefilled form whose `block_id` carries no
   prefill digest** — that closes the hole where a screen hand-rolls the token and silently
   reintroduces the `Clear filters` bug (B-3a). In practice: pass filter forms through
   `carriedForm` and `filterPanel` accepts them.
2. **`filterPanelLabel` composes the wrong thing.** It joins the active-filter parts with `", "`
   and appends them to the label (`Filters — status: paid, last 30 days`). L-3 now puts a
   **count** in the label and the **values** in the `section` below it, joined with `" · "`.
   Replace the one helper with two: `filterPanelLabel(label, activeCount)` → `"Filters"` \|
   `"Filters (2 active)"`, and `filterSummary(parts)` → the `" · "`-joined sentence the `section`
   carries. Neither truncates.
3. **`filterPanel` accepts 5+ fields silently.** L-2 caps a filter at 4. Make `filterPanel`
   **throw** at 5+, so the cap fails in the sandbox suite rather than depending on a reviewer
   counting fields.
4. **There is no helper that builds a form's `block_id` from its own prefill,** which B-3a now
   requires. Add **`carriedForm({ namespace, context, form })`**. Note the shape, because it is
   the foundation's and the spec has been corrected to match it: an **options object** (not three
   positionals), it takes the **whole `FormBlock`** (not a `fields` array), and it **returns the
   form with its `block_id` already set** rather than returning a token for the caller to attach —
   so there is no step a screen can skip. It computes a short digest of the form's authored
   `initial_value`s in field order and puts it in the payload under the reserved key **`__v`**
   (double underscore, consistent with the existing `__path`), then calls `encodeCarrier`. Every
   prefilling form goes through it, so "prefill changed ⇒ key changed" holds by construction and no
   screen team can forget to reflect a server-changeable value.

*Owner for all four: foundation (#151 revision).*

### 0.2 Errata from the first implementation — what building Orders taught

Revision 4 is the first revision written **after** a screen was built against this document. PR #161
(Orders) reported nineteen findings; every one is folded into the rule it belongs to, and this table
is the index so nothing is buried. **Read your screen's rows before you start.**

**#161's disclosures were written against revision 3, not this text.** So they quote rule wording,
section counts and listing lines that revision 4 has since changed — `select`-vs-`combobox` throughout,
X-11's "eight budgets" (now seven), §13's "23 of 33" (now 30 of 46), V-1's foundation ownership, and the
§11.2 lines fixed below. Reading that PR against this document, the offsets are the **fix**, not
staleness: every one of the nineteen is live and indexed here.

| # | Finding | Landed in |
|---|---|---|
| E-a | `combobox` renders the option **label**; only `select` renders the raw value. The "order picker reads a raw UUID" wart cited twice was never real. | R-17b, F-6a, F-6c, L-7, §14 item 3, §16 item 3 |
| E-b | DA-3 state 2 nested inside another accordion puts the confirm button behind a parent the **response** leaves collapsed. **Restated:** the finding as filed said the confirm "is invisible"; on the happy path the parent is still expanded from the operator's own click (B-5), so it is visible — the defect is that visibility then depends on click history, and R-24 resets it. | DA-3, §11.2 |
| E-c | A DA-3a refusal that re-renders without the staged payload silently opens a **different** group and discards what the operator typed. | DA-3a (new), §11.2 |
| E-d | `-review` never bound-checked the amount, so `900.00` on a $50 order staged a red button and a confirm dialog that were both false. | DA-3c (new) |
| E-e | The only red control on the Fulfilment panel was **"Mark refunded"** (moves no money) while the irreversible cancel was a quiet trigger. | D-6, DA-5 |
| E-f | A row of five danger buttons makes the reason enum the loudest thing on a panel whose likeliest next act is a small quiet "Mark paid". **Restated:** the finding as filed said "~1100px of solid red"; `actions` is a single wrapping row of intrinsically-sized buttons, so the cap is about emphasis, not height. | DA-2c (new) |
| E-g | The Money panel can show `Total $95.00` beside `Captured $0.00 · Remaining $0.00`, and the D-6 label degenerates to `$0.00 of $0.00 refunded`. | M-11 (new), D-6 |
| E-h | A fail-closed banner asserted *"Could not reach the commerce service"* on a path a console bug also reaches — sending the operator's page to the wrong team. | E-1, E-3, E-7 (new) |
| E-i | X-9's raw-minor-units heuristic rejects §11.2's own `Refunds recorded` count. | X-9 |
| E-j | X-11's `fields`-value budget cannot be H-enforced on a data-derived value (a 45-char email fails through no authoring fault). | X-11, §1 |
| E-k | `filterPanel` emits **no** `default_open` key; L-4's "always `false`" invited a `=== false` assertion that would fail. | L-4 |
| E-l | §11.2's transition listing omitted the observed-state watermark, so transitions were the one write exempt from DA-3a. | DA-2b, DA-6, §11.2 |
| E-m | §11.2 mandated a `Kind (badge)` column that **T-5's own third bullet forbids**, and T-5's whitelist entry for it was never valid anywhere it applies. | T-5, §11.2 |
| E-n | §11.2's `Customer` (4) and `Shipping address` (8) `fields` listings drop `Buyer reference`, `Email verified`, `Email` and `Region`. | §11.2, §4 |
| E-o | On a guest the Customer group says "no account" **five** ways, and `Email` denies an address three other elements display. | §11.2 |
| E-p | The Notes table duplicates the timeline's `Detail` column verbatim. | §11.2 |
| E-q | DA-7 lines narrated the designers' decision (*"There is deliberately no bare 'Mark shipped'"*) instead of naming the alternative. | DA-7 |
| E-r | `V-1`'s `test/helpers/blocks.ts` was assigned to the foundation and never shipped; `V-3`'s `assertBlockContract` had **no owner** and does not exist. | §15, **§15.1** |
| E-s | A staged or refused re-render costs a **full leaf re-read** (5 requests on Orders), not one — and #161's hand-rolled `stagedResponse` paid it **twice** on both of its fallback paths (`detail === null` and its `catch` each fall through to `showLeaf`), from a second render path the leaf's `notFound`/`onError` never saw. The scaffold now carries render state instead, so the level renders itself once. | DA-3a-ii, DA-3a-iii |

Two of the nineteen are recorded and **not** fixed here: an unclickable tracking URL (§14 item 5) and
`ComboboxList`'s spurious React duplicate-key warning (§14, tracked note).

**The meta-finding, and it is the reason N-1 exists:** for the duration of PR #161 the
*implementation* was a more reliable guide to the renderer than this document. Three of its four
substantive defects came from a listing that contradicted a rule. Assume this document is still wrong
somewhere; N-1 tells you what to do when you find it.

---

## 1. Principles

Six rules. Each is decidable by reading a diff.

**P-1 — Data inside the first screenful.** Only the blocks on the applicable whitelist may
precede a screen's primary data block. Nothing else may be inserted, in any order.

| Skeleton | Primary data block | Blocks permitted above it, in this order |
|---|---|---|
| List (§3) | the primary `table`, or the `empty` that replaces it | `header` · ≤1 `context` · ≤1 notice `banner` · the filter block (a **collapsed** `accordion`, or an inline `form` at ≤2 fields per L-2) · ≤1 active-filter `section` |
| Detail (§4) | the identity `fields` strip | `header` · the back `actions` block · ≤2 `banner`s |
| Report/settings (§4.1) | the first `accordion` | `header` · ≤1 `context` · ≤1 `banner` · `stats` (reports only) |

**P-2 — One `header` per screen; structure comes from `tab` and `accordion`.** `header` is the
page title and appears exactly once, as the first block. Named groups are `accordion`s (inside a
`tab` panel, or at top level). `section` is **never** a heading — it is one line of prose with an
`accessory` control. *Single exception, until §14 item 1 lands:* **at most one** `header` may
appear inside a `tab` panel, to name a group that must always be visible and cannot be an
accordion (§11.2's line-item table + totals block). One per panel, never two.

**P-3 — Emptiness earns words, not containers.** A collection with zero rows never gets its own
heading *and* table *and* explanatory line. It gets one `context` line, or a `table` with
`empty_text`, or nothing at all when a sibling line already says it (§6).

**P-4 — Data before controls.** Above the primary data, only what P-1's whitelist permits — and
the filter block only in its **collapsed** form, one row tall, with its one-line summary. Every
other control — expanded filters, create forms, edit forms, destructive actions, drill-in
pickers — sits **below** the data it acts on.

**P-5 — No internal vocabulary reaches the screen.** No `action_id`s, camelCase field names,
idempotency keys, CAS watermarks, cursor tokens, or drill-path carriers are ever rendered as a
field or in copy. Labels are the words an operator would say out loud (§7, §9).

**P-6 — Every irreversible write passes a `confirm` dialog.** One rule, all seven screens, no
exceptions (§8).

### Prose budget (checkable by character count)

| Where | Max | Rule |
|---|---|---|
| Page-level `context` (the one line under `header`) | **140** | One sentence: what this screen is, plus the one global fact that changes how numbers read. |
| Any other `context` | **200** | Longer explanation moves into the accordion it belongs to, or gets cut. |
| `banner.description` | **240** | State the consequence and the next step. Nothing else. |
| `accordion.label` | **60** | Name + the answer that makes opening it unnecessary (D-6). |
| `fields` value | **40** *(human catch, not **H**)* | A style budget, not a truncation threshold — the renderer truncates on **pixel width** (~70–90 chars at `text-sm` in a half-width column), so 40 is chosen for scannability. Prose belongs in `context`. **This is the one budget a helper must not enforce** (X-11): a 45-char buyer email or a tracking URL busts it through no authoring fault, and truncating a tracking number or URL destroys the operator's ability to copy it. So the rule binds on what the **author writes** — split an address across fields, move prose to `context` — and never on what the **service returns**. A reviewer's question is "is this prose that belongs elsewhere?", not "is this over 40?". |
| `confirm.title` | **60** | Names the act and the record. |
| `confirm.text` | **200** | Exactly two sentences: one naming the concrete amount or record, one naming the consequence. |
| `empty.description` | **200** | |

**Where the current screens actually stand.** Measured 2026-07-29 by AST-extracting each literal
and counting characters. Page-level `context` is **already** in budget on Orders and close on
Reports; the four registry/catalog screens are the problem, and the worst offenders are **in-form
explanations**, not page contexts. Do not conflate the two.

| String | File:line | Chars | Target |
|---|---|---|---|
| Orders page `context` | `orders-page.ts:192` | **127** | already in budget — keep; trim only for §11.1's wording |
| Reports page `context` | `reports-page.ts:111` | **191** | ≤140 |
| Tax page `context` | `tax-page.ts:179` | **292** | ≤140; the delete-blocked clause moves to DA-7's withheld line |
| Shipping page `context` | `shipping-page.ts:233` | **340** | ≤140; same |
| Products page `context` | `products-page.ts:225` | **452** | ≤140; the "Archived" explanation moves into the filter accordion, the stock explanation to the Stock panel |
| Coupons page `context` | `coupons-page.ts:276` | **457** | ≤140; the immutability facts move into the create accordion, the redemption fact to DA-7's withheld line |
| Products **edit-form** `context` | `products-page.ts:409` | **744** — the largest string on any screen | three ≤200-char lines, one per split edit form (§12.1) |
| Coupons **edit-form** `context` | `coupons-page.ts:483` | **613** | ≤200 (F-8) |
| Coupons withheld-delete `context` | `coupons-page.ts:492` | **198** at a 1-digit count — *inside* budget, but it grows with the count and crosses 200 at four digits | replaced by §8's normative blockquote for **copy** reasons, not length |
| Coupons delete `confirm.text` | `coupons-page.ts:583` | **301** | ≤200 |
| Orders in-form `context` ×4 | `orders-page.ts:377,737,847,880` | 212, 227, 243, 215 | ≤200 each |
| Tax/shipping level `context` ×3 | `tax-page.ts:338`, `shipping-page.ts:371,508` | 268, 285, 316 | ≤200 each |

Every other `confirm.text` on every screen is already ≤200 (`tax-page.ts:248` 132, `:448` 183;
`shipping-page.ts:308` 113, `:448` 104, `:631` 197), and no `banner.description` anywhere exceeds
240. The budget table is not a blanket rewrite mandate — it is these twelve strings.

---

## 2. Block vocabulary — allowed use

| Block | Allowed use | Forbidden |
|---|---|---|
| `header` | Page title, once, first (P-2). Plus **at most one per `tab` panel**, for a group that must always be visible and named. | A third use. Two in one panel. |
| `section` | One line of prose **with** an `accessory` control (the active-filter summary + `Clear filters`). | As a heading. Without an accessory (use `context`). As a save receipt. |
| `context` | One line of caption, caveat, cap statement, or degraded-state copy. | Paragraphs (see budget). |
| `banner` | Action outcome (notice), a state demanding attention (reconciliation), the irreversibility warning inside a destructive group. `variant` ∈ `default` \| `alert` \| `error` **only** (R-18). | More than **2 at the top level of a screen** — banners inside an accordion are not counted. `variant:"info"`/`"success"`. The legacy `{variant,text}` shape (the renderer drops `text`). |
| `fields` | Label/value pairs, authored in row-major **pairs** (R-3). | Odd entry counts. A money ladder (M-4). |
| `table` | Every list and sub-list. | >6 columns; `sortable` (T-3); `badge` on non-state columns (T-5); `next_cursor` inside a leaf detail (T-8). |
| `form` | Filters, creates, edits, staged destructive input. | Carrier or idempotency-key fields; >6 visible fields (F-5); being the trigger of a destructive act (DA-1). |
| `actions` | A row of buttons. One block per logical group, **distinct `action_id` per button** (R-13). | One block per button. |
| `accordion` | Every named group. | Nesting deeper than `tab > accordion > accordion`. |
| `tab` | Detail screens only. A **constant** per-screen panel set of 2–4 (§4, D-2). | List screens. A varying panel count (R-14). |
| `empty` | Once per screen, maximum: the primary collection at true zero state (E-2). | Sub-tables. Secondary collections. Setting `command_line`. |
| `meter` | A **real** bounded ratio: refunded-of-refundable, redemptions-of-max-uses. `custom_value` mandatory when `value`/`max` are money (M-8). | A synthetic `max`. Money without `custom_value`. |
| `stats` | Reports only, **max 4 items** (R-16). | Detail screens. Raw minor units (M-1). |
| `columns` | **Nowhere.** Forbidden on all seven screens. | Everywhere. It appears in no skeleton and no worked example here; dead vocabulary in a consistency-first document means six teams invent six uses. The type stays for future screens. |
| `chart` | **Nowhere.** It cannot format money (R-19). | Everywhere. |
| `divider` | **Nowhere.** | Everywhere (R-4) — accordion boundaries already separate groups. |
| `code` | **Nowhere.** | Everywhere. |
| `image` | Nowhere yet — no screen has an image URL on the wire. Add with the first real consumer (§0.1 B). | Inventing a URL. |

---

## 3. The list-screen skeleton

Canonical block order. Blocks marked *(cond)* are omitted entirely when their condition is
false — never rendered empty.

```
1  header          <Screen name>
2  context         (cond) ≤140 chars. Omit when the table is self-evident.
3  banner          (cond) notice from the last action, or a degraded-read warning
4  accordion|form  the filter                                        [L-2..L-5]
5  section         (cond) active-filter summary + `Clear filters` accessory   [L-6]
6  table           THE DATA — or `empty` in its place                 [§5, E-2]
7  form            (cond) "Open <entity>" drill-in — omit at 0 rows   [L-7]
8  accordion       (cond) "New <entity>" — the create form, closed    [L-8]
```

**L-1.** Nothing else appears above block 6 (P-1). In particular: no create form, no per-row edit
form, no `divider`, no second `context`, no expanded filter.

**L-2 — filter shape.** One `form`, one submit, ≤4 fields. Fields cannot be columnised (R-1). The
count is the number of fields the **screen** authors — the engine may inject the drill-path
carrier after this, and it does not count.

| Field count | Treatment |
|---|---|
| 0 | No filter block at all. |
| 1–2 | Render the `form` **directly** at position 4 (no accordion — two fields cost ~150px). |
| 3–4 | Wrap the `form` in an `accordion`, `default_open: false`. |
| 5+ | Not allowed. Drop the weakest filter or move it to a second level. **`filterPanel` throws at 5+** — a runtime failure in the sandbox suite, not a review catch (§0.1 D item 3). |

This is exactly `filterPanel`'s `inlineUpTo` default of 2. Use the helper; do not re-derive.

**L-3 — filter accordion label carries a count, never values.** The label is exactly `Filters`
when every field is at its default, and `Filters (N active)` otherwise, where **N** is the number
of the screen's authored filter fields whose submitted value differs from that field's default. No
values, no truncation, no ellipsis. Values live in L-6's `section`, which has to exist anyway
because `accordion.label` is a plain string and cannot hold a button.

**L-4 — `default_open` is never `true`** for a filter block, including when a filter is active.
The label states *that* it is filtered; the `section` below states *how*; the operator who wants
to change it clicks once.

**"Never `true`", not "always `false`".** `filterPanel` emits **no `default_open` key at all**
(`layout.ts:157-162`), which is behaviourally identical — `accordion.tsx:14` is
`useState(block.default_open ?? false)` — but an assertion written as `default_open === false` fails
against the helper's own output. Assert `!== true`, or assert the helper was used. Because the accordion's `block_id` is stable across an apply (B-7), an
operator who opened the panel stays open across the round trip — collapsed-by-default costs them
nothing.

**L-5 — submit.** The renderer places the submit button last, full width, left-aligned; do not try
to move it. Label is a verb phrase naming the result: `Apply filters`. Never `Submit`, never `Go`.

**L-6 — clearing.** When any filter is non-default, emit a `section` directly below the filter
block:

- `text` = `filterSummary(parts)` — the human summary, parts joined `" · "`
  (`status: paid · from 2026-07-01`), composed by the shared helper (§0.1 D).
- `accessory` = `button{ action_id: <entity>:apply-filter, label: "Clear filters",
  value: { __path: <encodePath(path)> } }`.

A `block_action` on `apply-filter` carries no `values`, so the scaffold rebuilds the default filter
— no scaffold change needed (`list-detail.ts:297-301`). The path must ride in `button.value`, not
`block_id`: a button never echoes `block_id` (B-1).

**This applies to any control placed in a `section.accessory`.** The accessory is a bare `Element`,
so it carries its context in `ButtonElement.value` and **never** a carrier token — even though the
enclosing `section` has a `block_id` of its own, which is not echoed. And **`__path` is not
optional at depth > 0**: omit it and the clear re-filters the *root* list while appearing to work,
which is why §12.3 and §12.4 spell the path out per level rather than abbreviating.

Clearing changes the **inner form's** key (B-3a) but **not** the accordion's (B-7) — getting that
pair backwards is the one way to break `Clear filters`, so B-7 states both change conditions side
by side. Clearing changes the **inner form's** key
(B-3a) but **not** the accordion's (B-7) — see the note there, because getting this backwards is
the one way to break `Clear filters`.

**L-7 — drill-in.** Until table row clicks land (§14 item 2): one `form` directly below the table,
one field, submit label `Open <entity>`. Omit the whole block at 0 rows.

- The field's **value** is the record id. Its **label never contains the id** — it is the human
  handle plus one or two disambiguators: `qa-ordc-2@example.com · $99.00 · paid`.
- **Element choice: always `combobox`, at any row count** — because the option value is an opaque
  record id and a `select` would render that id in its trigger (R-17a), which F-6c forbids, while a
  `combobox` renders the label (R-17b). Safe because a record picker **never prefills**, which is the
  one thing a `combobox` must not do (R-12a). *Revisions 1–3 said `select` at ≤8 rows; that put
  L-7 in direct conflict with F-6c on any short page, and it is withdrawn.*
- The field declares `initial_value` pointing at a real option (F-6a). For a picker with nothing
  pre-selected that means a first option `{ value: "none", label: "Choose an <entity>…" }`, and the
  handler treats `"none"` as "no selection" and re-renders the list unchanged. Do this **as well as**
  setting `placeholder` — F-6a is one rule for all three control types, and a `combobox` whose
  `initial_value` resolves to nothing is legible but still fails the shared assertion.

**L-8 — creating.** A create form lives in an `accordion` labeled `New <entity>`,
`default_open: false`, at the very bottom. Exception: at true zero state the create action is the
`empty` block's action instead (§6, E-2).

**L-9 — registry screens (Tax, Shipping): the per-row accordion list is a runtime branch.** A
level renders as a per-row accordion list (§12.3) **only** when both hold for the fetched page:

1. the page is complete — `nextCursor === null`; **and**
2. `items.length <= 25`.

Otherwise it renders `table` + drill-in (blocks 6–7) and moves editing to a detail level. **Both
branches ship**, and the sandbox suite asserts the branch at 25 rows and at 26.

**Every per-row accordion and the create accordion are `default_open: false`** — a level with 25
rows must not open one of them, and D-5's precedence does not apply here (it governs detail
screens). A registry level therefore renders with zero open groups.

**L-9b — zero rows.** The accordion branch has no `table` to carry `empty_text`, so emptiness must
be stated explicitly or the level renders header + context + create accordion and never says it is
empty. **At zero rows an L-9 level omits the row list and renders the `empty` block per E-2, with
its create action in `empty.actions`.** And **every L-9 fallback table sets `empty_text`** (T-7) —
§12.4 currently sets none anywhere.

Why both: `table.next_cursor` + "Load more" (`table.tsx:109-119`) is the **only** paging affordance
in the whole vocabulary. Delete the table and row 26 becomes unreachable. Registry levels
currently read far more than 25 (`tax-page.ts:147` limit 200, `:271` limit 500,
`shipping-page.ts:200,331` limit 200).

**L-9a — exemption: a level whose read returns at most one row keeps its inline form.** Shipping's
rates level is a `(methodId, currency)`-keyed lookup returning 0 or 1 row
(`shipping-page.ts:471` `limit: 1`; the client's `getRate` returns a single nullable row). One
accordion around one row costs a click and saves nothing.

---

## 4. The detail-screen skeleton

```
1  header          <human handle for the record>
2  actions         [← Back to <parent>]
3  banner          (cond) notice from the last action
4  banner          (cond) a state demanding attention (e.g. needs reconciliation)
5  fields          the identity strip — 4 or 6 entries, row-major pairs
6  tab             2–4 panels, block_id stable, default_tab 0
```

**D-1 — what stays outside the tabs.** Blocks 1–5, and only those. The identity strip answers "what
am I looking at and is it healthy" without a click. A state that demands action (block 4) is
**never** allowed inside a panel where a tab can hide it.

**D-1a — the 4-or-6-entry cap governs the identity strip ONLY.** A `fields` block inside a panel or
an accordion has no entry cap; it has an **even** entry count (R-3's row-major pairs) and each entry
must be worth a row. The strip is capped because it is the thing an operator reads without a click,
not because `fields` is expensive. Do not apply block 5's number to a panel's own `fields` — doing so
silently drops data the §11/§12 mapping table promises to preserve, which is exactly what happened to
`Customer` and `Shipping address` in revision 3 (§0.2 E-n).

**D-2 — panel set: task-named, actions beside their data.** Panels are named after the
**operator's task**, never after read-vs-write. There is no "Actions" panel on any screen: an
"Actions" junk drawer separates the refund form from the totals it is computed against, and puts
the routine path (fulfil → mark completed) in the same box as the irreversible one.

| Screen | Panels (constant, in this order) | Labels ≤12 chars |
|---|---|---|
| **Orders** (§11.2) | `Order` · `Fulfilment` · `Money` · `History` | ✓ |
| **Products** (§12.1) | `Product` · `Stock` | ✓ |
| **Coupons** (§12.2) | `Coupon` · `Redemptions` | ✓ |

Tax and Shipping have no detail screen at all — every level is a list (§12.3, §12.4).

**D-2a — two panels are permitted where a third would hold only a `context` line.** Products' and
Coupons' would-be `History` panels contain nothing but created/updated: an operator clicking a tab
to be told nothing is there, on two of three tabbed screens. Those two facts go into the **first
panel's own `fields` block** (`products:more`, `coupons:identity`) — **not** the identity strip,
which §4 caps at 6 entries. D-3's requirement — a *constant* set per screen — is unaffected.

**D-3 — the panel set is constant.** Every panel renders for every record state. A panel with
nothing to do renders one honest `context` line ("Nothing to do here — this order is cancelled and
fully refunded."). Never drop a panel conditionally: with a stable tab `block_id` a shrinking panel
count strands `activeTab` past the end and renders blank (R-14).

**D-4 — `default_tab` is always `0`.** Even when the record needs action; block 4's banner is how
urgency is communicated.

**D-5 — exactly one group is open, and which one is computed, not chosen.** Every named group
inside a panel is an `accordion` (P-2 — there is no other heading available). `default_open` is
decided by this two-rule algorithm, evaluated **once per rendered response**:

**Rule 1 — staged-confirm override.** If this response is a DA-3 state 2 **or a DA-3a / DA-3c
refusal** (DA-3a-i), that one group carries a changed `block_id` **and** `default_open: true` (B-6),
and **every other group on the screen is `default_open: false`**. Rule 2 is not evaluated.

**The refusal case is the one that gets missed.** A refusal re-render that forgets it is a Rule-1
response falls through to Rule 2 and opens whatever the record state suggests — on Orders, `fulfilment`
on a *different tab panel* — while the group whose banner says "re-enter an amount below" stays shut
(§0.2 E-c). Rule 1 is keyed on **"this response carries render state"** — a staged payload or a refusal,
per DA-3a-iii — not on "this response came from `-review`". That is a predicate the render path can read
(`renderState !== undefined`), not an inference about which action fired.

**Rule 2 — otherwise, first match wins.** At most one group gets `default_open: true`:

| # | Group | Condition |
|---|---|---|
| 1 | `reconcile` | the record is flagged for reconciliation and unresolved |
| 2 | `fulfilment` | order state ∈ {`paid`, `processing`} |
| 3 | the screen's **named primary edit group** — Orders: *none* · Products: `Identity` · Coupons: `Discount`. §11/§12 name it; a screen with several edit groups does **not** get to pick. | the record is editable (not tombstoned, not terminal) |
| 4 | — | nothing is open |

Everything else is `default_open: false` — always, including every destructive group and every
group whose body is a table that may be empty. There is no taste in this rule and no per-screen
variation: a reviewer computes the expected group from the record state and checks one boolean.

**D-5 constrains the emitted response, not the viewport.** The algorithm decides the booleans in
*this* response — at most one `default_open: true` — and it cannot close a group an earlier render
already opened: an unchanged `block_id` means no remount, so the mounted accordion never re-reads
`default_open` (B-5, B-6; `accordion.tsx:14`, keyed on `block_id` at `renderer.tsx:78`), and
an operator can therefore see two groups expanded while the response underneath is fully compliant.
**Check the emitted JSON, never the screen:** two expanded groups in a screenshot are B-5 working
exactly as documented and are **not** evidence of a D-5 or X-18 violation.

**A rank the algorithm opens must still render.** Rank 2 fires on a `paid` order, where tracking is
not yet capturable — so `fulfilment` opens with no form in it. **The group still renders, and its body
is one honest DA-7 line naming the operator's real next act:** *"Tracking is recorded once this order
is processing — use 'Mark processing' below first."* This is the pattern, not an exception: where a
rank opens a group whose content does not exist yet, the answer is a line, never a dropped group
(D-3's logic one level down) and never a silent fall-through to the next rank.

D-5 governs **detail screens only.** On a registry level's row list every per-row accordion and
the create accordion are `default_open: false` (L-9), so such a level has **zero** open groups.
On a report/settings screen S-3 names the one open group. A list screen's filter block is always
`false` (L-4). Across all four cases X-18's "at most one per response" holds.

**D-6 — accordion label carries the answer, when the answer is already on the wire.**
`Refunds — $0.00 of $99.00 refunded`, `Notes (0)`, `Saved addresses (2)`,
`Customer — qa-ordc-2@example.com (guest)`. An operator must be able to skip the group from the
label alone.

**D-6a — D-6 binds on destructive groups too, and there it carries the CONSEQUENCE.** A destructive
group is a bare trigger row of exactly the same weight as every other trigger (R-5), so a label that
names only the verb makes the most dangerous control on the panel the quietest thing on it. Required:

| Group | Label |
|---|---|
| Cancel | `Cancel order — permanent, releases held stock` |
| Refund a partial amount | `Refund a different amount — cannot be reversed` |
| Any delete (§12) | `Delete <thing> — permanent` |

**Why this is a rule and not a nicety.** On the built Orders screen the loudest element on the
Fulfilment panel was a red **`Mark refunded`** — bookkeeping whose own confirm text says it *does not
move money* — while the genuinely irreversible cancel was a quiet blue trigger reading `Cancel order`
(§0.2 E-e). §8's preamble names that exact inversion as the thing this document exists to remove;
DA-1 fixes the button and D-6a fixes the label. Both halves are needed.

**D-6b — a degenerate ratio is not an answer; replace it.** When the denominator of a D-6 ratio is
zero, the label must state the fact instead of the arithmetic. `Refunds — $0.00 of $0.00 refunded`
tells an operator nothing and reads like a bug; `Refunds — nothing captured, nothing to refund`
(45 chars) is the answer. The explanatory `context` line inside the group is then **redundant and is
dropped** — it must not restate what the label now says. Same shape for any count ratio:
`Redemptions — none yet`, never `0 of 0 used`.

A count or total is **"available"** only when it is already a field on the wire shape the level
reads, or already in memory from a read the render performs anyway. It is **not** available if
fetching it means a per-row request. Concretely:

- `ShippingZoneWire` is `{id, name, regions}` — **no method count**
  (`admin-rules-client.ts:22-27`). With `limit: 200` a `us — United States · 3 methods` label would
  cost up to 200 extra `ctx.http` round trips per render. The correct label is
  `us — United States`. Adding the count requires a service field first: **file it, never fan out
  per-row reads.**
- `TaxRateWire` carries `zoneId`, not the zone *name* the label shows. The rates level already
  performs **one** `listZones()` per render for exactly this (`tax-page.ts:380`
  `r.zoneName ?? r.zoneId`). That is one extra read, not N, and it is accepted — keep it, and keep
  the `?? zoneId` fallback so a missing zone degrades to the id rather than blank.

X-19 rejects a bare-noun label only where the count *is* available by this definition.

**D-7 — zero-count groups collapse to words.** An accordion whose only content would be an empty
table is not rendered; the fact moves into one `context` line at the parent level, merged with its
siblings where they share a cause: "Guest checkout — no account, no saved addresses, no sign-in
history." replaces three headings and three empty tables.

**D-8 — nesting depth.** `tab > accordion > accordion` is the maximum. No third level.

### 4.1 The report/settings skeleton

Reports and Settings are neither lists nor details — no filter, no table of records to drill into,
no per-record identity. They get their own skeleton.

```
1  header       <Screen name>
2  context      (cond) ≤140 chars
3  banner       (cond) notice, or the fail-closed error banner
4  stats        (reports only) max 4 items, all money formatted        [§12.5]
5..n accordion  one per named group, exactly one with default_open: true
```

**S-1.** No `tab`, no filter block, no drill-in, no `empty`. §3 and §4 do not apply.
**S-2.** Every group is an `accordion`; the `header` appears once (P-2), and the panel-header
exception does not apply here because there are no panels.
**S-3.** Exactly one accordion is `default_open: true`, named explicitly per screen (§12.5, §12.6)
— D-5's precedence table does not apply, because there is no record state to derive it from.
**S-4.** Every form on these screens obeys the change-token rule (B-3, B-3a): its `block_id` comes
from `carriedForm(...)`, so a save re-renders with fresh prefill. This applies to **all four**
Settings forms and is the only reason a saved value redisplays correctly.
**S-5.** A save re-renders the **whole** screen, never a fragment. Every save and every validation
branch returns the full `renderPage(...)` output plus a notice (§12.6). Three current branches
violate this, and the receipt is **terminal** — `SandboxedPluginPage.tsx:46` is an unconditional
`setBlocks(data.blocks)` and its `page_load` effect is keyed on `[sendInteraction, page]`, so
nothing re-fetches and the operator must navigate away to recover:

| Branch | Returns | Consequence |
|---|---|---|
| `save-display` success (`settings-form.ts:149-155`) | `[header, section]` | all four forms vanish; the page is a dead receipt |
| `save-display` invalid name (`:132-144`) | `[header, banner]` | a merchant who types a 201-char name is stranded **with no field to correct it** |
| the other three saves | full `renderPage` | correct — only `save-display` is broken |

**S-5a — this retires a documented invariant, so retire it deliberately.** `renderPage`
(`:252-279`) calls `client.getSettings()` over `ctx.http`, while `:146-147` documents that the
display-name path "provably never touches ctx.http" and
`settings-widget.sandbox.test.ts:48` asserts `stub.requests` is empty. Either (a) re-render without
a fresh GET, keeping the invariant, or (b) drop the invariant and update **both** the comment and
that assertion in the same change. Pick one in the PR; do not leave the comment claiming something
the code stopped doing. Note the existing suite (`:44-53`) drives the broken path and asserts only
that *some* block contains the name — it is **green over the bug**, so the fix needs a new
assertion that the forms are still present.

---

## 5. Tables

**T-1 — column ceiling.** 5 on a list screen, 6 on a detail sub-table. Hard maximum 6. There is no
alignment or width control; wider tables scroll horizontally and stop being scannable.

**T-2 — column order.** Identity first (the thing you searched for), then the columns you scan,
**money last**. There is no right-alignment or column alignment of any kind (R-7), so putting money
in the final column is the only way to get a readable money edge.

**T-3 — `sortable` is forbidden** until the scaffold's `page` action handles `value.sort` and
`ListLevelDef.fetchPage` threads an ordering parameter into the service list ports. Today a sort
click discards the filter and ignores the sort (R-8). When sort lands, `sortable` goes only on
columns the service can order by — never on a derived or formatted column (a formatted money
string, a joined address, a summary sentence).

**T-4 — `format` by column kind.**

| Column kind | `format` | Notes |
|---|---|---|
| Record id, SKU, provider ref | `code` | Monospace chip; keeps UUIDs from reading as prose. |
| Timestamp in a table | `relative_time` | "3 days ago". Absolute UTC belongs in `fields` (§9, M-6). |
| Count, quantity | `number` | `num.toLocaleString()` — locale grouping (`table.tsx:26-29`). |
| Money | *(none — plain text)* | Pre-formatted by `formatMoney` (M-1). **Never** `number`: `9900` would render as `9,900`, which is worse than raw because it looks like a formatted total. |
| Lifecycle state | `badge` | Subject to T-5. |
| Everything else | *(none)* | |

**T-5 — badge discipline.** A badge is reserved for **lifecycle state** — the value an operator
scans a list *for*. Concretely: order status, product active/inactive/archived, timeline event kind,
shipping-method type. Everything else is plain text.

- At most **one** badge column per table.
- Never badge: a property near-constant across rows (`kind: physical` — the column of identical
  black pills in the current products list), a boolean rendered yes/no (`Applies to shipping` —
  use `yes` / `—`), a currency code (delete the column instead, M-2), an id, money, a date, or free
  text.
- Because every badge renders identically (R-6), a column whose values never differ is pure
  decoration. If you cannot name two values an operator would want to tell apart at a glance, it is
  not a badge.

**`refund kind` is struck from the whitelist, and the near-constant clause is why.** Revision 3
listed it as a lifecycle badge while the third bullet above forbade it — a contradiction inside one
rule, which §11.2 then mandated (§0.2 E-m). It resolves against the badge, decisively:
`kind` is `gateway.refundable ? "gateway" : "manual"`
(`domain/src/orders/refund-order.ts:211`), and the gateway is resolved once from the **order's own**
`paymentMethod` (`service/src/routes/admin.ts:742`), so within any single order's ledger the value
**cannot vary** — and the per-order ledger is the only table in the whole console that renders it. The
whitelist entry was therefore never valid anywhere it applied. `Kind` is deleted from the refunds
table, not demoted to plain text: a constant column of the word `manual` is a column of nothing. If a
refund's kind ever needs stating, it belongs in the group's capability `context` line, which already
explains whether refunds here move money.

**T-6 — `page_action_id` is always set** — the authoritative type requires it (R-21) — even on a
table that can never page. Keep the `// never fires: no next_cursor, no sortable column` comment
convention so the intent is readable. `next_cursor` is set only when a next page exists, and never
in a leaf detail (T-8).

**T-7 — every table sets `empty_text`** (R-9), subject to §6.

**T-8 — a table inside a leaf detail MUST NOT set `next_cursor`.** The order detail has seven
sub-tables sharing `page_action_id: orders:page`. A load-more click sends
`{cursor: <that table's cursor>}` into the scaffold's `page` branch, which either fails
`decodeListCursor` and bounces the operator to the unfiltered root list
(`list-detail.ts:290-293`) or reaches `renderList` at a **leaf** depth where `listLevelAt` returns
`undefined` and the response is `{blocks: []}` — a blank page
(`list-detail.ts:198-201,209-210`). Both outcomes are unacceptable. Instead: **cap the read** and
state the cap in one `context` line — `Showing the 20 most recent notes; older notes are not listed.`

**T-8a — the cap line is emitted only when the read was actually truncated.** The cap is real either
way; the *sentence* is only true news when rows were withheld. "Showing the 50 most recent events" on
a 4-event order is noise on the one screen this document is trying to make quieter. Condition it on
`fetched.length > shown.length`, and say that rows are missing — a bare "showing the 20 most recent"
does not tell an operator whether there is a 21st.

---

## 6. Empty and degraded states

**E-1 — choose by role, not by taste.**

| Situation | Treatment |
|---|---|
| A table is the primary content of its container and emptiness is a normal successful read | `table.empty_text` — one centered muted line, no chrome (R-9). **The default.** |
| The screen's **primary** collection is empty *and unfiltered* | One `empty` block, `size: "base"` — the `table` is **omitted** and `empty` renders in its place. Once per screen, maximum (E-2). |
| A **secondary** collection is empty and its container exists only to hold it | Render nothing; fold the fact into a parent `context` line (D-7). |
| A **secondary** read failed | `context` line in place of the section's body. Never a banner, never fail the whole screen. |
| The **primary** read failed | Fail closed via `failClosedResponse` — `header` + one `error` banner, nothing else. Its copy obeys **E-7**. |

**E-2 — `empty` is earned by a primary collection's true zero state, with or without a create
action.** It is a large centered illustration; it is never used for a filtered-to-zero list (the
operator's next act is *changing the filter*, and the filter is right there — use `empty_text`:
"No orders match these filters.").

- **With** a create action on the screen: the action goes in `empty.actions` as a `button` whose
  handler re-renders the list with the create group forced open (B-6: changed `block_id` **and**
  `default_open: true`). Title + description + one button.
- **Without** one (Orders — orders are not created in the admin; Products — they originate in the
  CMS): title + description only. `empty.actions` is omitted, not an empty array.

**E-3 — preserve the successful-empty / failed-read distinction.** These two must never share
phrasing; the existing pages get this right and it must survive re-layout.

| Kind | Shape | Example |
|---|---|---|
| Successful and empty | State the fact. Add the *reason* when the reason is structural. | `No refunds recorded.` · `No sessions (guests never sign in).` |
| Read failed | Name what failed · say what is unaffected · give the one next step. | `Timeline unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.` |

**E-4 — copy voice.** Sentence case, full stop, no exclamation. No "sorry"/"oops"/"whoops", no
"unfortunately", no "we". Never echo an HTTP status, URL, exception message, or internal field
name. Say what is true and what to do.

**E-5 — degraded copy budget.** One `context` line (200 chars). The current "unavailable" lines are
correct in substance and already close to budget; keep them, don't grow them.

**E-6 — every interaction returns HTTP 200; failure is a banner inside the blocks.** A non-2xx
response, or a handler that throws, replaces the entire block tree with
`Plugin responded with ${status}: ${text}` and resets every accordion and tab (R-24). So:

- Every admin route handler catches everything and returns `{blocks: [...]}` with an `error`
  banner. There is no code path that returns a non-2xx or lets an exception escape.
- E-4's ban on echoing status/URL/exception text is only enforceable because of this rule. State
  both together or a team will assume the host formats errors safely.
- B-5's "an open group stays open across a round trip" holds **only for a failed submit that still
  returns 200**.

**E-7 — a fail-closed banner must not assert a cause it does not know.** E-6 makes the fail-closed
path swallow *everything* — an unreachable service, a 401, a malformed response, and **a bug in the
console's own code**. A banner reading *"Could not reach the commerce service"* is therefore false
whenever a console defect lands on the same path, and its cost is not cosmetic: it tells the operator
the network is down and sends whoever they page to the wrong team. A `carriedForm` digest throw is
exactly such a defect, and it surfaces here (§0.2 E-h).

So the copy names the **symptom**, lists the two things the operator can check, and then says the
remaining possibility out loud. Normative, ≤240 — **this blockquote is the spec** and the code is
trimmed to it:

> `<Screen> could not be loaded. Check the service connection and the admin token in Settings; if
> both look right, this is a fault in the console itself — not your data.`

(164 chars at `Orders`.) Title: `<Screen> are unavailable` / `<Screen> is unavailable`. The last clause
is the load-bearing one — it is the only thing that stops a console bug from being reported as an
outage, and it costs 62 characters. **Applies to every screen's fail-closed banner**, and to any
`context` line standing in for a failed secondary read where the cause is equally unknown (E-3's
"read failed" row already gets this right by naming only what failed).

---

## 7. Forms

**F-1 — field order, always.**

1. What is being changed (the substantive input).
2. Optional detail / qualifier.
3. Attribution ("Recorded by").

Identity fields do not appear at all — they ride in `block_id` (§10). This is the inversion of the
current forms, which lead with three lines of plumbing.

**F-2 — never rendered, ever.** These must not appear as a form field, under any label:

- record ids (`orderId`, `classId`, `zoneId`, `methodId`, `rateId`, `productId`, `couponId`);
- CAS watermarks (`expectedUpdatedAt`, `expectedRateBps`, `expectedAmountCents`, `expectedFlag`);
- drill-path carriers (`__path`, currently labeled "Scope");
- a currency the form cannot change;
- **an idempotency key or nonce, in any form.**

All of the first four move into `block_id` as carrier payload (§10). The last one **does not move —
it is deleted.** See F-2a.

**F-2a — idempotency keys are derived, never carried and never minted per render.** Every admin
write derives its key **deterministically from the content of the write, with the observed
watermark as a key component**. No `crypto.randomUUID()` is minted at render time, put in a
`block_id`, put in a `button.value`, or exposed as a field.

| Write | Key |
|---|---|
| Refund | `admin-refund:${orderId}:${amountCents}:${refundedSoFarCents}` — the third component is the watermark the operator *saw* |
| Stock movement | `${productId}:${direction}:${onHandAtRender}:${qty}` |
| Transition | `admin-transition:${orderId}:${toState}` |
| Cancel | `admin-cancel:${orderId}` |
| Note | `admin-note:${orderId}:${author}:${body}` |
| Edit / save (sparse PATCH) | content hash of the submitted wire + `expectedUpdatedAt` (`deriveEditIdempotencyKey` — already correct) |

Why the watermark is the crux — it delivers all three properties at once:

- identical intent ⇒ identical key ⇒ replay dedupes (double-click protection);
- different amount ⇒ different key ⇒ applies;
- **two deliberate identical refunds** — $10 for shipping, later $10 for damage on one order ⇒
  different `refundedSoFarCents` ⇒ different keys ⇒ **both apply.** That case was the only argument
  for a random nonce, and the watermark supplies it deterministically. It also doubles as the
  change token B-3 requires, so one value serves both jobs.

Why a render-time nonce is not defensible: `packages/domain/src/orders/refund-order.ts:192-201`
resolves `getRefundByIdempotencyKey(cmd.idempotencyKey)` and, on `status === "recorded"`, returns
`{ok:true, duplicate:true, refund: existing}` — **keyed on the key alone, with no comparison
against `cmd.amount`**. `orders-page.ts:1535-1542` then renders "Already refunded — a duplicate
submission". So the same key with a *different* amount produces a success banner for an amount
never applied. Reachable today. And the carrier's change-token doctrine makes a form's React key
deterministic and stable, removing the accidental index-shift remount that currently refreshes the
nonce some of the time — a nonce in the carrier turns an intermittent bug into a reliable one.

The current code violates this at `orders-page.ts:1162`
(`idCarrier("nonce", crypto.randomUUID())`) and `:1526` (`admin-refund:${orderId}:${nonce}`), and
at `products-page.ts:433-445,974-984` (restock / remove-stock). All are deleted, not relocated.
This also makes the document self-consistent: §2 already lists nonce fields under `form` →
forbidden, and F-2 already says a key is never something a human can see, pick or alter — a
render-time carried nonce satisfies neither half.

**F-3 — no single-option `select`, anywhere.** A dropdown with one option is not a control; it is a
leaked variable. Zero instances may remain after the carrier increment. Where the single option
encodes a real constraint (products' `inventoryPolicy: deny`), the field is **deleted** and the
constraint becomes one `context` line.

**F-4 — labels.** Sentence case, no trailing colon, ≤40 chars, no camelCase, no API names. The unit
or format goes in the label parenthetical (`Refund amount (USD)`, `Rate (%)`), not in a separate
`context` line. Optional fields are suffixed `(optional)`; required fields are **not** marked (most
are).

**F-5 — ≤6 visible fields per form**, with two escapes and one exemption: split it (F-5a, only on a
verified sparse PATCH), gate it with `condition` (F-5b), or invoke F-5c (full-replace forms, cap 8,
one named instance). Counted after F-2/F-2a deletions, and before any
`condition`-hidden field is evaluated.

**F-5a — splitting into sibling forms is permitted ONLY where the update path is a verified sparse
PATCH.** A record needing more than 6 fields *may* be split into sibling forms, each in its own
accordion, each with its own submit and its own `carriedForm` `block_id` (including
`expectedUpdatedAt`) — **but only when omitting a key provably preserves it end to end.**

**Verify the whole path, not just the plugin.** For products it holds and preservation is designed:
`buildEditWire` assigns conditionally only (`products-page.ts:753-842`, with the
`// field not in the form ⇒ preserve` comment at `:790`), every wire field is `.optional()`
(`service/src/schemas.ts:387-425`), the route spreads `...(body.x !== undefined ? {x} : {})`
(`service/src/routes/admin.ts:302-337`), the use case guards on `!== undefined`
(`domain/src/product-commerce/use-cases.ts:108-149`), and the store emits a sparse `SET`
(`kysely-product-commerce-store.ts:328-353`). Blank-clears exist deliberately where wanted
(`compareAt`/`unitCost`/`taxClass` → `null`).

**The coupon update is a `PUT` whose service handler coerces absent to `null`
(`rules-admin.ts:434-443`), so the coupon edit form is NOT split — it uses `condition` per F-5b
instead.** `updateCoupon` sends `PUT` (`admin-rules-client.ts:493-496`) and `saveCouponAction`
deliberately sends every editable key, with the comment "Never rely on the wire's omit⇒null
coercion" (`coupons-page.ts:833-841`). Splitting it would mean an operator saving a "Discount" form
**silently wipes `startsAt`, `expiresAt`, `maxUses` and `maxUsesPerCustomer`** — a capped, expiring
coupon becomes unlimited and never-expiring. The screen even announces the semantics: "Every field
was replaced with the submitted values (last write wins)" (`coupons-page.ts:858`).

**The trade-off to accept where splitting *is* legal.** Saving form A reloads the record, which
changes `updatedAt`, which changes forms B and C's carriers, which remounts them — **discarding any
unsubmitted input in the siblings.** This is the same hazard `filterRow()` was withdrawn for
(§0.1 A). State it in the PR; do not discover it in review.

**F-5a-i — a split form set carries one `context` line naming the discard.** Revision 4 accepted the
hazard on the grounds that each split form sits in its own **collapsed** accordion (D-5), "so
realistically one is open at a time." **That reasoning does not hold and is withdrawn.** D-5
constrains the emitted response, not the viewport: accordion open state is client-side and
**sticky** across a re-render with an unchanged `block_id` (B-5, and D-5's "constrains the emitted
response" paragraph), so a sibling the operator expanded earlier is **still expanded** when saving
form A remounts it, and the `default_open: false` in the new response will not close it. The discard is
reachable the first ordinary time an operator works in two sections — not in a corner case. It was
also never checkable: an implementer cannot build "realistically" and a reviewer cannot rule
pass/fail on it.

So the operator is told instead. **One `context` line sits above the split groups**, at the panel
level — one line for the whole set, never one per form. Normative, ≤200 — this blockquote is the
spec:

> `Each section saves on its own. Save the section you are editing before you open another — saving
> one reloads the product and clears unsaved edits in the others.`

Written to DA-7a's discipline — it starts from the operator's goal, ends at the act, and contains no
"deliberately" / "there is no" / "we do not" (X-41 binds on every `context` line, not only
withheld-action ones). It is **not** a DA-7 line: DA-7 covers a *withheld control*, and here every
control renders. A screen whose split noun is not "product" substitutes its own noun; nothing else
varies. X-45 rejects the missing line and the per-form repeat.

The exact split per screen is enumerated in §12 — teams do not choose it. **Products' three-way edit
split (§12.1) is the only instance today, and §12.1 is built last** — so F-5a-i is written here
rather than left to be rediscovered.

**F-5c — a full-replace form is exempt from F-5, up to 8 visible fields.** Where F-5a forbids
splitting, the budget cannot be met by splitting and dropping a field is data loss, so the form is
allowed to exceed 6. Cap 8. **Exactly one instance: the coupon edit form**, which is 6 visible
fields for a `fixed_amount` coupon and **7** for a `percentage` one (`amount` **or**
`ratePercent` + `cap`, plus `minSubtotal`, `startsAt`, `expiresAt`, `maxUses`,
`maxUsesPerCustomer` — `coupons-page.ts:502-572`). No other form may invoke F-5c; a second
candidate is a signal that the update path should become a sparse PATCH.

**F-5b — a create form may exceed 6 authored fields only if `condition` keeps ≤6 visible at once.**
A create needs every required field in one submit and cannot be split. Use `condition` (R-23) to
hide the fields that do not apply to the currently-selected kind. The **discriminating field must
declare an `initial_value`**, or `values` has no entry for it at mount and every conditional field
evaluates against `undefined` (R-12b). Do **not** use `condition` to smuggle a hidden field (R-26).

**F-6 — control choice.**

| Data | Element | Why |
|---|---|---|
| Money | `text_input`, parsed to integer minor units | `number_input` yields a JS `number` — a float money path, forbidden by the project's money rule. |
| Percent / basis points | `text_input` (`7.25`), parsed to bps | Same reason. |
| Non-money integer (minutes, thresholds, quantities, dimensions) | `text_input`, parsed with `/^\d+$/` | One parsing discipline for every numeric field beats two. `number_input` is not *forbidden* here — it is simply unused, and the two current uses (Settings' TTL and threshold) migrate for consistency, not to fix a bug. |
| Boolean | `toggle` | Replaces the current two-option `yes/no` selects. Emits a **real boolean**, and `readString` (`scaffold/list-detail.ts:334`) is `typeof value === "string" ? value : undefined` — so every current parser returns `undefined` for a toggle and the field **appears to save and never persists.** Add `readBoolean` to the scaffold and migrate the call sites in the same change. Subject to F-6b. |
| Closed set, ≤8 options, **every value readable as a word** | `select` | The trigger shows the **value**, not the label (R-17a) — so this row requires F-6c. |
| **A record picker** — the option value is an opaque id (L-7) | `combobox`, **at any count** | A `select` would put the id in the trigger (R-17a), which F-6c forbids; a `combobox` renders the **label** (R-17b). A picker never prefills, so R-12a does not bite. |
| Closed set, >8 options, **and the field never prefills** | `combobox` | Searchable, and it renders the label. Only safe unprefilled (R-12a). |
| Closed set, >8 options, **prefilling** | `select` | A long dropdown beats a control that shows one value and submits another. Its values must still pass F-6c. |
| Date | `date_input` | Yields `YYYY-MM-DD`; normalize server-side. |
| Secret | `secret_input` with `has_value` | Never echo the stored value. |
| Free text over one line | `text_input` with `multiline: true` | |

**F-6a — a `select`, `radio` or `combobox` must never render blank.** `SelectElement` has no
`placeholder` (R-17), so an unresolved value renders an empty 36px trigger — the most
broken-looking element on the current screens (four instances across the two review screenshots).
Two rules, both mechanically checkable:

1. **Every** `select`/`radio`/`combobox` declares an `initial_value`, and that value is present in
   `options`.
2. **No option may use `""` as its value.** Use a real sentinel: `"any"` for a filter's all-values
   option, `"none"` for an unselected picker or a cleared reference. The handler maps the sentinel
   back to "unset".

**Rule 1 is the load-bearing one, and `""` is not the cause** — it is merely the value most often
chosen. The cause is R-17a: the trigger renders the raw resolved value, and renders nothing when
that value is `""`, `null` or absent. The decisive counterexample against blaming `""`: the
"Open order" select (`orders-page.ts:243-248`) has **no `""` option and no `initial_value`** and is
also blank. Rule 2 exists because `""` is the one value that is *always* blank, and because it also
trips `hasSelectedValue`; a non-empty `initial_value` alone fixes the blank even if a `""` option
stays.

Exhaustive `""`-valued-option inventory over `packages/plugin/src`: `orders-page.ts:203`,
`products-page.ts:183, 241, 247, 521`. **Coupons, tax, shipping and settings contain none.** (The
Pricing Status/Kind selects are `products-page.ts:256-268`.)

**F-6a — verification.** Any increment touching a `select`, `radio` or `combobox` attaches a
screenshot showing the trigger is **non-empty**, and states in the PR what it reads. What to expect
differs by control, and revisions 1–3 got this wrong:

| Control | The trigger reads | Verified instances |
|---|---|---|
| `select` | the raw **value** (R-17a) | Orders status filter reads `any`; the cancellation reason reads `customer_request`; coupons' type reads `fixed_amount` (`coupons-page.ts:332-336`); the tax-class select reads a bare class id (`products-page.ts:596-601`) |
| `combobox` | the option **label** (R-17b) | the Orders picker reads `Choose an order…` closed, and `maya.iyer@example.com · $95.00 · processing` selected |

So a screenshot criterion asking for a "resolved label" is **unsatisfiable on a `select`** and must
not be written — but it is exactly right on a `combobox`, and a `combobox` screenshot that shows an
id is a **fail**. Revisions 1–3 named "the order picker reads a raw UUID" as the worst instance on
these screens; **that wart never existed** — the picker is a `combobox`.

**F-6c — a `select`'s or `radio`'s option value is operator-visible, so it must read acceptably as
text.** This follows from R-17a and is a **new constraint on M-7/X-22**: on those two controls "the
label never contains the id" is necessary but not sufficient, because the *value* is what the trigger
shows. So sentinels are words (`any`, `none`), never `""` or `0`.

**F-6c does not bind on `combobox`** (R-17b — it renders the label), and that is what makes L-7's
"always `combobox` for a record picker" buildable. Where a value can only be an opaque id, the control
is a `combobox` or it is not a dropdown at all: prefer the row-action drill-in when it lands (§14
item 2).

The worst *live* instance is now the cancellation-reason `select`, whose trigger reads
`customer_request`. That is inside F-6c's tolerance — a word, readable, unambiguous — which is the
whole point of the constraint. **Revisions 1–3 named the order picker's "raw UUID" here; it was never
real** (§0.2 E-a). The genuine X-22 defect in the current code is the picker's *label*
(`${o.id} — ${o.state}`), and that is fixed by L-7, not by a fork change.

**F-6b — every `toggle` declares an explicit `initial_value`.** `toggle` is **mount-only** (R-12),
so a team assuming it refreshes from the server after a write is wrong; and an untouched toggle
with no `initial_value` is **absent from `values`** (R-12b), so a handler doing `Boolean(values.x)`
silently writes `false`. A form containing a toggle obeys the change-token rule (B-3, B-3a) like
any other prefilling form.

**F-7 — submit label names the result**: `Apply filters`, `Add note`, `Record fulfilment & ship`,
`Save rate`, `Review refund`. Never `Submit`/`Save`/`OK` alone, and never an id (`Save std-us` →
`Save rate`, with the id in the enclosing accordion label; M-7).

**F-8 — the explanation that used to be a paragraph.** One `context` line above the form, inside
the same accordion, ≤200 chars, describing only what the operator cannot infer from the labels
("Saving replaces every field below — a blank optional field saves as unset."). The rest of today's
paragraph is deleted, not relocated.

---

## 8. Destructive actions

One rule, applied identically on all seven screens.

> **DA-1.** An irreversible write is triggered **only** by a `button` carrying a `confirm` dialog with
> `style:"danger"`. A `form` may collect its inputs; a form submit may never be the trigger. The
> button itself is `style:"danger"` too — **except** under DA-2c's fan-out cap, which is the one place
> the red moves from the button into the dialog.

This resolves R-10 (forms cannot confirm) and removes the current inversion where "Mark refunded"
is red-with-confirm while "Cancel order (cannot be undone)" is a plain submit.

**The inversion has two halves and DA-1 only fixes one.** The built Orders screen satisfied DA-1
exactly and *still* shipped the inversion, because the red lives on the `Mark refunded` **button**
while the irreversible cancel is reached through an **accordion label** — and a label cannot be red
(R-5). So DA-1 is paired with **D-6a**: a destructive group's label carries its consequence. A PR that
passes DA-1 and leaves a bare `Cancel order` trigger next to a red bookkeeping button has not done
this section (§0.2 E-e).

Note R-22: a `button` *can* sit inside a `form`'s field list, and it renders — but it fires a bare
`block_action` with only `element.value`, with no access to that form's typed `values` and no
`block_id`. It is not a way around DA-1.

Three shapes, chosen by what input the act needs. **The choice is not a judgment call:**

| Input the act needs | Shape |
|---|---|
| none | **DA-2** |
| one value from a closed set, or one value the screen already knows | **DA-2b** |
| free text, or an operator-typed amount | **DA-3** |

**DA-2 — no inputs needed.** One `actions` block containing the danger button.

```
actions [ button{ style:"danger", value: <carrier payload>,
                  confirm:{title, text, confirm, deny, style:"danger"} } ]
```

Used for: every delete (coupon, tax class, tax rate, zone, method, shipping rate) and the
irreversible status moves.

**DA-2b — closed-set or already-known input: one button per value, no staging.** Render one danger
button per legal value, the value in `button.value`, and **name it in the confirm text**. No round
trip, no staleness window, no staged payload to decode.

- **Cancel order.** The reason is a closed set (`orders-page.ts:644` — the timeline's `cancellation`
  kinds). One danger button per reason, the reason **named in the confirm text**:
  *"Cancel this order as 'out of stock'? This is permanent and releases the held stock."*
  **Four buttons, not five:** `other` gets no button, because a bare `Other` button records no detail
  and a label promising detail (`Other (add detail below)`) promises a field the button does not have
  and points at a group that may be collapsed. `other` lives in the DA-3 note form's select, which is
  the only path that records detail. Button labels are the **bare reason** — `Out of stock`, not
  `Cancel — Out of stock`; the group label and the confirm already say "cancel" twice.
  Keep a DA-3 flow **only** when the operator typed optional free-text detail.
- **Refund the full remaining balance.** The refund form already defaults to full remaining
  (`orders-page.ts:1167`), which is the majority path. Offer one danger button
  `Refund $99.00 (full remaining)` whose `value` carries
  `{orderId, amountCents, refundedSoFarCents}` — the amount **and the observed watermark**. Keep
  DA-3 only for a partial amount.
- **A status move (DA-6)** carries `{orderId, toState, state}` — `state` being the order state the
  operator saw. See DA-2a.

**DA-2a — DA-2b carries a watermark and re-reads, exactly like DA-3.** DA-2b has no *staging* window,
which is why revision 3 left it out; but a **rendered button ages** — an operator can sit on a detail
page for ten minutes while someone else moves the order. So every DA-2b button's `value` carries the
watermark the operator saw, and its handler runs DA-3a's re-read-and-compare before writing. The cost
is one request; the alternative is one class of write with no staleness check at all.

This is why revision 3's §11.2 transition listing (`value {orderId, toState}`) was a defect: it made
**status moves the only destructive write on the console exempt from DA-3a** (§0.2 E-l). Transitions
are also the write most likely to race, because the state an operator is moving *from* is the thing
another operator is most likely to have changed.

**DA-2c — fan-out cap: above 4 values, the buttons go quiet and the dialog stays loud.** One danger
button per value is right at two or three. **This cap is about emphasis, not space** — `actions`
lays its elements out in a **single horizontal flex row** with intrinsically-sized buttons
(`actions.tsx:12`, `flex flex-wrap gap-2`), so five reason buttons are one wrapping row, not a
vertical wall, and invoking DA-2c buys **no height back and no scroll**. What it buys is the
emphasis: at five, a row of same-weight destructive controls becomes the loudest thing on a panel
whose likeliest next act is a small quiet `Mark paid`, and every button competes with every other
for the alarm that should belong to the act (§0.2 E-f) — the emphasis inversion §8 exists to remove.
So:

| Values | Buttons | Dialog |
|---|---|---|
| ≤4 | `style:"danger"` | `confirm{ style:"danger" }` |
| **≥5** | `style` **omitted** (default `secondary`) | `confirm{ style:"danger" }` — unchanged |

The `confirm` is **never** optional and never loses its `style:"danger"` — the guard is the dialog,
not the colour, and DA-1 is satisfied either way. Above 4 the group's own D-6a label
(`Cancel order — permanent, releases held stock`) carries the warning the colour was carrying, which
is a better place for it: one line of red-adjacent text instead of a row of interchangeable red
buttons.

**Before invoking DA-2c, check the enum is really that wide.** Orders' five cancellation reasons drop
to **four** once `Other` goes (§11.2 — `Other` promised a detail field the button could not provide),
and four is inside the cap. A 9-value enum is a genuine DA-2c case; a 5-value enum is usually a
listing that has not been pruned.

**DA-3 — free text or a typed amount: stage, then confirm. Two action ids.**
`<entity>:<verb>-review` and `<entity>:<verb>`. There is **no** `-edit` id.

```
state 1 (collect)   accordion "<Verb> …"  block_id <stable>            default_open false
                      banner{variant:"alert"}  what this does, why it is irreversible
                      form   inputs, submit label "Review <verb>"      → <verb>-review

state 2 (confirm)   accordion "<Verb> …"  block_id <changed>           default_open TRUE
                      form   THE SAME FORM, remounted, staged values as initial_value
                      actions [ button{ style:"danger", value:<staged payload>, confirm } → <verb> ]
```

**Which accordion is "the" accordion, when state 1 is nested.** A DA-3 collect form usually sits in a
sub-group inside a larger one — `Refund a different amount` inside `Refunds`, `Cancel with a note`
inside `Cancel order`. Revision 3's listing put the `:review` suffix on the **inner** group. **This
rule is about the response putting the confirm button on screen by itself.** Suffix the inner group
and D-5 Rule 1 forces the parent `default_open: false`, so whether the confirm is visible turns on
client state the response did not set: the operator opened the parent to click "Review refund", the
parent's `block_id` is unchanged, so it stays open (B-5, and D-5's "constrains the emitted response"
paragraph — `accordion.tsx:14` reads `default_open` once, at mount, R-14a). So on the happy path the
confirm **is** visible, and the reason revision 4 gave — "it is invisible" — is checkably false. The
rule stands on the stronger ground:

- **Visibility that depends on the operator's click history is not correctness.** The response
  asserts `default_open: false` on the group the confirm is inside and gets a visible confirm
  anyway, purely because of what the operator did earlier. Nothing in the response expresses the
  condition it is relying on.
- **It is not verifiable, at any V-4 tier.** A tier-1 assertion can check that a state-2 response
  carries a forced-open group whose body holds the confirm; it cannot check "some earlier render
  left the parent expanded". A rule whose correctness no test can express fails this document's bar.
- **The platform discards open state on events the console plans for.** **R-24** unmounts the entire
  block tree on any non-2xx and returns every group to its `default_open` — which is precisely why
  E-6 requires every handler to return 200. Open state is not a guarantee this console owns.

Forcing both groups open instead breaks X-18 (§0.2 E-b). The resolution, and it is a rule because
six screens will hit it:

> **The `:review` id and `default_open: true` go on the OUTERMOST group on the open path**, and its
> body on a state-2 render is the staged form plus the confirm button **directly**. The inner
> collect-group is **not rendered at all** in state 2. One changed id, one flag, confirm on screen.

So `orders:<id>:refunds:review` (not `…:refunds:refund-partial:review`), and the state-2 body of
`Refunds` is `banner` + staged form + confirm — the ledger, the meter and the full-remaining DA-2b
button are all suppressed, because the operator is mid-decision on one amount and a second refund
control beside it is a trap.

- **Both halves of the force-open are required** (R-14a, B-6): a changed `block_id` remounts the
  group, and the remount re-reads `default_open`, which is `false` for a destructive group unless
  this render sets it `true`. Change the id without setting the flag and the accordion **snaps
  shut** on the operator the moment they click "Review refund", hiding the confirm button.
- **"Change details" is not an action.** The operator edits the visible, remounted form and
  re-submits `-review`. This deletes the hand-maintained `fields` echo, which was a second
  rendering of the payload and a place for the dialog and the payload to disagree.
- The staged payload rides in `button.value` (arbitrary JSON, echoed back verbatim) and **must**
  include the watermark the operator saw: `refundedSoFarCents` for a refund, `state` for a cancel,
  `onHand` for a stock removal.
- The `confirm.text` names the concrete values (≤200 chars, §1 budget): *"Refund $99.00 to
  qa-ordc-2@example.com? This records a refund made out of band — it does not move money."* A
  generic dialog does not earn the extra round trip.
- **Confirm and deny labels are verb phrases naming the outcome** — `Yes, refund $99.00` /
  `Keep as is`. Never `OK`/`Cancel`.

Used for: refund of a partial amount, cancel-with-free-text-detail, remove stock.

**DA-3c — a `-review` handler bound-checks against the live record. Not only the confirm handler.**
`-review` writes nothing, which is why revision 3 said nothing about it — but it *renders the two
statements the whole shape exists to make true*: the button label and the `confirm.text`. So it
validates every constraint the write will apply, not just parseability:

| Check | Refusal names |
|---|---|
| parses to a positive integer of minor units | what was typed |
| **≤ the live ceiling** (`amountCents <= remainingRefundableCents`; `qty <= onHand` for a stock removal) | **the real figure** |
| required attribution present | the missing field |

Without the second row, `900.00` on a $50 order stages a red **`Refund $900.00`** and a dialog reading
*"Refund $900.00 to …?"* — both false at the moment they are shown, on the one step that exists to let
an operator check exactly that (§0.2 E-d). An extra zero is the likeliest typo on a money field, and
the ceiling is already in the carried context: this is a comparison, not a fetch.

The refusal is a state-1 re-render per DA-3a's shape, with copy naming the real ceiling:
*"$900.00 is more than the $50.00 that remains refundable on this order. Enter $50.00 or less."*
(92 chars.) **DA-3c does not replace DA-3a** — `-review` bound-checks what it renders; the confirm
handler re-reads and compares watermarks. Different failures, both required.

**DA-3a — every confirm handler re-reads before writing. Mandatory, no exceptions.** The handler
takes the watermark out of the staged payload, **re-reads the record**, and compares:

- **Match** ⇒ derive the key per F-2a and write.
- **Differ** ⇒ **apply nothing**, and re-render per DA-3a-i below with an `error` notice naming
  **both** figures **and the cause**:
  *"$20.00 was staged and was not recorded — someone else refunded this order since you started.
  $40.00 now remains refundable; re-enter an amount below to try again."* (162 chars ≤240.)

**The causal clause is not optional.** "The ledger changed" states an effect and leaves the operator
to guess whether they hit a bug; "someone else refunded this order since you started" is the fact, it
is what stops them retrying identically, and at 76 characters it is nowhere near the 240 budget. E-4
says say what is true — this is the case E-4 was written for.

The bug this closes: refunds are additive with no CAS (`orders-page.ts:1523-1530`) and the form
defaults to full remaining. Operator A stages $99.00; operator B refunds $99.00; operator A's
dialog still says "Refund $99.00 to …" — a false statement — and posts it. F-2a's watermarked key
prevents the *silent swallow*; DA-3a prevents *acting on a stale amount*. Both are required, and
they compose: DA-3a rejects the stale submit before the key is ever derived.

**DA-3a-i — every refusal re-renders STATE 1 OF THE SAME GROUP, forced open, with the submitted values
prefilled.** Binds on **both** refusal kinds — DA-3a's stale watermark and DA-3c's failed bound check.
All four clauses, or the refusal is worse than the race it caught:

| Clause | Why |
|---|---|
| **the same group** | D-5's open-group algorithm has no idea a refusal happened. Re-render without render state and it falls through to rank 2, opening `fulfilment` — on Orders, a **different tab panel** — while the group the banner points at stays collapsed (§0.2 E-c). The render state the action passes is what tells the level a refusal happened (DA-3a-iii). |
| **forced open** | B-6, both halves: a changed `block_id` **and** `default_open: true`. A banner reading *"re-enter an amount below"* above a closed accordion is not an instruction. |
| **values prefilled** | The operator typed an amount, an optional reason and their name. Discarding all three to tell them to try again makes the safe path the expensive one, and the next thing they reach for is the DA-2b full-remaining button — which is not what they wanted. |
| **flattened onto that group** | The forced-open group is the **outermost group on the open path** (B-6, DA-3's outermost-group rule), so the refusal's body renders the collect form **directly** in it and the inner collect-group is **not rendered at all** — exactly as state 2 is flattened. Force the outer group open and leave the form inside a nested `default_open: false` child and the operator's rejected input is on the page but invisible, which is the "values prefilled" clause failing while passing an id check. |

D-5 Rule 1 covers this: a DA-3a refusal **is** a state-2-shaped response for open-group purposes — one
group forced open, every other `false`, X-18 satisfied. Say so in the render path; do not let the
refusal fall into Rule 2.

**"State-2-shaped" scopes to which group is open, and to nothing else.** It settles `default_open` and
the `block_id`; it licenses **nothing** about the body. A refusal's body is **state 1** — its alert
banner, the collect form, the `Review …` submit — and it carries **no confirm control**, because the
payload a confirm would carry is the payload just refused. Re-offering it re-stages a stale amount
(DA-3a) or the very figure the bound check rejected (DA-3c) — a red `Refund $900.00` on a $50 order,
§0.2 E-d walking back in.

**DA-3a-ii — a staged or refused re-render costs the leaf's normal read set. Priced, not avoided.**
`showLeaf`/`showList` carry render state (DA-3a-iii), so a `-review`, a DA-3c refusal and a DA-3a
refusal all re-render **through the level's own `render`**: the reads are the level's, they happen
once per response, and the screen writes **no second read-and-render path**. On Orders that is
**five requests** — `getOrder` plus the four detail surfaces — per click, not the one the reference PR
estimated. Nothing about the channel reduces that number; what it removes is a duplicate
implementation of the read-and-render pair that drifts from the level's and re-reads a second time on
its own fallback paths (§0.2 E-s).

The channel deliberately carries **state, not data**: the engine still calls the level's `load`,
because a refusal's whole point is that the action's copy of the record is stale by construction.

So price it before you copy the pattern onto a read-heavy leaf: **count your surfaces first.** If the
number is uncomfortable, the fix is a narrower re-read for the staged path — **a level may branch its
own secondary reads on `renderState`** and skip a surface this render genuinely does not draw. Two
limits on that, both checkable: **D-3 still binds**, so a panel whose surface you skipped must still
render its honest line — a skip that blanks a panel is a defect, not an optimisation; and a refusal's
copy must name the **live** ceiling (DA-3a, DA-3c), so whichever surface supplies that figure is never
the one to skip. On Orders those two leave nothing safely skippable — every one of the four surfaces
feeds a panel D-3 keeps rendering, and one of them carries the ceiling the refusal copy must name — so
five requests is the priced answer there, not a tuning target. The primary `load` is not branchable and
is not meant to be: it receives no render state, and it *is* the re-read DA-3a depends on. What is never
the fix: a client-side stash, or a nonce (F-2a).

**DA-3a-iii — the render-state channel: what it carries, and what it does not.** A custom action
re-renders through `api.showLeaf(path, notice?, renderState?)` or
`api.showList(path?, notice?, renderState?)` (`scaffold/list-detail.ts`, `CustomActionApi`). The third
argument is **positional and optional**; it is the screen's own type; the target level's `render`
receives it verbatim beside `notice`. A banner says **what happened**, render state says **what to
render now** — which group to open, which values to put back in a form — and DA-3a-i needs both at
once. Five properties, each binding:

1. **One discriminated union per screen, named at the handler.**
   `createListDetailHandler<OrdersRenderState>({…})`, members discriminated on `kind`. A level that
   renders *any* member declares the **whole** union and narrows on `kind` — its `render` must accept
   anything any of that screen's actions can send it. A screen that declares no render state cannot
   pass one: a third argument is a compile error, not a value that quietly arrives somewhere and is
   ignored.
2. **Within-request only.** Nothing is stored, serialized or echoed to the client, and the *next*
   interaction's `renderState` is `undefined` again. Whatever must survive the next click still rides
   in `button.value` or the form's `block_id` carrier (§10, B-1, R-26) exactly as before — so a
   stage/confirm flow uses both: render state to draw state 2, the confirm button's `value` to carry
   the staged payload and its watermark into the write.
3. **State, never data.** Pass what to render, not what was read. A level reads its figures from
   `detail` (and its own secondary reads), never from `renderState` — see DA-3a-ii. The channel is
   opaque to the engine, so nothing *stops* a screen putting a loaded record in it; it is still wrong.
4. **`notFound` and the failed-action fallback get none, deliberately.** A form prefilled for a record
   that no longer resolves is a lie, and the fallback after a custom action throws must be the
   simplest render that can still work. `open`, `back`, `page` and `apply-filter` get none either: a
   staged view does not survive a "Load more", and must not.
5. **Money in render state is minor units or verbatim operator text, and the member name says which.**
   `…Cents: number` is integer minor units (M-3); `…Input: string` is what the operator typed,
   unparsed. A refusal prefills from the `…Input` member, because `19,99` or `900.00` cannot be
   re-derived from cents — that is the whole reason the draft members exist.

The five ways a screen gets this wrong. Each is a diff a reviewer can rule on:

| Mistake | What the operator gets | Reviewer's check |
|---|---|---|
| Render state set, group `block_id` unchanged (or changed with no `default_open: true`) | A banner pointing at a **collapsed** group | B-6, both halves, on the **outermost group on the open path** only — X-29, X-39 |
| Outer group forced open, collect form left in its nested `default_open: false` child | Rejected input on the page and invisible | DA-3a-i's **flattened** clause: the refusal body renders the form directly; the inner collect-group is absent |
| A loaded record in the channel, to save a read | The figures the re-read just proved stale | DA-3a-ii: no union member holds a record the level's `load` or secondary reads return |
| A formatted money string where minor units are expected, or `…Cents` where the operator typed `19,99` | A refusal that discards or mangles the amount | Property 5: every money-bearing member is `…Cents: number` or `…Input: string`, and the refusal prefills from `…Input` |
| Reading `renderState` for something the *next* click needs | A staged payload that vanishes on confirm | Property 2: anything crossing an interaction is in `button.value` or the `block_id` carrier |

**DA-3b — a staged payload that fails to decode renders an `error` notice, never a silent
redirect.** `orders-page.ts:1497` currently does `if (orderId === undefined) return showList()`,
bouncing the operator to the list with no explanation; `transitionAction` (`:1209`) has the same
shape. Replace both with a re-render carrying an `error` banner: *"That action could not be read —
nothing was changed. Reload the order and try again."*

**DA-4 — non-destructive writes stay one-shot.** Plain `form`, no confirm, no danger: add note,
restock, save/rename, create, resolve reconciliation (it records a decision and moves no money —
say so in the copy, and never style it as danger).

**DA-5 — button colour means exactly one thing.** `danger` ⇔ **irreversible, or reversible only by
a separate manual operation an operator can forget.** `primary` is not used (the form renderer's
own submit is the primary affordance). Everything else is default `secondary`. A red button without
a `confirm`, or a `confirm` on an act outside that definition, is a review failure.

**Exactly one act qualifies under the second clause: remove stock.** Restocking is not an undo — it
appends a second movement to the ledger, so an accidental removal of 40 units where 4 were meant
leaves two wrong entries and no correction trail. The risk is also asymmetric: an accidental
removal makes sellable stock vanish (lost sales while the merchant hunts for the cause), while an
accidental addition surfaces at the next count. Its inverse, **restock, stays DA-4** for exactly
that reason. No other act may be argued into this clause.

**DA-6 — status moves are one `actions` block, with ids derived from the closed state list.** All
offered transitions in a single block with **distinct** `action_id`s —
`orders:transition-processing`, `orders:transition-completed`, `orders:transition-refunded` — so
they render inline (R-13; duplicate `action_id`s in one `actions` block collide as React keys,
which is why they were split one-per-block).

**And it must not be able to dispatch to a blank screen.** Today there is one registered
`orders:transition` id with the target in `value.toState` (`orders-page.ts:1206-1208`), which is
safe; splitting it into per-state ids introduces the hazard. Offered transitions come from the
service (`orders-page.ts:367` `detail.allowedTransitions`), but `ORDERS_ACTION_IDS` is fixed at
module load (`:71-78`); `admin-route.ts:113` dispatches on set membership and `:130` falls through
to `{blocks: []}`. A service offering a state outside the plugin's closed `ORDER_STATES`
(`:83-94`) would render a button that blanks the console. So:

1. Derive the per-state ids from the `ORDER_STATES` constant and build `customActions` from the
   same constant — one source, no hand-listing.
2. **Do not render** a service-offered transition that is not in that list.
3. Assert it: a stub returning an unknown state must produce no button and no blank page.
4. **Take the target from the action id, never from `value.toState`.** The id came from
   `ORDER_STATES`; `value` is operator-alterable (B-1). Emit `toState` in `value` for devtools
   legibility if you like, but do not read it.
5. **Carry the observed `state` in `value` and re-read before writing** — DA-2a. A transition is a
   destructive write and gets no exemption from DA-3a.

The existing UI steering stays: on a `processing` order the bare `shipped` move is withheld (use
Fulfilment, which records tracking), and `cancelled` is always withheld (use Cancel, which records
a reason) — `orders-page.ts:367-372`. Each withheld move gets a DA-7 line, written per DA-7a.

**DA-7 — withheld actions: generalize the coupons pattern.** When a precondition knowably forbids
an action, render **no control** plus one `context` line stating the reason and the alternative.
Never a "disabled" button (R-11 — and after the foundation, a compile error).

The normative copy, ≤200 chars — **this blockquote is the spec, and the code is trimmed to it.**
The current string (`coupons-page.ts:492`) is 217 chars and says "3 time(s)":

> `This coupon has been redeemed 3 times — deletion is blocked to keep the redemption audit
> trail. To retire it, set its expiry to a past date.`

Applies to: coupon delete when redeemed; tax class / zone / method delete when referenced; edit and
stock forms on a soft-deleted product (already correct — keep); refund action when nothing remains
refundable; cancel when the order is in a terminal state; every transition DA-6 steers away from.

**DA-7a — a withheld-action line names the ALTERNATIVE. It never narrates the design decision.**
An operator does not care what the designers withheld; they care what to do instead. So the line
starts from the goal and ends at the control, and these three constructions are banned outright:

| Reject | Write |
|---|---|
| *"There is deliberately no bare 'Mark shipped' — use Fulfilment above, which records the tracking and emails it to the buyer."* | *"To ship this order, record the tracking under Fulfilment above — that emails it to the buyer."* (93) |
| *"There is deliberately no bare 'Mark cancelled' — use Cancel order below, which records a reason on file."* | *"To cancel this order, use Cancel order below — it records a reason on file."* (75) |
| *"Deletion is blocked."* (effect only, no route) | name the route, as the blockquote above does |

Mechanically: **no "deliberately", no "there is no", no "we do not"** in a DA-7 line, and the line
contains a verb the operator can act on. The banned constructions are also 30 characters longer than
the useful version, so this is not a trade-off (§0.2 E-q).

One consequence worth knowing before you write a test: a DA-7 line quotes the control it points at, so
`getByText("Cancel order")` matches the **line**, not the accordion trigger. Match a trigger that
*starts with* the label, or resolve by `block_id` (§15 V-1).

---

## 9. Money, dates, IDs

**M-1 — money is always formatted, never raw.** Every money value reaching a screen goes through
`formatMoney`. A bare integer of minor units in a label, value, cell, or stat is a review failure
(Reports currently prints raw cents with the description "integer minor units" — that is the bug
this rule kills).

The signature is **three arguments** (`presentation/format-money.ts:23`):

```ts
formatMoney(amount: Cents, currencyCode: Currency, locale: string): string
```

- `Cents` is branded **non-negative**: `cents()` throws `RangeError` on `n < 0` and on any
  non-safe integer (`presentation/money.ts`). **A discount is therefore formatted as its absolute
  value with an explicit minus prefix** — `−$5.00`, built as
  `"−" + formatMoney(cents(Math.abs(n)), …)`. Never pass a negative into `cents()`.
- `locale` is `"en-US"` on every admin screen. Pass it explicitly; there is no default.
- The existing `formatTotal` wrapper (`orders-page.ts:1667-1673`) catches and returns
  `` `${currencyCode} ${minorUnits}` `` — i.e. raw minor units, an M-1 violation in the one place
  it is least visible. **Change the catch branch to render `—`** and emit one `context` line at the
  block level: *"One or more amounts could not be formatted and are shown as —."* A wrong number is
  worse than a missing one.

**M-2 — currency is stated once, not per row.** The formatted string carries it. Delete `Currency`
columns (order line items, reports revenue) and never badge a currency code (T-5). Where a screen
can mix currencies across rows (Reports), the currency belongs in the **label** of the grouping
(`Revenue (USD)`), not in a column of its own.

**M-3 — money input is text.** `text_input` parsed to integer minor units, label carries the
currency, placeholder shows an example (`e.g. 19.99`). Never `number_input` (F-6).

**M-4 — a money ladder is a `table`, not `fields`.** `fields` is row-major `grid-cols-2` (R-3), so
a five-line ladder can **never** read downward inside one `fields` block, whatever order the
entries are authored in. Render it as:

```
table  block_id orders:totals
       columns  Line (text) | Amount (text)          ← money last, T-2
       rows     Subtotal | Discount | Shipping | Tax | Total
       page_action_id orders:page   // never fires: no next_cursor, no sortable column
       (no empty_text — the ladder always has five rows)
```

`orders-page.ts:343-347` **already** emits Subtotal, Discount, Shipping, Tax, Total in that order.
There is no ordering bug to fix and no reordering of `fields` entries that would help — any earlier
claim of a "reported bug" here is withdrawn.

**M-5 — snapshots are labeled once.** The order's line-item table gets one `context` line: *"Titles
and prices are what the buyer paid — later product edits never change them."* Nothing else on the
screen re-litigates it.

**M-6 — dates.** Tables use `format:"relative_time"`. `fields` use absolute UTC **trimmed to
seconds** (`2026-07-26T09:14:37Z`) with the label suffixed `(UTC)`; milliseconds are noise and must
be trimmed. Date-only bounds (filters, validity windows) render `YYYY-MM-DD`. No timezone
conversion anywhere.

**M-7 — IDs.** `format:"code"` in tables. In `fields`, the full id is the value of a labeled field
(`Order ID`). An id never appears inside prose, inside a button or submit label (`Save std-us` →
`Save rate`, id in the enclosing accordion label), or as an option label (L-7 — the id is the
option's **value**, never its text).

**M-8 — `meter` with money requires `custom_value`.** `meter` has no currency (R-20). Whenever
`value`/`max` are minor units, `custom_value` is **mandatory** and carries the formatted readout:
`value: 0, max: 9900, custom_value: "$0.00 of $99.00"`. A `meter` over a count
(redemptions-of-max-uses) may omit it.

**At `max == 0` the `meter` is omitted entirely** — a full-width bar over a zero denominator is not a
ratio (§2 forbids a synthetic `max`, and this is the degenerate cousin). The fact goes in the group's
D-6b label instead, which is where an operator reads it without opening anything.

**M-9 — `banner.variant` is `default` | `alert` | `error`.** Nothing else. Urumi's mirror allows
`"info"`/`"success"`, which the renderer forwards unvalidated into Kumo (R-18). Map intent: notice
→ `default`; needs-attention → `alert`; failure → `error`. There is no success variant; a
successful write is a `default` banner plus the response `toast`.

**M-10 — a UUID is not a title.** A detail `header` uses the human handle when one exists (product
title, coupon code, zone name). Orders have none, so `Order <uuid>` stands — but the uuid appears
exactly once, in the header, and as a `code` field if needed for copying.

**M-11 — two money figures that disagree must be reconciled in copy.** Wherever a screen renders a
record's **total** and a **narrower** figure derived from it — captured, settled, redeemed, allocated —
and the two can differ, one `context` line states which figure is the money that actually moved and
names both amounts. Required **whenever the narrower figure ≠ the total**, not only at zero.

The case that earned this: the Money panel renders `Captured $0.00 · Remaining $0.00` while the
identity strip two blocks up renders `Total $95.00`, and nothing on the screen tells an operator
whether $95 arrived (§0.2 E-g). Both figures are honest; together they are a contradiction the operator
has to resolve by leaving the console. The line resolves it:
*"Captured is the money that actually arrived; $0.00 of the $95.00 total has been captured so far."*
(96 chars.)

Two things this rule is not:

- **Not a licence to guess a cause.** State the arithmetic and the semantics; do not diagnose *why*
  (E-7). "Authorised but not settled" is a claim about a payment provider this screen cannot verify.
- **Not a substitute for D-6b.** M-11 fixes the `fields` block; D-6b fixes the accordion label whose
  ratio degenerates to `$0.00 of $0.00`. A panel needs both, and the D-6b label replaces the ratio
  rather than sitting above an explanation of it.

**M-11a — `Remaining` alone is not a label.** Name the axis: **`Remaining refundable`**. Beside
`Captured` and `Refunded` a bare `Remaining` could mean remaining to capture, to refund, or to ship;
it matches the `meter`'s semantics and the DA-3a refusal's own wording, and it costs eleven
characters. Same discipline for `Available`, `Used`, `Left` on any screen.

---

## 10. `block_id` contract

`block_id` is load-bearing: it is the React key (R-13), so it decides what keeps state across a
re-render and what refreshes. These rules are not optional — getting them wrong produces stale form
values, blank tab panels, confirm buttons hidden inside a collapsed accordion, and a
`Clear filters` that does not clear.

**B-1 — grammar, and who echoes it.**

```
block_id  ::=  <entity>:<verb-or-noun>[":u1." base64url(json context)]
```

Always entity-prefixed, so it can never collide with an index key. The `:u1.` marker is what
separates a carrier token from a plain semantic id; `decodeCarrier` splits on the **last** `:u1.`
and returns `undefined` when there is none (§0.1 C).

`elements/button.tsx:15-21` sends `{type, action_id, value}` and nothing else, and none of
`actions.tsx`, `empty.tsx` or `section.tsx` passes a parent block id into `renderElement`.
`form.tsx:57` and `table.tsx:55,64` **do** send it. Therefore:

| Control | Where its context rides |
|---|---|
| `form` submit | the form's `block_id` |
| `table` sort / load-more | the table's `block_id` |
| **every `button`** — DA-2 deletes, DA-2b values, DA-3 state-2 confirms, DA-6 transitions, L-6 `Clear filters`, §12.7's `View rates`/`View methods` drill-ins, `empty.actions` | `button.value` |

Both use the **same payload shape**. A button's payload is `{ ...context, __path: encodePath(path) }`
when it needs the drill path.

`button.value` **is** in the client payload and is operator-alterable. "Never visible" in F-2 means
"never rendered as a field", not "not on the wire" — every decoded value is untrusted input and is
re-authorized server-side, exactly like a `select`'s value.

**B-2 — payload shape.** The carrier payload is a **flat `Record<string, string>`**. A nested
object, a number, an array, or a `__proto__` key rejects the token **whole** (decode is total and
never partial). **Money crosses as `String(cents)`**; parse it back with the same integer
discipline as a form field. `__path` (from `nav.ts`) and `__v` (B-3a's prefill digest) are the two
reserved keys.

**B-2a — a `block_id` that carries no context has no `:u1.` segment** — `orders:hdr`, `orders:list`,
`orders:totals`, `orders:<id>:tabs`, `orders:<id>:refunds` — and is **never** passed to
`decodeCarrier`. The marker is exactly what keeps the two namespaces from being confused.

**B-2b — uniqueness.** A `block_id` is unique within its sibling array. Two sibling forms carrying
*identical* context are distinguished by their **namespace**, not by a payload key: the namespace
is part of the token, so `orders:refund:u1.…` and `orders:refund-partial:u1.…` differ even with the
same payload. Blocks needing no identity carry none.

**B-3 — a prefilling form's carrier includes a change token.** A form that prefills from a record
**must** include, in its carrier payload, a value that changes when the record changes: `updatedAt`,
`rateBps`, the reconciliation flag, the observed `onHand`/`refundedSoFarCents`. Because a mounted
`text_input`/`select`/`toggle` ignores a new `initial_value` (R-12), a changed `block_id` is the
**only** way to refresh a form's prefill after a write.

`CouponWire` and `CouponSummaryWire` have **no `updatedAt`** (`admin-rules-client.ts` — absent from
both). The coupon edit forms' change token is therefore a **stable hash of their mutable fields**
(`rateBps`, `capCents`, `minSubtotalCents`, `startsAt`, `expiresAt`, `maxUses`,
`maxUsesPerCustomer`), computed with the plugin's existing FNV-1a helper. Without it the coupon
edit form silently prefills stale values after every save.

**B-3a — and the prefill digest makes that automatic.** B-3 alone is a rule a team can forget.
Every prefilling form's `block_id` therefore comes from
`carriedForm({ namespace, context, form })`, which appends a short digest of the form's own
authored `initial_value`s (in field order) under the reserved key `__v` (§0.1 D).
Because the helper takes the whole form and hands it back with `block_id` set, a screen never
composes this token by hand. Then **"prefill
changed ⇒ key changed ⇒ fields refresh" holds by construction**, and B-3's explicit watermark is a
second, semantic guarantee rather than the only one.

This is not belt-and-braces; it fixes a real bug that B-7 alone does not. Once a filter form is
wrapped in an accordion, the form is the accordion's sole child and its React key is **index 0,
forever** (R-13a) — the incidental remount a top-level form gets when a prepended banner shifts
indices no longer happens. So on `Clear filters` the server rebuilds the default filter and
re-renders with empty `initial_value`s, the accordion's key is unchanged (B-7), nothing remounts,
and **the fields still show the filter that was just cleared** — the operator's next submit
re-applies it. The prefill digest changes when the prefill does, so the inner form remounts and the
fields actually clear.

**B-4 — the detail `tab` block has a stable `block_id`** (`orders:<id>:tabs`). It must not encode
anything volatile: a stable key keeps the operator on the panel they were using after an action's
re-render instead of throwing them back to panel 0.

**B-5 — accordions have stable, semantic `block_id`s** (`orders:<id>:refunds`), so an open group
stays open across a round trip — **including after a failed submit that still returns 200** (E-6; a
non-200 unmounts everything, R-24).

**B-6 — forcing a group open requires BOTH a changed `block_id` AND `default_open: true`.** The
changed key remounts the group, and the remount **re-reads `default_open`** (`accordion.tsx:14`) —
which for a destructive group is `false` (D-5). Change only the id and the accordion renders
**collapsed**, hiding the confirm button the operator just asked for. Change only the flag and
nothing happens, because the mounted group never re-reads it.

Append a token to the semantic id — `orders:<id>:refunds:review` — and set the flag. Used by DA-3
state 2, by a **DA-3a or DA-3c refusal** (DA-3a-i), by a validation error inside a closed group, and by
`empty.actions`' create button (E-2). The token goes on the **outermost group on the open path**, never
on a nested child — see DA-3. A
group forced open this way is **exempt from D-5's** "always false for anything destructive": D-5
Rule 1 is precisely that exemption.

**B-7 — the filter accordion's key and the filter form's key are different keys with different
change conditions.** Getting this wrong in either direction is a bug, so both halves are stated:

| Key | Changes when | Never changes on |
|---|---|---|
| the **accordion**'s `block_id` | the drill level changes | `apply-filter`; `Clear filters` |
| the **form**'s `block_id` (via `carriedForm`) | its carried context changes, **or its prefilled values change** — which covers `apply-filter` and `Clear filters` alike (B-3a) | a re-render that changes neither |

Why the accordion is stable: encoding the filter into the accordion's `block_id` would remount it
on every apply, and `default_open: false` would then slam it shut — exactly wrong for the operator
who filters constantly, which is the entire premise for collapsing it (L-4). The reviewer-suggested
failure mode for a stable accordion ("the fields show pre-submit values") does not occur on an
apply, because the pre-submit values *are* the filter that was applied. `filterPanel`'s `blockId` is
required (§0.1 D) precisely so the stable key cannot be skipped.

Why the form is not stable: R-13a. Inside a container the form loses the incidental index-shift
remount, so it needs its own change signal — see B-3a for the `Clear filters` failure this fixes.

---

## 11. Worked example — Orders

The reference implementation. The other six screens pattern-match against this.

> **§11 and §12 are subordinate to §5–§10 and §13 — see N-1.** These listings are a shortcut, not a
> second rulebook. Revision 3's version of §11.2 contradicted five rules and three of those
> contradictions became defects in the built screen. If a line below conflicts with a rule, **build
> the rule and report the line.** Revision 4 fixed every conflict found so far; assume there are more.

### 11.1 Orders list

```
header      block_id orders:hdr
            "Orders"

context     "Filter, open an order, and move it through its status flow. Money in the order's
             currency; dates UTC."                                           (101 chars ≤140)

banner      (cond) notice from the last action  {variant: default|alert|error, title, description}

accordion   block_id orders:filters                 STABLE across apply AND clear (B-7)
            default_open false                                                 (L-4)
            label  "Filters"  |  "Filters (2 active)"                          (L-3)
            └─ form  cf{"orders:filter", {__path:""}}
                     → "orders:filter:u1.<b64>"     ← payload holds __path + __v prefill digest
                 select      "Status"       options: {any, pending, paid, failed, expired,
                                                      processing, shipped, delivered, completed,
                                                      cancelled, refunded}
                                            initial_value  form.status ?? "any"      (F-6a)
                 date_input  "From (inclusive)"
                 date_input  "To (exclusive)"
                 text_input  "Search order ID or buyer email"
                 submit      "Apply filters"          → orders:apply-filter
                                                      4 fields → accordion (L-2)

section     (cond, any filter non-default)
            text       filterSummary(["status: paid", "from 2026-07-01"])
                       → "status: paid · from 2026-07-01"                      (L-6)
            accessory  button "Clear filters" → orders:apply-filter
                       value { __path: encodePath(path) }                      (B-1)

table       block_id orders:list                                        (only when ≥1 row)
            columns    Order #   (code)          ← identity first
                       Placed    (relative_time)
                       Status    (badge)         ← the one badge column (T-5)
                       Customer  (text)
                       Total     (text)          ← money last, pre-formatted (T-2, M-1)
            page_action_id orders:page ; next_cursor when present
            empty_text  "No orders match these filters."          ← filtered-to-zero only

empty       (cond: unfiltered AND zero rows — the table is OMITTED, E-2)
            title       "No orders yet"
            description "Orders appear here as buyers check out."
            size        "base"
            (no actions — orders are not created in the admin)

form        (cond: ≥1 row)  block_id "orders:open:u1.<b64>"
            combobox  "Open order"        ← combobox at ANY row count: the value is an
                                            opaque id, so a select would show it (L-7, R-17b)
                      placeholder "Choose an order…"                           (R-17b)
                      options[0]  { value:"none", label:"Choose an order…" }
                      options[n]  { value:<uuid>,
                                    label:"qa-ordc-2@example.com · $99.00 · paid" }
                      initial_value "none"                                     (F-6a, L-7)
            submit    "Open order"  → orders:open
```

Chrome above the first data row: `header` + one 101-char `context` + a one-row accordion (+ the
summary `section` when filtered). No `sortable` (T-3). No `Currency` column (M-2). No create form
(orders are not created here). No `columns` (§2).

### 11.2 Order detail — four task-named panels

**Where every currently-rendered section lands.** This mapping is normative; nothing is dropped
silently.

| Current section (`orders-page.ts`) | Lands in |
|---|---|
| identity `fields` (`:305`) | outside the tabs, block 5 — **gains `Total`**, making it 6 entries in 3 pairs (it is 5 today, an odd count, §2) |
| Reconciliation alert (`:317`) | banner **outside** the tabs (D-1) + `Resolve` group in **Fulfilment** |
| Customer (`:409`) | **Order** panel, `Customer` group |
| Line items (`:320-322`) | **Order** panel |
| Totals `fields` (`:340`) | **Order** panel, as a **`table`** (M-4) |
| Shipping address (`:822`) | **Fulfilment** panel, `Shipping address` group |
| Fulfilment (`:873`) | **Fulfilment** panel, `Fulfilment` group |
| Cancellation (`:974`) | **Fulfilment** panel, `Cancel order` group — *see the note below* |
| Refunds (`:1067`) | **Money** panel |
| Move status (`:373`) | **Fulfilment** panel, `actions` (DA-6) |
| Notes (`:389`) | **History** panel, `Notes` group — **form only**; the timeline's `Detail` column is the read path |
| Timeline (`:570`) | **History** panel |

**"Nothing is dropped silently" is a promise this table makes, and a `fields` listing below can
break it.** Revision 3's `Customer` (4 entries) and `Shipping address` (8) listings did exactly that —
they lost `Buyer reference`, `Email verified`, `Email` and `Region`, the last of which makes a US
address unshippable (§0.2 E-n). The counts below are **6** and **10**. If a listing's entry count is
smaller than the data the mapping table sends to that group, the listing is the defect (N-1).

**Why cancellation sits in Fulfilment.** Cancelling and fulfilling are the two answers to one
question — *does this order ship?* — so an operator deciding between them should not have to change
panels. It does not belong in **Money**: cancelling moves no money (a cancelled order that was paid
still needs a refund, which is a separate act in a separate panel, and keeping them apart is a
feature). Safety comes from DA-2b/DA-3 + `confirm`, not from panel separation.

```
header      "Order 5be2abed-058f-4eb4-8ccc-7ffdec241061"                        (M-10)

actions     block_id orders:nav
            button "← Back to orders" → orders:back   value { __path: encodePath([]) }

banner      (cond) notice from the last action

banner      (cond, reconciliation flagged — OUTSIDE the tabs, D-1)
            variant "alert" · title "Needs reconciliation"
            description ≤240: what settle detected + that resolving records a decision only

fields      block_id orders:identity          6 entries, row-major pairs (R-3)
              Status            | Total
              Placed (UTC)      | Payment
              Customer          | Reconciliation

tab         block_id orders:<id>:tabs      default_tab 0      panels ALWAYS 4 (D-3)

├─ panel "Order"
│    header     "Line items"                    ← the one permitted panel header (P-2)
│    table      block_id orders:lines
│               SKU (code) | Title | Qty (number) | Unit price | Line total
│               page_action_id orders:page   // never fires · NO next_cursor (T-8)
│               empty_text "No line items."
│    context    "Titles and prices are what the buyer paid — later product edits never
│                change them."                                                 (M-5)
│    table      block_id orders:totals                                         (M-4)
│               Line | Amount        rows: Subtotal, Discount, Shipping, Tax, Total
│               page_action_id orders:page   // never fires
│    accordion  block_id orders:<id>:customer    default_open FALSE
│               label "Customer — qa-ordc-2@example.com (guest)"                (D-6)
│               ├─ fields   ON AN ACCOUNT — 6 entries (D-1a: the 6-entry cap is the identity
│               │           strip's, NOT a panel's; these 6 are the mapping table's promise)
│               │             Account email  | Account          ← "Account email", not "Email"
│               │             Name           | Orders placed
│               │             Contact email  | Email verified (UTC)
│               │           ON A GUEST — 2 entries, and only these:             (D-7)
│               │             Contact email  | Orders placed
│               │           Never render a row whose only content is a denial. On a guest,
│               │           `Account email —`, `Name —`, `Account Guest — no account` and
│               │           `Email verified not verified` say "no account" four times over
│               │           the D-7 line that already says it, while `Email` denies an
│               │           address the label, the identity strip and `Contact email` all
│               │           display. Drop `(UTC)` when the value is `not verified`.
│               ├─ context  (guest, zero secondary data) "Guest checkout — no account, no
│               │            saved addresses, no sign-in history."              (D-7)
│               ├─ accordion "Saved addresses (2)"   default_open false → table  ← omit at 0
│               ├─ accordion "Sign-in sessions (3)"  default_open false → table  ← omit at 0
│               └─ accordion "Other orders (4)"      default_open false → table  ← omit at 0
│                  (columns: Order # code | Placed relative_time | Status badge | Total)
│
├─ panel "Fulfilment"
│    accordion  block_id orders:<id>:reconcile   default_open per D-5 rank 1
│               (cond: flagged and unresolved)
│               label "Resolve reconciliation"
│               └─ context (records a decision; moves no money — DA-4)
│                  form  cf{"orders:reconcile", {orderId, expectedFlag}}
│                        Outcome (select) · Reason · Resolved by
│                        submit "Record resolution"
│    accordion  block_id orders:<id>:ship         default_open FALSE
│               label "Shipping address — US"     ← omitted entirely when absent, replaced by
│                                                  one context line (E-1, D-7)
│               └─ fields  10 entries — Region is REQUIRED (a US address with no state is
│                          not shippable), and the 6-entry cap is the identity strip's (D-1a)
│                            Name           | Country
│                            Address line 1 | Address line 2
│                            City           | Region
│                            Postal code    | Chosen shipping zone
│                            Email          | Phone
│                  (Address is split across fields, never one 40-char value — §1 budget)
│                  context "Captured at checkout and frozen on this order. The zone is the
│                           buyer's priced choice; nothing cross-validates them."   (≤200)
│    accordion  block_id orders:<id>:fulfilment   default_open per D-5 rank 2
│               label "Fulfilment" | "Fulfilment — UPS 1Z999AA10123456784"      (D-6)
│               └─ recorded: fields   Carrier | Tracking number · Shipped (UTC) | Recorded by
│                  to record: context (≤200) + form
│                    cf{"orders:fulfil", {orderId, state}}
│                    Carrier · Tracking number · Tracking URL (optional) ·
│                    Ship date (optional) · Recorded by                        5 fields ≤6
│                    submit "Record fulfilment & ship"                         (DA-4)
│                  ON `paid` — rank 2 opens this group before tracking is capturable, so it
│                    renders ONE DA-7 line and no form (see D-5's note):
│                    "Tracking is recorded once this order is processing — use 'Mark
│                     processing' below first."                                (DA-7a)
│    actions    block_id orders:transitions                                     (DA-6)
│               ids derived from ORDER_STATES; target read from the ACTION ID, never from
│               value.toState (DA-6 item 4); `shipped` on a processing order and `cancelled`
│               always withheld, each with one DA-7a line
│               EVERY button carries the observed `state` — the watermark (DA-2a, DA-6 item 5)
│               [ "Mark processing" → orders:transition-processing
│                   value {orderId, toState, state} ]
│               [ "Mark completed"  → orders:transition-completed
│                   value {orderId, toState, state} ]
│               [ "Mark refunded"   → orders:transition-refunded
│                   value {orderId, toState, state}
│                   style danger + confirm{ title "Mark this order refunded?",
│                     text "Marks the order refunded for bookkeeping. It does not move money —
│                           record the money in Money → Refunds.",
│                     confirm "Yes, mark refunded", deny "Keep as is", style "danger" } ]
│    accordion  block_id orders:<id>:cancel       default_open FALSE
│               label "Cancel order — permanent, releases held stock"   45 chars (D-6a)
│                     ← NOT a bare "Cancel order": this trigger is the most dangerous
│                       control on the panel and a label cannot be red (R-5)
│               └─ banner alert "Cancelling is permanent" (≤240)
│                  context  "Pick the reason — cancelling is immediate."       (≤200)
│                  actions  one danger button PER REASON                       (DA-2b)
│                    4 reasons, so ≤4 ⇒ style danger on each                   (DA-2c)
│                    LABELS ARE THE BARE REASON — no "Cancel — " prefix, no parenthetical:
│                      [ "Customer requested it" ] [ "Fraud suspected" ]
│                      [ "Out of stock" ]          [ "Pricing error" ]
│                    NO "Other" button. "Cancel — Other (add detail below)" promised a field
│                      it did not provide — it fired immediately, with no detail, pointing at
│                      a group that may be collapsed. The note group below is the ONLY path
│                      that records detail, and `other` is a reason inside its select.
│                    [ "Out of stock"  value {orderId, reason, state}    ← state = watermark
│                        confirm{ title "Cancel this order?",
│                          text "Cancel this order as 'out of stock'? This is permanent and
│                                releases the held stock.",
│                          confirm "Yes, cancel the order", deny "Keep the order",
│                          style "danger" } ]
│                  accordion "Cancel with a note"  default_open FALSE          (DA-3)
│                    ├─ banner alert                                            (≤240)
│                    │    title "Review what you typed on the next step"
│                    │    description "The confirm on the next step is what records the
│                    │                 cancellation — nothing is recorded until then."
│                    │    ← says ONLY what is new. The parent banner 190px above already
│                    │      says "Cancelling is permanent"; repeating it teaches the
│                    │      operator to skim both. And no "the point of no return" — the
│                    │      one purple phrase on an otherwise plain-spoken screen (E-4).
│                    └─ form  Reason (select, includes `other`) · Detail · Cancelled by
│                             submit "Review cancellation" → orders:cancel-review
│               state 2 puts `:review` + default_open on THIS group — orders:<id>:cancel:review
│                 — and renders the staged form + confirm directly. The "Cancel with a note"
│                 accordion is NOT rendered in state 2 (DA-3's outermost-group rule).
│               (already cancelled ⇒ the whole group is `fields` of the recorded cancellation)
│
├─ panel "Money"
│    fields     block_id orders:money
│                 Captured            | Refunded
│                 Remaining refundable| Refunds recorded     ← "Remaining" alone is ambiguous:
│                                                              to capture, refund or ship? (M-11a)
│               ← `Payment` is already in the identity strip; do not repeat it (P-3)
│    context    (cond: captured != total)                                      (M-11)
│               "Captured is the money that actually arrived; $0.00 of the $95.00 total has
│                been captured so far."
│               ← without it, `Total $95.00` two blocks up and `Captured $0.00` here read as
│                 a contradiction the operator must leave the console to resolve
│    accordion  block_id orders:<id>:refunds      default_open FALSE
│               label  ceiling > 0 ⇒ "Refunds — $0.00 of $99.00 refunded"       (D-6)
│                      ceiling == 0 ⇒ "Refunds — nothing captured, nothing to refund"
│                        ← the DEGENERATE ratio is replaced, not explained (D-6b), and the
│                          "Nothing has been captured…" context line is then DROPPED
│               ├─ meter  label "Refunded" value 0 max 9900   (omit entirely at max 0)
│               │         custom_value "$0.00 of $99.00"     ← MANDATORY (M-8)
│               ├─ table  (cond ≥1) Amount | Provider ref (code) | By | When
│               │         NO `Kind` COLUMN. `kind` is the ORDER's gateway capability
│               │         (refund-order.ts:211), so it is constant down this table — a
│               │         column of identical `manual` pills, forbidden by T-5's third
│               │         bullet, and "refund kind" is struck from T-5's whitelist.
│               │         page_action_id orders:page // never fires · NO next_cursor (T-8)
│               ├─ context capability line ≤200, honest about record-only vs real
│               ├─ actions (cond: remaining > 0)                               (DA-2b)
│               │    [ "Refund $99.00 (full remaining)"  style danger
│               │        value {orderId, amountCents:9900, refundedSoFarCents:0}
│               │        confirm{ title "Refund $99.00?",
│               │          text "Refund $99.00 to qa-ordc-2@example.com? This records a refund
│               │                made out of band — it does not move money.",
│               │          confirm "Yes, refund $99.00", deny "Keep as is", style "danger" } ]
│               ├─ accordion "Refund a different amount — cannot be reversed"   (DA-3, D-6a)
│               │      default_open FALSE                                    46 chars
│               │    ├─ banner alert "A recorded refund cannot be reversed here" (≤240)
│               │    │         ← DA-3 state 1 requires it (§2 does not count it)
│               │    └─ form  cf{"orders:refund-partial", {orderId, refundedSoFar:"0"}}
│               │             Refund amount (USD) · Reason (optional) · Refunded by
│               │             submit "Review refund" → orders:refund-review
│               │             the -review handler BOUND-CHECKS amountCents against the live
│               │               remaining before it renders anything (DA-3c)
│               └─ context (cond: remaining == 0) "Fully refunded — nothing left to refund."
│                          ← and NO refund control at all                      (DA-7, DA-7a)
│               STATE 2 belongs to THIS group, not the child (DA-3's outermost-group rule):
│                 block_id orders:<id>:refunds:review  +  default_open TRUE     (B-6)
│                 body = banner + staged form + one danger confirm button, and nothing else
│                 — the meter, the ledger and the full-remaining button are all suppressed
│               A DA-3a OR DA-3c REFUSAL re-renders STATE 1 into THIS group: forced open,
│                 the collect form FLATTENED into the group body, the submitted values
│                 prefilled, and NO confirm button — a confirm here would re-offer the
│                 payload just refused             (DA-3a-i, incl. its scoping note; X-39)
│
└─ panel "History"
     table      block_id orders:timeline
                When (relative_time) | Event (badge) | Who | Detail
                  ← `Detail` carries a note's full body for a `note` event, which is why
                    the Notes group below is form-only
                page_action_id orders:page // never fires · NO next_cursor (T-8)
                empty_text "No timeline activity yet."
     context    (cond: TRUNCATED only — T-8a)
                "Showing the 50 most recent events; older activity is not listed."
     accordion  block_id orders:<id>:notes        default_open FALSE
                label "Notes (2)"                                               (D-6)
                └─ NO read table. The timeline's `Detail` column above already renders both
                   note bodies verbatim, and its cap (50) is looser than the notes cap (20),
                   so the table added a duplicate and a second cap line and nothing else.
                   The label carries the count; the group carries the form.
                   form  cf{"orders:note", {orderId}}
                         Note (multiline) · Author    submit "Add note"         (DA-4)
```

**What this removes from the current screen.** Eleven top-level sections become 5 blocks + 4
panels. Thirteen `section`-as-heading labels (`Line items`, `Move status`, `Notes`, `Customer`,
`Saved addresses`, `Sign-in sessions`, `Other recent orders`, `Timeline`,
`Reconciliation resolved`, `Shipping address`, `Fulfillment`, `Cancellation`, `Refunds`) become
accordion labels and one permitted panel header. Five "no data" heading+table pairs become one sentence. The 744-char and 452-char
paragraphs become ≤200-char lines inside the accordions they describe. Three `actions` blocks
become one. Six carrier dropdowns and two nonce dropdowns disappear — the carriers into
`block_id`s, the nonces deleted outright (F-2a). The totals ladder reads down, as a table.

**And what revision 4 removes from the revision-3 listing** — every item a defect found by building
it (N-1, §0.2): the refunds table's constant `Kind` badge; a fifth cancel-reason button that promised
a field it did not have; a second `Cancelling is permanent` banner 190px below the first; the Notes
read-table that repeated the timeline verbatim; two unconditional cap lines; two DA-7 lines that told
the operator what designers withheld; and four `Customer` rows that said "no account" on a guest. Six
things are **added**: the transition watermark, `Region`, `Contact email`, the M-11 line, D-6a's two
consequence labels, and DA-3c's bound check.

---

## 12. Per-screen block listings

Each screen gets the same artifact §11 gives Orders: an abbreviated block-order listing plus the
deltas that are not obvious from it. Prose-only deltas are not startable, so there are none.

> **N-1 applies to every listing below.** These were written before any screen was built and have
> **not** had the scrutiny §11.2 has now had. Where one conflicts with §5–§10 or §13, build the rule
> and report the line in your PR. Expect to find some: revision 3's §11.2 had five.

Throughout, `cf{ns, ctx}` is shorthand for **`carriedForm({ namespace: ns, context: ctx, form })`**
— the helper takes the whole `FormBlock` and returns it with `block_id` set, so a line reading
`form cf{...}` means "this form is produced by `carriedForm`", never "assign this token to
`block_id`". Every prefilling form goes through it (B-3a); **no §12 listing hand-rolls a form's
`block_id`.**

### 12.1 Pricing & inventory (`products-page.ts`) — built last

> **⚠ This screen carries the console's only live X-20 violations. Do not miss them.** Two *rendered*
> strings use the banned slogan:
>
> | Line | String | |
> |---|---|---|
> | `products-page.ts:409` | *"…the store stops selling at zero stock **(no overselling)**; backorders are a future capability."* | inside the 744-char edit-form `context` §1 already splits |
> | `products-page.ts:422` | *"…it can never be **oversold**. Enter whole units only."* | the stock-form `context` |
>
> Both are operator-facing copy and both must go — the mechanism sentence ("the store stops selling at
> zero stock") is already there and is the whole of what the operator needs. **The code comments at
> `:461-462` and `:604-606` documenting the domain invariant are exempt and MUST SURVIVE** (§13 X-20,
> and the voice rule in the front matter). A PR that "fixes" those comments has broken the invariant's
> only documentation; a PR that ships either rendered string fails X-20.

```
── LIST ──
header      "Pricing & inventory"
context     "Filter and open a product. Money in each product's own currency; stock is on
             the detail."                                                       (≤140)
banner      (cond) notice
accordion   block_id products:filters      label "Filters" | "Filters (2 active)"
            default_open false                                    3 fields → accordion (L-2)
            └─ form  cf{"products:filter", {__path:""}}
                     select "Status"  options {any, true, false, archived}
                                      labels: All statuses (live) / Active / Inactive /
                                              Archived (deleted)     ← "" → "any" (F-6a)
                     select "Kind"    options {any, physical, digital}   ← "" → "any"
                     text_input "Search (SKU exact, or title contains)"
                     submit "Apply filters"
section     (cond) filterSummary(...) + accessory button "Clear filters"
                   value { __path: encodePath([]) }                    ← depth 0
table       block_id products:list
            Title | SKU (code) | Status (badge) | Price
            ← `Kind` column DELETED: near-constant, so its badge is a column of identical
              pills (T-5, X-4); kind is on the detail
            page_action_id products:page ; next_cursor when present
            empty_text "No products match these filters."
empty       (cond unfiltered zero) title "No products yet" ·
            description "Products appear here once the CMS has a commerce-enabled document."
            (no actions — products originate in the CMS, E-2)
form        (cond ≥1) combobox "Open product"  options "<sku> · <title> · $19.99 · active"
            initial_value "none"                          submit "Open product"

── DETAIL ── 2 panels (D-2a: a History panel would hold created/updated only)
header      <product title, or the id when untitled>                            (M-10)
actions     [← Back to products]
banner      (cond) notice
banner      (cond, tombstoned) variant "alert" · "This product was deleted in the CMS"
fields      block_id products:identity        6 entries
              Title  | SKU
              Price  | Status
              Stock on hand | Kind
tab         block_id products:<id>:tabs   default_tab 0   panels ALWAYS 2

├─ panel "Product"
│    fields     block_id products:more        8 entries
│                 Compare-at | Unit cost
│                 Tax class  | Inventory policy
│                 Weight (g) | Dimensions (mm, LxWxH)
│                 Created (UTC) | Updated (UTC)          ← D-2a puts these here
│    ── the edit form splits into THREE (F-5a — products IS a verified sparse PATCH) ──
│       15 field entries (`products-page.ts:531-639`; `currency` is declared twice, in the
│       priced and unpriced branches, and only one renders) = 13 operator fields. F-2 deletes
│       2 carriers and F-3 deletes `inventoryPolicy`, leaving 12 — and the split below covers
│       exactly 12: 2 + 4 + 6.
│    context    "Each section saves on its own. Save the section you are editing before you
│               open another — saving one reloads the product and clears unsaved edits in the
│               others."                                    (F-5a-i, verbatim; ONE line, here
│               — above the three groups, never repeated inside them. X-45)
│    accordion  block_id products:<id>:edit-identity   default_open per D-5 rank 3
│               label "Identity"
│               └─ context "Title and SKU are also shown in the CMS; editing here changes the
│                           commerce record."                                    (≤200)
│                  form  cf{"products:identity", {productId, expectedUpdatedAt}}
│                        Title · SKU                                    2 fields
│                        submit "Save identity"
│    accordion  block_id products:<id>:edit-price      default_open FALSE
│               label "Price — $19.99 USD"                                       (D-6)
│               └─ context "Price, compare-at and unit cost all use the product's one currency.
│                           A blank compare-at or unit cost clears it."           (≤200)
│                  form  cf{"products:price", {productId, expectedUpdatedAt, currency}}
│                        Price (USD, e.g. 19.99) ·
│                        Currency (ISO-4217) ← ONLY when unpriced; never a fixed
│                                              single-option select (F-3) — when priced the
│                                              currency rides in the carrier
│                        Compare-at / was price (USD, optional) ·
│                        Unit cost — admin only (USD, optional)      ≤4 fields
│                        submit "Save price"
│    accordion  block_id products:<id>:edit-shipping   default_open FALSE
│               label "Classification & shipping"
│               └─ context "Weight and dimensions feed shipping quotes; blank leaves them
│                           unchanged. A blank tax class CLEARS it."                (≤200)
│                  ← two different semantics, so two clauses: blank preserves weight/dims
│                    (`products-page.ts:832-842`) but blank/`none` clears taxClass (`:825-829`)
│                  form  cf{"products:shipping", {productId, expectedUpdatedAt}}
│                        Kind (select) · Tax class (select) · Weight (g) ·
│                        Length (mm) · Width (mm) · Height (mm)          6 fields = budget
│                        submit "Save classification"
│               ── `When out of stock` DELETED (F-3: one option) ──
│    context    "The store stops selling at zero stock; backorders are a future capability."
│               ← replaces the single-option select AND the banned phrasing (X-20)
│    context    (cond tombstoned) "This product was deleted in the CMS — editing and stock
│               moves are unavailable. Restore the document to re-enable them."   (DA-7)
│
└─ panel "Stock"
     fields     block_id products:stock     On hand | Inventory policy
     context    "On hand is what can be sold right now — open cart holds are already
                 subtracted. Whole units only."                    (≤200; X-20-safe rewrite)
     accordion  block_id products:<id>:restock     default_open FALSE
                label "Add stock"
                └─ form  cf{"products:restock", {productId, onHand:"12"}}
                         Units to add                              submit "Add stock"  (DA-4)
     accordion  block_id products:<id>:remove      default_open FALSE
                label "Remove stock"
                └─ banner alert "Removing stock cannot be undone by restocking"
                   context "Restocking appends a second movement — it does not correct this
                            one. Check the number before confirming."             (≤200)
                   form  cf{"products:remove", {productId, onHand:"12"}}
                         Units to remove (damaged / shrinkage)
                         submit "Review removal" → products:remove-stock-review   (DA-3)
                   → state 2: accordion block_id +":review" AND default_open TRUE, same form
                     remounted + danger confirm, value {productId, qty, onHand}  (DA-3, DA-5)
     (sku === null ⇒ both groups omitted; one context line says why)             (D-7)
```

Deltas worth naming: the page `context` drops 452 → ≤140 (the "Archived" explanation moves into the
filter accordion). The two `header` blocks ("Edit commerce fields", "Stock") become accordion labels
and panel names (P-2). Both `divider`s deleted (R-4). The 744-char edit `context` becomes three
≤200-char lines. Both rendered "oversell" phrasings (`products-page.ts:409`, `:422`) are rewritten;
the two **code comments** (`:462`, `:604`) are left alone — they document a real domain invariant
(X-20).

### 12.2 Coupons (`coupons-page.ts`)

```
── LIST ──
header      "Coupons"
context     "Search a coupon and open it. Discounts apply to the cart subtotal at checkout."
                                                                                 (≤140)
banner      (cond) notice
form        cf{"coupons:filter", {__path:""}}                1 field → INLINE (L-2)
            text_input "Code (exact match, case-insensitive)"   submit "Search"
section     (cond) filterSummary(["code: SUMMER25"]) + accessory button "Clear filters"
                   value { __path: encodePath([]) }                    ← depth 0
table       block_id coupons:list
            Code (code) | Discount | Valid | Uses
            ← `Type` column DELETED: `Discount` already reads `20% off` / `$5.00 off` (T-5)
            page_action_id coupons:page ; next_cursor when present
            empty_text "No coupon matches that code."
empty       (cond unfiltered zero) title "No coupons yet" ·
            description "Create one to start discounting carts." ·
            actions [ button "New coupon" → coupons:new  ← re-renders with the create
                      accordion forced open (E-2, B-6) ]
form        (cond ≥1) combobox "Open coupon" options "<code> · 20% off · 3 uses"
            ← combobox, NOT select: the option VALUE is the coupon id (distinct from
              `code` — the create form authors both), and a select renders the value
              (R-17a, X-22). Corrected in revision 4; revision 3 said `select`.
            placeholder "Choose a coupon…"
            initial_value "none"                        submit "View / edit"
accordion   block_id coupons:new    label "New coupon"    default_open false      (L-8)
            └─ context "ID, code, type and currency are fixed at creation — to change them,
                        retire this coupon and issue a new code."                 (≤200)
               form  block_id coupons:create        3 unconditional + 2 gated = 5 VISIBLE
                     Coupon ID · Code · Type (select: fixed_amount | percentage)
                     + condition-gated (F-5b):
                       Amount off · Currency        condition {field:"type", eq:"fixed_amount"}
                       Rate (%) · Discount cap      condition {field:"type", eq:"percentage"}
                     `type` declares initial_value "fixed_amount"  ← required (F-5b, R-12b)
                     submit "Create coupon"
               ── FIVE fields leave the create form (it is 12 today,
                  `coupons-page.ts:324-391`): `Starts at`, `Expires at`, `Minimum spend`,
                  `Max total uses`, `Max uses per customer`. All five are editable and all
                  five already have a home in the detail's one edit form below. A coupon
                  created without them is valid immediately, forever, unlimited and
                  unrestricted — the common case — and dropping them is what keeps the create
                  form at 5 visible instead of 8. `Minimum spend` in particular must NOT
                  appear in both forms. ──

── DETAIL ── 2 panels (D-2a)
header      "Coupon — SUMMER25"                                                  (M-10)
actions     [← Back to coupons]
banner      (cond) notice
fields      block_id coupons:identity      6 entries
              Code     | Discount
              Type     | Uses
              Currency | Created (UTC)      ← D-2a puts Created here
tab         block_id coupons:<id>:tabs   default_tab 0   panels ALWAYS 2

├─ panel "Coupon"
│    fields     block_id coupons:more    Minimum spend | Valid
│               ← read-back of the two fields whose form value is easiest to mis-read; the
│                 form below is the only place they are edited
│    accordion  block_id coupons:<id>:edit   default_open per D-5 rank 3
│               label "Edit — 20% off, cap $10.00, until 2026-12-31"             (D-6)
│               └─ context "Saving replaces EVERY field below — this is a full replace, so a
│                           blank optional field saves as unset, not unchanged."  (≤200,
│                           trimmed from 613)
│                  ── ONE form. NOT split — F-5a forbids it: `updateCoupon` is a PUT and the
│                     service coerces absent ⇒ null (`rules-admin.ts:434-443`), so a split
│                     "Discount" save would silently wipe startsAt / expiresAt / maxUses /
│                     maxUsesPerCustomer. Field count is met by `condition` (F-5b) plus F-5c's
│                     full-replace exemption. ──
│                  form  cf{"coupons:edit", {couponId, token:<hash of mutable fields>}}
│                        ← B-3: CouponWire has NO updatedAt, so the token is a stable hash
│                        condition-gated on the coupon's IMMUTABLE `type`, so the server emits
│                        only the applicable branch and `condition` is belt-and-braces:
│                          fixed_amount →  Amount off                        1 field
│                          percentage   →  Rate (%) · Discount cap           2 fields
│                        then, always:
│                          Minimum spend (optional) · Starts at (optional) ·
│                          Expires at (optional) · Max total uses (optional) ·
│                          Max uses per customer (optional)                  5 fields
│                        ⇒ 6 visible for fixed_amount, 7 for percentage — over F-5's 6, and
│                          legal only under F-5c, which this form is the sole instance of
│                        submit "Save coupon"
│                  ── every editable field on `coupons-page.ts:502-572` has a home here:
│                     amount, ratePercent, cap, minSubtotal, startsAt, expiresAt, maxUses,
│                     maxUsesPerCustomer. None is orphaned. ──
│
└─ panel "Redemptions"
     fields     block_id coupons:uses     Redemptions | Max total uses ·
                                          Max per customer | Remaining
     meter      (cond maxUses set) label "Redemptions" value 3 max 100
                ← a COUNT, so custom_value optional (M-8)
     context    "Orders already placed keep their snapshotted discount regardless of edits
                 here. Lowering max uses to at or below the current count exhausts the
                 coupon immediately."                                             (≤200)
     ── delete lives HERE, beside the count that gates it ──
     actions    (cond usesCount === 0)                                            (DA-2)
                [ "Delete coupon" style danger  value {couponId}
                    confirm{ title "Delete SUMMER25?",
                      text "Only a never-redeemed coupon can be deleted. In-flight carts
                            recompute without it; placed orders are unaffected.",
                      confirm "Yes, delete", deny "Keep it", style "danger" }   ← 112 chars,
                                                                     trimmed from 301 ]
     context    (cond usesCount > 0) the DA-7 blockquote, verbatim                (DA-7)
```

Deltas: the page `context` drops 457 → ≤140. The `divider` before the create form is deleted (R-4).
The `Type` badge column goes (T-5). The withheld-delete copy is trimmed 217 → the DA-7 blockquote,
and the delete `confirm.text` 301 → ≤200.

### 12.3 Tax (`tax-page.ts`) — the per-row inline form fix

Today every row renders `divider` + edit form + delete button **simultaneously**: N rows cost
N × (48px + ~5 field rows). Both levels are lists; neither has a detail screen.

```
── LEVEL 0: tax classes ──                        L-9 branch: nextCursor null && ≤25 rows
header      "Tax classes"
context     "A tax class is a rate group; products and rates reference one by id."  (≤140)
banner      (cond) notice
            ── NO filter block: this level has no filter fields (L-2, count 0) ──
── the row list (no table at this level; the labels are the columns) ──
accordion   block_id "tax:class:u1.<b64 {classId}>"     default_open false
            label "standard — Standard rate"        ← no count: TaxClassWire is {id,name},
                                                     a rate count is not on the wire (D-6)
            ├─ form     cf{"tax:class-save", {classId, name}}
            │           Name                        submit "Save name"            (DA-4)
            ├─ actions  [ button "View rates" → tax:open
            │             value { target: encodePath([classId]) } ]               (§12.7)
            └─ actions  (cond not referenced) [ "Delete class" danger + confirm,
                          value {classId} ]                                       (DA-2)
                        (cond referenced) context — the DA-7 line naming the references
accordion   block_id tax:new-class   label "New tax class"   default_open false    (L-8)
            └─ form  Class ID · Name        submit "Create tax class"
── L-9 fallback branch (>25 rows or a next page) ──
table       block_id tax:classes   Class ID (code) | Name
            page_action_id tax:page ; next_cursor when present
            empty_text "No tax classes yet."     ── plus the L-7 drill-in form,
                                                    and editing moves to a rate-level list ──

── LEVEL 1: a class's tax rates ──
header      "Tax rates — standard"
actions     [← Back to tax classes]   value { __path: encodePath([]) }
context     "Each rate applies to purchases shipping to one zone."                (≤140)
banner      (cond) notice
form        cf{"tax:rate-filter", {__path:encodePath([classId])}}
            1 field → INLINE, no accordion (L-2)
            select "Zone"  options {any, …zones}  initial_value filter.zoneId ?? "any"
                           ← was a free-text "Zone ID (blank = every zone)"; a closed set
                             from the listZones read this level already performs (D-6)
            submit "Apply filters"
section     (cond) filterSummary(["zone: us"]) + accessory button "Clear filters"
                   value { __path: encodePath([classId]) }             ← depth 1, REQUIRED
── the row list (L-9) ──
accordion   block_id "tax:rate:u1.<b64 {rateId}>"      default_open false
            label "std-us — United States · 7.25% · goods only"                   (D-6)
            ├─ form     cf{"tax:rate-save", {rateId, rateBps:"725",
            │                                  appliesToShipping:"false"}}  ← B-3 token
            │           Rate (%) · Applies to shipping (toggle, initial_value REQUIRED F-6b)
            │           submit "Save rate"                                        (DA-4)
            └─ actions  [ "Delete rate" danger + confirm, value {rateId} ]        (DA-2)
accordion   block_id tax:new-rate  label "New tax rate"  default_open false        (L-8)
            └─ form  Rate ID · Zone (select) · Rate (%) ·
                     Applies to shipping (toggle)        submit "Add tax rate"
── L-9 fallback: table  Rate ID (code) | Zone | Rate | Applies to shipping (plain text,
   NOT a badge — T-5, X-4) + drill-in ──
```

Notes: `limit: 500` at `tax-page.ts:271` and `limit: 200` at `:147` both exceed L-9's bound, so
**both branches ship on both levels**. The zone-name resolution already in place (`:380`
`r.zoneName ?? r.zoneId`, one `listZones()` per render) stays — that is the D-6-permitted single
extra read. Both `divider`s per level deleted (R-4). The page `context` drops 292 → ≤140 and the
level-1 `context` 268 → ≤200; the delete-blocked clause moves into DA-7's line.

### 12.4 Shipping (`shipping-page.ts`) — three list levels

Same per-row-accordion transformation as §12.3 at levels 0 and 1; level 2 is **exempt** (L-9a).

```
── LEVEL 0: zones ──                                                  (L-9 branch, limit 200)
header      "Shipping zones"
context     "A zone groups the methods you offer for a set of destinations."       (≤140)
banner      (cond) notice        ── no filter (0 fields) ──
accordion   block_id "ship:zone:u1.<b64 {zoneId}>"
            label "us — United States"     ← NOT "· 3 methods": ShippingZoneWire is
                                             {id,name,regions}; the count would cost up to
                                             200 extra reads per render (D-6). Filed, not
                                             fanned out.
            ├─ form     cf{"ship:zone-save", {zoneId, name, regions}}
            │           Name · Regions (comma-separated)   submit "Save zone"     (DA-4)
            ├─ actions  [ "View methods" → shipping:open
            │             value { target: encodePath([zoneId]) } ]                (§12.7)
            └─ actions  (cond no methods) [ "Delete zone" danger + confirm ]      (DA-2)
                        (cond has methods) context — DA-7 line
accordion   "New zone"  default_open false → form Zone ID · Name · Regions        (L-8)

── LEVEL 1: a zone's methods ──                                       (L-9 branch, limit 200)
header      "Shipping methods — us"
actions     [← Back to shipping zones]        ── no filter (0 fields) ──
context     "flat_rate always charges its rate; free_shipping charges nothing above its
             threshold."                                                          (≤140)
accordion   block_id "ship:method:u1.<b64 {methodId}>"
            label "standard — Standard (flat rate)"                               (D-6)
            ├─ form     cf{"ship:method-save", {methodId, name, type}}
            │           Name · Type (select: flat_rate | free_shipping)
            │           submit "Save method"                                      (DA-4)
            ├─ actions  [ "View rates" → shipping:open
            │             value { target: encodePath([zoneId, methodId]) } ]  ← FULL path,
            │                                                        never a bare id (§12.7)
            └─ actions  (cond no rates) [ "Delete method" danger + confirm ]      (DA-2)
                        (cond has rates) context — DA-7 line
accordion   "Add method"  default_open false → form Method ID · Name · Type       (L-8)
── L-9 fallback table: Method ID (code) | Name | Type ← `Type` keeps its badge: a 2-value
   closed set an operator distinguishes at a glance, and it is the level's only badge (T-5) ──

── LEVEL 2: a method's rates ── EXEMPT from L-9 (L-9a: `limit: 1`, a (methodId, currency)
   lookup returning 0 or 1 row). Keeps its inline form.
header      "Shipping rates — standard"
actions     [← Back to shipping methods]
context     "A rate is keyed by currency — one method can price differently per currency."
                                                                                  (≤140)
form        cf{"ship:rate-lookup", {__path:encodePath([zoneId, methodId])}}
            1 field → INLINE (L-2)   text_input "Currency (ISO-4217, e.g. USD)"
            submit "Apply filters"     ← was "Look up rate"; L-5 wants the standard verb
section     (cond) filterSummary(["currency: USD"]) + accessory button "Clear filters"
                   value { __path: encodePath([zoneId, methodId]) }    ← depth 2, REQUIRED
fields      (cond: the row exists)  block_id shipping:rate
              Currency | Amount
              Free-shipping threshold | Method
            ← a 0-or-1-row lookup is `fields`, not a 1-row table (P-3)
context     (cond: no row) "No rate set for that currency yet — use the form below."
form        (cond: the row exists) cf{"ship:rate-save", {methodId, currency,
                                        amountCents:"499"}}          ← B-3 change token
            Amount (up to 2 decimals) · Free-shipping threshold (optional)
            submit "Save rate"                                                    (DA-4)
actions     (cond: the row exists) [ "Delete rate" danger + confirm,
            value {methodId, currency} ]                                          (DA-2)
form        (cond: no row) block_id shipping:new-rate
            Currency · Amount · Free-shipping threshold (optional)  submit "Add rate"
```

All six `divider`s deleted (R-4). Page `context` 340 → ≤140; the two level `context`s 285 and 316 →
≤200. `Currency` stays a `code` column only inside the L-9 fallback tables, never a badge (M-2,
T-5).

### 12.5 Reports (`reports-page.ts`) — §4.1 skeleton

```
header      "<Store> — Reports"
context     "Revenue is net order totals on paid-and-later orders, bucketed by order time
             (UTC)."                                                    (≤140, from 191)
banner      (cond) the fail-closed error banner, variant "error"                  (E-1)
stats       max 4 items (R-16). Cards are the three currencies with the most **orders**, in
            descending order count; a fourth card "Other currencies (N)" carries value "—" and a
            description naming them, **because amounts in different currencies are never summed.**
            label "Revenue (USD)" · value formatMoney(cents, "USD", "en-US") · NO description
            ← ranking by revenue is NOT implementable: it would compare JPY minor units against
              USD minor units, and an aggregate "Other" card has no single currency to pass to
              formatMoney(amount, currencyCode, locale). Rank by order count instead.
            ← the `description: "integer minor units"` line is DELETED (M-1)
            (zero currencies ⇒ one card, label "Revenue", value "—",
             description "No orders in range")
accordion   block_id reports:revenue    label "Revenue by day (30 buckets)"
            default_open TRUE            ← the one open group (S-3)
            └─ table  block_id reports:revenue-table
                      Period (text) | Revenue (text, formatMoney)             2 columns
                      ← `Currency` badge column DELETED (T-5, M-2); when the range spans
                        several currencies, ONE table PER currency, each in its own
                        accordion labeled "Revenue by day (USD)". No chart (R-19, §2).
                        In that case the per-currency accordions REPLACE `reports:revenue` as
                        siblings; the first (highest order count) is default_open TRUE, the
                        rest false — S-3 still holds at exactly one open group.
                      page_action_id reports:page   // never fires
                      empty_text "No revenue in range."
accordion   block_id reports:statuses   label "Orders by status (6)"   default_open false
            └─ table  Status (badge) | Orders (number)   page_action_id reports:page
                      empty_text "No orders in range."
accordion   block_id reports:top        label "Top products (10)"      default_open false
            └─ table  Product | Qty (number) | Revenue (formatMoney)
                      page_action_id reports:page   empty_text "No sales in range."
accordion   block_id reports:low        label "Low stock (3)"          default_open false
            └─ table  SKU (code) | On hand (number)   page_action_id reports:page
                      empty_text "Nothing low on stock."
```

**Why no chart.** `chart` cannot format money (R-19): a timeseries renders raw minor units on the
axis and in tooltips, and plotting major units instead puts a display float on the money path,
which this document forbids (M-1/M-3). A formatted two-column table is correct and is not a
compromise.

**`page_action_id` must be registered as a no-op.** All four tables currently omit it
(`reports-page.ts:127-166`), violating the authoritative type (R-21). Adding it is not enough:
`admin-route.ts:110-127` dispatches `SETTINGS_ACTION_IDS`, `ORDERS_ACTION_IDS`,
`PRODUCTS_ACTION_IDS`, `TAX_ACTION_IDS`, `SHIPPING_ACTION_IDS` and `COUPONS_ACTION_IDS` — but
there is **no `REPORTS_ACTION_IDS`**, so a reports page action that ever fires falls through to
`:130`'s `{blocks: []}` — a blank console. Export
`REPORTS_ACTION_IDS = new Set(["reports:page"])`, dispatch it, and have the handler re-render the
page unchanged. Assert the blank-page case is gone.

**Register the ids in the SAME change as the `page_action_id`s, never after.** Nothing can fire
today — a sort needs `sortable` (forbidden, T-3) and a load-more needs `next_cursor` (never set on
these tables) — so this is a latent trap that arms itself the instant someone adds the id without
the registration.

Also: `divider` at `:124` deleted (R-4); the four `section` "headings" at `:125,136,146,157` become
the accordion labels above (P-2); the legacy `{variant, text}` banner at `:81-84` becomes
`{variant:"error", title, description}` (§2, M-9).

### 12.6 Settings (`settings-form.ts`) — §4.1 skeleton

Four bare forms become three accordions. `Service connection` holds **two** forms with two
submits — that is deliberate, because the two tokens are set independently and a combined form
would make saving one require re-entering the other.

```
header      "Settings"
context     "Display name is cosmetic; the rest is operational and lives in the service."
                                                                                  (≤140)
banner      (cond) notice, or the fail-closed error banner (variant "error")
accordion   block_id settings:store          label "Store"        default_open TRUE  (S-3)
            └─ form  cf{"settings:store", {displayName}}                         ← S-4
                     text_input  "Store display name"   initial_value <kv value>
                     submit "Save display name"          → save-display
accordion   block_id settings:checkout       label "Checkout & holds"  default_open false
            └─ context "These persist in the commerce service and affect live checkout."
                                                                                  (≤200)
               form  cf{"settings:ops", {holdTtl, lowStock}}                     ← S-4
                     text_input  "Cart hold TTL (minutes)"   initial_value "15"
                     text_input  "Low-stock threshold"        initial_value "5"
                     ← both were `number_input`; F-6 routes non-money integers through
                       text_input with one `/^\d+$/` parse. They are NOT money, so
                       `number_input` was not a violation — this is consistency, not a fix.
                     submit "Save operational settings"       → save-operational
accordion   block_id settings:connection     label "Service connection"  default_open false
            └─ context "Both tokens are stored write-only — a blank submit keeps the current
                        one. Neither is ever displayed."                          (≤200)
               form  cf{"settings:admin-token", {hasValue:"true"}}
                     secret_input "Admin token (X-Internal-Token)"  has_value <bool>
                     placeholder "Leave blank to keep current token"
                     submit "Save admin token"                → save-token
               form  cf{"settings:service-token", {hasValue:"true"}}
                     secret_input "Service token (X-Service-Token)"  has_value <bool>
                     submit "Save service token"              → save-service-token
               context (cond) "Admin token saved." / "Service token saved."
                       ← never the value (F-6)
```

Two defects this fixes beyond layout:

1. **The display-name save currently destroys the page.** `settings-form.ts:150-155` returns
   `[header, section]` — two blocks — so after saving the display name the operator's Settings page
   becomes a receipt and the other three forms vanish. Every save path returns the full
   `renderPage(...)` plus a `default` banner and the existing `toast` (S-5). The `section` receipts
   at `:152` and `:267` are deleted (P-2: a `section` is not a heading and not a receipt).
2. **All four forms need a carrier change token** (S-4, B-3, B-3a). Without it a saved value does
   not redisplay: the forms are mount-only `text_input`/`secret_input` (R-12), and once collapsed
   into an accordion each is its container's index-0 child (R-13a), so nothing remounts them.

The fail-closed branch keeps rendering **both** token forms (no bootstrap lockout) and gains the
`error` banner in the `{variant, title, description}` shape (M-9).

### 12.7 The button-in-row drill-in — required on Tax and Shipping

`View rates` / `View methods` are `button`s, so they carry no `block_id` (B-1) and are invisible to
`parseOpen`, which today reads `input.values` only (`tax-page.ts:124`, `shipping-page.ts:151`). A
button fires `block_action` with `value`, so `parseOpen` returns `undefined` and
`list-detail.ts:279` bounces the operator to `rootList()`. Two required changes:

1. The button carries **the full target path**, not a bare id:
   `value: { target: encodePath([...parentPath, id]) }`. At shipping's depth 3 a bare id is silently
   wrong — it resolves against the root.
2. Each screen's `parseOpen` reads **`input.value?.target` as well as `input.values?.target`**.

Assert a **depth-3 open fired from a button** (shipping zone → method → rates).

---

## 13. Anti-patterns — a reviewer rejects these on sight

**H** = mechanically enforced by `assertBlockContract` (§15); a rule without **H** is a human
review catch. **30 of the 46 rows are H — and `assertBlockContract` does not exist yet** (V-3a): it is
its own PR, and it **gates every screen after Orders** (§15.1 step 2). So if you are reading this while
building a screen, the helper exists and you call it. Only Orders predates it, and only Orders encodes
these rules as its own assertions.

| # | H | Reject | Rule |
|---|---|---|---|
| X-1 | H | A form field labeled with an internal name (`orderId`, `nonce`, `currency`, `expectedRateBps`, `Scope`, `Revision`, `Product`). | F-2, F-4 |
| X-2 | H | Any `select` with one option. | F-3 |
| X-3 | | A heading whose entire body is "No X" — heading + empty table for an empty collection. | P-3, D-7 |
| X-4 | H | A column of identical badges (`physical`, `USD`, `yes`, `manual`), or more than one badge column in a table. A badge column whose values are constant *within one rendered response* is the case the helper can see; a column constant only *in practice* is a human catch. | T-5 |
| X-5 | | A `disabled` field on any element (a compile error after the foundation), or a control rendered only to reject the click. | R-11, DA-7 |
| X-6 | H | Any `divider`. | R-4, §2 |
| X-7 | | An **expanded** filter form above the data, or any block above the primary data that P-1's whitelist does not list. | P-1, P-4, L-4 |
| X-8 | | A destructive form submit with no confirm, or a red button on an act outside DA-5's definition. | DA-1, DA-5 |
| X-9 | H | Money as raw minor units, or `number_input` / `format:"number"` on a money field or column. **Helper heuristic** (a helper cannot otherwise tell raw minor units from a legitimate integer): reject a cell or `fields` value matching `/^\d+$/` whose label matches `/amount\|total\|price\|revenue\|cost\|subtotal\|discount\|refund/i` **and does NOT match the count exclusion `/count\|recorded\|quantity\|qty\|items/i`.** Anything outside the heuristic is a human catch. | M-1, M-3, T-4 |
| X-10 | H | A money ladder in a `fields` block instead of a two-column `table`. | M-4 |
| X-11 | H | Any string over an **authored** §1 budget: page-level `context` 140, any other `context` 200, `banner.description` 240, `accordion.label` 60, `confirm.title` 60, `confirm.text` 200, `empty.description` 200. **Seven, not eight** — the `fields`-value 40 is explicitly **excluded** (X-11a). | §1 |
| X-11a | | A `fields` value over 40 chars **that the author wrote** — prose that belongs in a `context` line, or an address crammed into one entry. **Human catch only, never H:** the value is usually service data, so a 45-char buyer email or a tracking URL busts the budget through no authoring fault, and truncating a tracking number or URL destroys the operator's ability to copy it. Emails, tracking numbers, URLs and free-text reasons are left intact. | §1 |
| X-12 | | `header` used for a subsection beyond P-2's one-per-panel exception; `section` used as a heading or a receipt. | P-2 |
| X-13 | H | Timestamps with milliseconds; any timezone conversion. | M-6 |
| X-14 | H | `sortable: true` on any column. | T-3 |
| X-15 | H | Any `columns` or `chart` block. | §2 |
| X-16 | H | A conditionally-present `tab` panel; `default_tab` other than 0; a panel count differing from D-2's table. | D-3, D-4 |
| X-17 | H | A form without an explicit `block_id`; a context-carrying `block_id` with no `:u1.` segment; a prefilling form whose `block_id` did not come from `carriedForm`. | B-1, B-3, B-3a |
| X-18 | H | More than one `default_open: true` **per rendered response**. **Counted on the emitted JSON only.** A screenshot showing two expanded groups is **not** an X-18 finding: client-side open state survives a re-render with an unchanged `block_id`, so a group opened by an earlier response stays open through a response carrying `default_open: false` (B-5). | D-5, B-5 |
| X-19 | | A bare-noun accordion label where a count or total is available *on the wire the level already reads* (D-6). | D-6 |
| X-20 | H | The phrase "no oversell" / "oversold" / "overselling" in any **rendered string**. Code comments documenting the domain invariant are exempt and must not be changed. | voice |
| X-21 | | Apologetic degraded copy, or a raw status code / URL / exception in the UI. | E-4 |
| X-22 | H | An "Open X" picker whose option **labels** contain the record id, whose option **value** is not the record id, more than one per list, or **that is a `select` rather than a `combobox`** — a `select` puts the id in the trigger (R-17a). | L-7, M-7, R-17b |
| X-23 | H | A `select`/`radio`/`combobox` with no `initial_value`, an `initial_value` absent from `options`, or any option whose value is `""`. | F-6a |
| X-24 | H | A `toggle` with no `initial_value`. | F-6b |
| X-25 | H | A `meter` whose `value`/`max` are minor units and which has no `custom_value`. | M-8 |
| X-26 | H | `banner.variant` outside `default` \| `alert` \| `error`, or a banner with a `text` field. | M-9, §2 |
| X-27 | H | A `table` with no `page_action_id`, or with `next_cursor` inside a leaf detail. | T-6, T-8 |
| X-28 | H | An idempotency key or nonce anywhere in a form field, a carrier payload, or a `button.value`. | F-2a |
| X-29 | H | A DA-3 state-2 accordion that changes its `block_id` without `default_open: true`, or sets the flag without changing the id. | B-6 |
| X-30 | | A prefilling `combobox`; or a `combobox` used for a closed set of ≤8 **whose values are already readable words** — a **record picker is a `combobox` at any count** and is never an X-30 (L-7). | F-6, R-12a, R-17b |
| X-31 | H | More than 2 `banner`s at the top level of a screen (banners inside an accordion are not counted). | §2 |
| X-32 | | A handler that can return non-2xx or let an exception escape. | E-6 |
| X-33 | | A `condition` used to carry a field that is submitted but never drawn. | R-26, F-5b |
| X-34 | | **The N-1 catch.** A diff that follows a §11/§12 listing line against a §5–§10 rule or a §13 anti-pattern; **or** a correct deviation from a listing that the PR body does not disclose. Both are fails; the first ships a bug, the second leaves six teams to rediscover it. | N-1 |
| X-35 | H | A destructive `accordion` whose label is a bare verb or noun (`Cancel order`, `Delete zone`, `Refund a different amount`) with no consequence clause. | D-6a |
| X-36 | H | A D-6 label containing a degenerate ratio — `$0.00 of $0.00`, `0 of 0`, `0%` of nothing. | D-6b |
| X-37 | H | **More than 4 `style:"danger"` buttons in one `actions` block**; or a DA-2c fan-out whose `confirm` lost its `style:"danger"` along with the button's. | DA-2c |
| X-38 | H | A DA-2b/DA-3 `button.value` carrying no watermark, or a confirm handler that writes without re-reading. Countable on the payload; the re-read is asserted by the screen's own stale-watermark test. | DA-2a, DA-3a |
| X-39 | H | A DA-3a or DA-3c refusal that does not re-render **the same group**, forced open per B-6, with the submitted values prefilled and **flattened onto that group**. Assert the refused response's open-group id equals the staged group's, the form's `initial_value`s echo the submission, and the nested collect-group is absent from the response. | DA-3a-i |
| X-40 | | A `-review` handler that validates only parseability — no bound check against the live ceiling. | DA-3c |
| X-41 | H | A `context` or `banner` line containing `deliberately`, `there is no`, or `we do not`; a DA-7 line with no actionable verb. | DA-7a, E-4 |
| X-42 | H | A fail-closed banner that names a single cause (`Could not reach the commerce service`) rather than E-7's normative copy. | E-7 |
| X-43 | | A `Total` rendered on the same screen as a smaller `Captured`/`Settled`/`Allocated` with no M-11 line; or a bare `Remaining`/`Available`/`Left` label. | M-11, M-11a |
| X-44 | | A T-8 cap `context` line emitted when the read was **not** truncated. | T-8a |
| X-45 | | A split form set (F-5a) with **no** panel-level sibling-discard `context` line, or that line repeated inside each form's group instead of appearing once above them. Also: any PR that justifies the sibling-discard hazard by claiming the groups are collapsed — open state is sticky (B-5), which is why F-5a-i requires the line. | F-5a-i |

---

## 14. What a fork change would simplify (not required by this spec)

Tracked follow-ups against `/home/azureuser/emdash-fork`, branched from freshly-synced `main`,
commit author `Vedanshu <vedanshu@urumi.ai>`, upstream PR template. **Nothing in this document
depends on any of them** — every rule above is satisfiable on 0.31.1 as pinned.

1. **A mid-level heading — `header.level?: 2|3` or `section.style?: "heading"`.** The
   **highest-leverage** change for this console. There are exactly two text weights (R-5), so a tab
   panel becomes a stack of grey accordion triggers with no visual hierarchy between them. The
   research in §0 names the missing mid-level heading as the single biggest cause of the flat look,
   and P-2's "at most one `header` per panel" exception exists only because this is missing.
2. **`TableBlock.row_action_id`** (R-7). Would delete every "Open X" form (L-7) and every
   button-in-row drill-in (§12.7), and let registry levels stay real tables with drillable rows
   instead of accordion lists — which would in turn retire L-9's dual-branch requirement.
3. **Make `select` render its option *label*** — pass `items={element.options}` (or `renderValue`)
   in the fork's `elements/select.tsx`, and add `placeholder` to `SelectElement`. **Two distinct
   defects, and they need different fixes:** `placeholder` fixes only the *empty* trigger; the
   *wrong text* — the raw value instead of the label (R-17a) — needs `items`/`renderValue`. Kumo
   2.6.0's `Select` already accepts both props, so this is a small fork change and a **fork PR is
   being raised separately**.

   **Downgraded in revision 4.** Revisions 1–3 valued this item on the claim that the order picker's
   trigger reads a raw UUID. It does not — the picker is a `combobox`, which already passes `items`
   and already renders the label (R-17b), and it already has a `placeholder`. So this item's real
   scope is `select` **only**, its worst live instance is the cancellation reason reading
   `customer_request`, and F-6c makes that tolerable indefinitely. Still worth having — it would let
   `select` carry ids and retire F-6c — but it blocks nothing and should not be sequenced ahead of
   items 1 or 2.
4. **`"tab"` in `validateBlocks`' `BLOCK_TYPES`** (R-15 — re-verified absent in 0.31.1). One-line
   fix; the type, builder and renderer already exist. Without it, any validation of these blocks
   reports `Unknown block type 'tab'` even though the page renders correctly.
5. **A clickable link — `format:"link"` on a table column, or a `link` element.** A tracking URL is
   the one value on these screens whose entire purpose is to be followed, and the vocabulary can only
   render it as text the operator selects and copies. That is a **renderer limit, not an authoring
   error**: do not "fix" it by shortening the URL (X-11a) or by dropping the field. Until this lands,
   a tracking URL renders in full, in `fields`, and the group's label carries the tracking *number*.

A sixth would be nice but is not needed: **`Badge` variants** driven by a per-column value map
(R-6), which would let a status column encode severity instead of just chunking text. Until then,
T-5's "one badge column, lifecycle state only" is the correct discipline.

Two upstream nuisances are recorded here rather than tracked as items, because neither affects
rendered output: `ComboboxList` emits a React duplicate-key warning even when every option value is
unique (upstream, not ours — a candidate follow-up alongside the five above), and the EmDash admin
does not honour Playwright's `fullPage` (the content region clips at the viewport, so screenshot with
a **tall viewport** — 1440×1800/2200 — not `fullPage` alone).

---

## 15. Verification — how these rules are actually enforced

The plan's premise that the sandbox suites "assert by type, so they survive re-layout" is **true
for reordering and false for nesting.** Every search is flat over the top-level array (e.g.
`blocks.filter(b => b.type === "form")`) while `BlockRenderer` recurses into
`columns`/`tab`/`accordion` children (R-25). The moment the order detail moves into
`tab > accordion`, those searches return `undefined`/`[]` and the suites pass while asserting
nothing.

**Measured blast radius** (counted 2026-07-29; flat type searches matched on
`\.(filter|find|some)\(\s*\(?\w+\)?\s*=>\s*[\w.]+\.type\s*===`):

| Screen | Suite | Lines | Tests | Flat type searches | `section`-as-heading assertions | Carrier/nonce/id assertions |
|---|---|---|---|---|---|---|
| Orders | `orders-page.sandbox.test.ts` | 1541 | 40 | **89** | **17** | **14** |
| Shipping | `shipping-page.sandbox.test.ts` | 902 | 31 | 18 | 0 | 3 |
| Products | `products-page.sandbox.test.ts` | 783 | 22 | 23 | 0 | **7** |
| Tax | `tax-page.sandbox.test.ts` | 653 | 21 | 9 | 0 | 3 |
| Coupons | `coupons-page.sandbox.test.ts` | 1029 | 26 | 5 | 0 | **6** |
| Reports | `reports-widget.sandbox.test.ts` | 148 | 3 | 3 | 1 | 0 |
| Settings | `settings-widget.sandbox.test.ts` | 268 | 7 | 4 | 0 | 0 |

**There is no `reports-page.sandbox.test.ts`.** Reports and Settings are covered by
`reports-widget.sandbox.test.ts` and `settings-widget.sandbox.test.ts`. Orders is the outlier on
every axis and the only screen using `section` blocks as headings — which is exactly why it is the
reference screen and why V-2 exists.

**V-1 — the shared block-search helpers live in `packages/plugin/test/helpers/blocks.ts`.
Owner: Orders — DELIVERED.** Revision 3 assigned this file to the foundation; PR #151 did not ship it
and the Orders implementer wrote it instead (§0.2 E-r). It exists on `feat/admin-orders-layout`
(commit `aa2bd97`) and exports rather more than the three below — `allBlocks`, `findBlock`,
`panelLabels`, `groupBlocks`, `openGroupIds`, `formFor`, `fieldEntries`, `contextTexts`, `buttons`,
`confirmOf`, `tableRows`, `columnLabels` and others. **Read it before writing your own** — six teams
hand-rolling `blocksOf` is how the flat-search problem started.

The three that every suite needs:

- `findBlocks(blocks, type)` — recurses through `columns.columns[]`, `tab.panels[].blocks` and
  `accordion.blocks`, mirroring `renderer.tsx` exactly.
- `panel(blocks, label)` — resolve a `tab` panel by its visible label. Panel labels are static
  (D-2), so this is safe.
- `group(blocks, blockId)` — resolve an `accordion` by its **`block_id`**, never its label. D-6
  makes accordion labels deliberately dynamic (`Refunds — $0.00 of $99.00 refunded`, `Notes (0)`),
  so a label-keyed lookup would hard-code formatted money into every test and break on any figure
  change. `block_id` is stable and semantic by B-5, which is exactly what a test should key on.

**V-1a — each screen ports its OWN suite, as the first commit of its own PR.** `blocksOf()` is
duplicated in **six** suites (`admin-scaffold-list-detail`, `settings-widget`, `coupons-page`,
`products-page`, `shipping-page`, `tax-page`) and **all six are still unported.** Revision 3 said "all
six switch"; Orders correctly ported only its own and flagged the rest (§0.2 E-r), because `CLAUDE.md`'s
one-PR-one-thing beats V-1's literal wording and absorbing five foreign suites into a layout PR makes
it unreviewable.

So the rule is per-screen and it is a **sequencing** rule, not a cleanup wish:

> Every screen's PR opens with a **behaviour-free commit** porting that screen's suite onto
> `findBlocks`/`panel`/`group`. `git diff` over `packages/plugin/src` must be **empty** for that
> commit, and the same test count must pass before and after.

A flat search is safe *today* on a screen that is still flat, and returns `[]` silently the moment
that screen is re-laid — which is the failure mode where the suite passes while asserting nothing.
Porting after the re-layout means you never see the port pass against the old tree.

**Your PR ports your suite and nobody else's — §15.1 step 3 is four PARALLEL lanes.** Do not plan on a
predecessor's port having landed: you have no predecessor. `admin-scaffold-list-detail` is not a screen;
it ports with whichever lane touches the scaffold first, and the other lanes must not assume it has.

**V-2 — Orders' suite is rewritten onto these helpers BEFORE its layout changes**, as a separate
**no-behaviour-change commit**, so the layout diff stays reviewable. 89 flat searches and 17
section-heading assertions cannot be reworked in the same commit as a re-layout and still be
reviewed. *Done in PR #161 (`aa2bd97` → `3c7f037`); V-1a generalises it to the other six.*

**V-3 — one shared `assertBlockContract(blocks, { screen, level })`** in
`packages/plugin/test/helpers/`. The two extra arguments are not optional: **X-16** cannot be
decided from the blocks alone (it must compare the panel set against D-2's per-screen table) and
**X-27**'s second half cannot either (it must know whether this response is a leaf detail). It
enforces every rule marked **H** in §13 (**30 of 46**), the **seven** authored prose budgets (not the
`fields`-value 40 — X-11a), and the banned phrase. Every page suite calls it once per rendered
response. **A rule not in that helper is advisory** — it is a human review catch, and a PR that only
runs the helper has not verified the non-**H** rules.

**V-3a — V-3 DOES NOT EXIST YET, and it is NOT written by a screen. It is its own PR.** This is the
programme's real gap: **30 H-marked rules are currently enforced by nothing shared.** Orders hand-rolled
equivalents as ordinary assertions, so the **banned-string guard is Orders-only** — and the two live
X-20 violations are on **Products** (§12.1). Terms:

| | |
|---|---|
| **Owner** | **Its own `[Plugin]` PR.** No per-screen PR may carry it. Shared test infrastructure bolted onto a layout diff is exactly the drive-by `CLAUDE.md` forbids, and — the general form of it — **no screen should write the thing that judges it.** |
| **Sequencing** | **After** the Orders increment merges (it builds on `test/helpers/blocks.ts`, which Orders delivered) and **before any further per-screen increment starts.** See §15.1 — it is step 2, and it gates every lane below it. |
| **Must hoist** | The X-20 banned-phrase guard (currently Orders-only), X-11's seven budgets, X-9's heuristic **with its count exclusion**, and every H row added in revision 4 (X-35..X-42). |
| **Signature** | `assertBlockContract(blocks, { screen, level })` — as above, unchanged. |

**Why the gate is hard and not a preference.** Step 3 of §15.1 is **four concurrent lanes**. If the
helper landed after them, four screens would each hand-roll 30 checks and all four would need
retrofitting — the same duplication V-1a exists to stop, one level up and four times over. Sequencing it
ahead also removes any "which screen is second?" question: the deadline is decidable without an ordering
among the lanes.

**Until it lands, only Orders is in flight**, and Orders already encodes the H rules as its own
assertions and says so in its PR — which is what tells V-3's author what to absorb. Nothing else starts,
so there is no second screen that needs an interim rule. Do not claim an **H** rule verified because it
"reads right".

### 15.1 Increment order — where your screen sits

The order the programme is actually run in. It is **not** a suggestion; step 2 is a gate. (The plan's
increment numbers map on as 3 · 3a · 5 · 5-last — see
[`plans/admin-ui-density-cleanup.md`](../../plans/admin-ui-density-cleanup.md).)

| Step | What | Concurrency |
|---|---|---|
| 1 | **Orders** — the reference screen (PR #161) | in revision |
| 2 | **`assertBlockContract`** — its own `[Plugin]` PR (V-3a) | **gates everything below** |
| 3 | **Coupons** · **Tax** · **Shipping** · **Reports + Settings** | **four PARALLEL lanes** |
| 4 | **Pricing & inventory** (`products-page.ts`) | after the four lanes |

Three things to read off this table:

- **Step 3 is genuinely concurrent.** Four lanes, no ordering among them, no lane a predecessor of
  another. If a rule here reads as though it assumes a serial order, it is a defect (N-1).
- **Nothing in step 3 may start before step 2 merges.** That is the whole reason step 2 is a step and
  not a chore folded into a screen.
- **Products is last on purpose**, and it is where the helper's banned-phrase guard is first pointed at
  something real — both live X-20 violations are there (§12.1). Being judged by the helper is a
  different job from writing it.

**V-3b — two wire-shape facts a suite gets wrong silently.** Both cost an afternoon and neither
fails loudly:

- **Drive a form submit with `values` PLUS the form's own `block_id`.** Every identity now rides
  there (B-1), so a test that submits `values` alone exercises a wire shape the renderer never sends
  — and the handler decodes `undefined` context and takes a DA-3b branch. `submitForm` in the shared
  helper does this; use it.
- **`carriedForm` is the LAST thing applied to a filter form.** `filterPanel` recomputes the prefill
  digest and throws on an absent *or* stale one (§0.1 D item 1), and that throw surfaces as your
  screen's **fail-closed banner** — the same banner as an unreachable service. So when a screen
  fail-closes for no apparent reason, suspect your own composition order first and read the worker
  log. E-7's copy exists precisely because this failure looks like an outage.

**V-4 — three verification tiers. State which tier a claim rests on; do not blur them.**

| Tier | What it covers | Gate |
|---|---|---|
| 1 — JSON-checkable | Budgets, vocabulary, §5/§6/§7/§9, and §10's invariants expressed as *"the token changed / did not change between these two responses"*. Includes: a DA-3 state-2 accordion carries **both** a changed `block_id` and `default_open: true`; the filter **accordion**'s `block_id` is identical across an apply *and* across `Clear filters`, while the filter **form**'s `block_id` differs after an apply **and** after `Clear filters`, whenever the prefilled values changed; a depth-3 open fired from a `button`; a service-offered transition outside `ORDER_STATES` renders no button; an L-9 level branches to accordions at 25 rows and to a table at 26. | the workerd-on-Node sandbox suite |
| 2 — renderer behaviour | B-4, B-5, B-6, D-3, R-13a — claims about what React does with a key. One test each in the fork's `packages/blocks/tests/`, cited in the PR. | fork test suite |
| 3 — density and appearance | P-1..P-4, F-6a's non-empty triggers (per-control, per its table), §16's residual flatness, DA-2c's fan-out **emphasis** (the button row's weight, not its height), D-6a's labels next to their buttons. **Screenshot only.** Nobody may claim these verified from a passing suite. **Nothing runs the other way:** a screenshot is not evidence for a tier-1 claim, and specifically not for X-18 (see its row — open state is sticky). | attached screenshot |

---

## 16. What will still read flat after all of this

Four things survive this overhaul. They are stated here so they do not surface as a surprise at
screenshot review.

1. **There is no mid-level typography.** Only `header` (`h2 text-xl font-bold`) and plain body text
   exist (R-5). A tab panel with four accordions is a stack of four grey trigger rows of identical
   weight; the labels carry all the hierarchy there is, which is exactly why D-6 makes them carry
   the answer. Until §14 item 1 lands, **sub-structure reads as trigger rows** — a renderer limit,
   not a layout failure.
2. **Tables have no alignment and no row click** (R-7). Money in the final column (T-2) is the only
   alignment lever, and every list needs a separate drill-in control (L-7, §12.7). Numbers will not
   form a right-aligned edge.
3. **A `select` shows the option's raw *value*, not its label, and that does not change here.** F-6a
   removes every **blank** trigger without a fork change — but it cannot make a `select` trigger read
   the label, because the pinned renderer never can (R-17a). So after this work the Orders status
   filter reads `any`, the cancellation reason reads `customer_request`, coupons' type reads
   `fixed_amount`, and the tax-class select reads a bare class id. A real but small wart; F-6c keeps
   it tolerable by constraining values to words, and §14 item 3 removes it.

   **This item is smaller than revisions 1–3 claimed, and the correction matters.** They named "the
   order picker reads a raw UUID" as the worst instance on these screens. **It does not** — the picker
   is a `combobox`, which renders the option **label** and has a real placeholder (R-17b), so it reads
   `Choose an order…` closed and `maya.iyer@example.com · $95.00 · processing` selected. That was
   verified in a browser, not inferred. Nothing here reads as an id after L-7, and the residual
   flatness is four readable lowercase words in four triggers.

4. **A tracking URL is not clickable.** The vocabulary has no link (§14 item 5), so the operator
   selects and copies. Do not shorten it to satisfy a budget — X-11a exists for exactly this value.

None of the four is a reason to delay: each per-screen increment is a strict improvement on what
ships today, and all four are tracked.
