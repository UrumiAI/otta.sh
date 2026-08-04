# Otta admin console — design spec

Status: **normative** (2026-07-30, revision 4, plus four amendments. **(1)** DA-3a-ii is **replaced**
and DA-3a-iii added, because the scaffold gained a render-state channel in `ce5eecb` and
revision 4's DA-3a-ii said it had none. **(2)** Four rules kept their requirements and had their
**stated reasons** corrected, each having confused the emitted response with what the operator sees:
**D-5** and **X-18** are scoped explicitly to the emitted response — a screenshot showing two open
groups is not an X-18 finding; **DA-2c** is restated on emphasis grounds, its "~1100px" geometry
being wrong (`actions` is one horizontal row); **F-5a-i** is new, because F-5a's sibling-discard
hazard may no longer be excused as "realistically one group is open" — open state is sticky, so a
split form set must carry a `context` line saying so (X-45); and **DA-3**'s outermost-group rule
keeps its wording but drops "the confirm is invisible", which was checkably false, for the real
ground: a response must not depend on client state it did not set. **(3)** Three practices the
reference screen's engineer added beyond their brief are promoted to rules — **DA-3a-iv** (an absent
watermark refuses), **DA-3c-i** (a `-review` that renders a watermark-bearing confirm re-reads first)
and **DA-3a-v**/**DA-3a-vi** (what a refusal body may and must contain) — and one **accepted
limitation** is recorded as **B-8**: *you cannot close a group*, so two visibly-open groups after a
refusal are permanent and must not be "fixed". §0.3 collects that limitation and two accepted trades;
§15.2 is the eight-item list of what a following team predictably gets wrong. **(4)** **F-2b** and
**X-52** are new — *a field another system owns is displayed, never given an input, and its label
names the owner* — because "one home per field" PR 1c made the product title CMS-owned
([ADR-0013](../../adr/0013-product-title-is-cms-owned.md)); `active`/Status was always this shape
and is folded in as F-2b's second instance. The Pricing & inventory listing's Identity accordion,
empty state and picker format were corrected to match.) Applies to the **five** Block Kit admin screens under
`packages/plugin/src/admin/` — Coupons, Tax, Shipping, Reports and Settings — whose page loads are
dispatched at `admin-route.ts:114-128` and whose actions at `:135-149`. (It governed seven until
ADR-0015; see the sixth amendment below.)

**Fifth amendment — the 2026-08-01 docs sweep.** Twenty-four increments have now been built against
this document, and this pass reconciles it with what they shipped. Nothing here is new design: every
edit states what the code does and cites it. **Six rules were deliberately overridden during the
build and now record the ruling AND its reason, not just the new state** — **T-1a** (Coupons ships
six list columns), **D-6c** (the shipping methods level fans out one rate read per row, bounded at
25), **T-5** (no status column is a badge; one badge column survives console-wide), **T-2a**
(identity-first yields where the identity is an opaque id), **L-8** (create is a `primary` button
above the data with its form on a drill-in screen, not a bottom accordion), and **S-3** (Settings
opens zero groups; the cap binds, the floor is gone). Four further corrections retire claims that
had become false: `assertBlockContract` **exists** (§13, V-3a); the two live X-20 violations on
Pricing & inventory are **fixed**; §15's tier-2 gate no longer asks for a test in a repo
this project cannot write to; and §14's heading no longer offers a fork as the route its own body
rules out. **Two screens — Orders and Pricing & inventory — now render from
`@otta-sh/admin-react`** (ADR-0014); at the time of that sweep their Block Kit twins were still in
the tree, and where a listing described both, it said so. The sixth amendment records that they are
no longer.

**Sixth amendment — the Block Kit retirement ([ADR-0015](../../adr/0015-retire-duplicated-block-kit-screens.md), 2026-08-03).** The Block Kit Orders and
Pricing & inventory screens have been **deleted** — `orders-page.ts`, `products-page.ts`, their
descriptor entries, their dispatcher branches and their two sandbox suites are gone, and their write
paths were re-implemented as structured, block-free actions in
`packages/plugin/src/admin/orders-actions.ts` and `products-actions.ts`, which the React console
calls directly. Consequences for **this document**, all of them mechanical — no rule changed its
requirement here:

- **§11 (Worked example — Orders) is deleted.** The rules whose only worked example it was now state
  their requirement in §5–§10 with no example. Where such a rule has **no live instance on any
  surviving Block Kit screen and none planned**, its own text says so rather than implying one:
  **DA-2b**, **DA-2c**, **DA-3**, **DA-3c**, **DA-3c-i**, **DA-3a-v** and **DA-3a-vi** all describe
  shapes only the two retired screens ever built. They still bind the day a screen builds one.
- **§12.1 (Pricing & inventory) is deleted.** §12.2–§12.7 are unchanged and never depended on it.
- **Section numbers are NOT reflowed.** §12–§16 keep their numbers and **§11 is retired rather than
  reused** — the cross-references of the form "§14 item 2", "§12.7", "§13 X-20" resolve today and
  renumbering would move all of them to buy nothing.
- **Citations into the two deleted modules are retargeted where the code survives** — it was
  extracted, not deleted — and **removed where it does not.** The `-review` pair and the checks that
  lived only on it were not ported; ADR-0015's two 2026-08-03 amendments are the record of exactly
  what went with them.
- Orders and Pricing & inventory are still **real screens**. They are React (ADR-0014) and this
  document does not govern them. Where a rule below names one of them it names it as history, or
  names a shared constant both surfaces read.

## Verification basis — read this before citing a renderer fact

`origin/main` pins **emdash 0.31.1** exact (`sites/staging/package.json`). Resolve versions and
read `node_modules` from a worktree off `origin/main` — several long-lived branches still carry a
0.29.0 lockfile, and an earlier revision of this document was written against one of them.

Everything below was verified two ways, from two different sources:

1. **Types and the validator**, from the installed 0.31.1 package in `node_modules`:
   `node_modules/.pnpm/@emdash-cms+blocks@0.31.1_*/node_modules/@emdash-cms/blocks/dist/validation-5vL6669b.d.ts`
   (authoritative types) and `validation-Dq-a7CXm.js` (the compiled validator). The published
   package's `files` field ships `dist` only — no `.tsx` sources — so this is as far as
   `node_modules` alone can verify a claim.
2. **Every renderer**, from the public upstream `emdash-cms/emdash` source tree at git tag
   `@emdash-cms/blocks@0.31.1` (a clean checkout of `github.com/emdash-cms/emdash` at that tag —
   **not** a fork checkout, and not dist). This is the source the pinned dist compiles
   from, so its line numbers are authoritative for the installed 0.31.1. Every `*.tsx:NN`
   citation in this document traces here.

**The 0.29.0 → 0.31.1 delta is nothing.** `diff -rq` over the two installed `dist/` trees is
**empty** (the content-hashed filenames are even identical) — the block renderers did not change
between the two tags, so a citation against either upstream tag is valid for both.

Under D1 a **local fork checkout is out of scope for this console**, and any local clone left at an
older tag (0.15.0 is ~530 commits behind) is stale — **neither is a citation source.** Cite the
public upstream tree at the pinned tag, as item 2 above specifies. Do not send a team diffing
against the 0.29.0 tag — the repo no longer uses it.

**Resolve a plugin-source citation by the surrounding IDENTIFIER — the function or constant named
beside it — and treat the line number as a hint.** Screen modules and the scaffold move; `scaffold/`
in particular has been re-commented repeatedly, so a `list-detail.ts:NNN` below may be tens of lines
out while the named function is exactly where the sentence says it is. A citation that names no
identifier and resolves to nothing is a defect — report it. **Renderer citations are the exception
and are stable**: they are to the pinned 0.31.1, per item 2 above.

**How to use this document.** Rules are numbered (`P-1`, `L-3`, `T-5`…). A reviewer cites the
number and marks pass/fail against the diff. Every rule here is decidable by reading the diff or
by running the shared assertion helper (§15); no rule requires a judgment call. If one seems to,
it is a defect — file it, don't improvise.

---

## ⚠ PRECEDENCE — the rule beats the listing. Read this before §12.

This document has **two normative layers**: the **rule tables** (§5–§10, §13) and the **per-screen
listings** (§12). They are not always consistent, and this is the single rule that decides what
to do when they are not:

> **N-1.** Where a §12 per-screen listing conflicts with a §5–§10 rule or a §13
> anti-pattern, **the rule wins**, and the listing is a **defect to be reported** in the
> implementing PR — not silently followed, and not silently deviated from.

**Why this is rule number one.** Revision 4 exists because the first screen built against revision 3
shipped four substantive defects and **three of them came from following a per-screen listing that
contradicted a rule** (the Orders listing, since retired with §11). That is the correct instinct — a
listing written *for your screen* is more specific than a general table — and it happened again on
the screens that followed. N-1 does not ask you to spot the contradiction; it tells you what to do
the moment you feel one.

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
**There is no live violation on any screen** — the console's last two were the Pricing & inventory
strings *"(no overselling)"* and *"it can never be oversold"*, replaced before that screen left
Block Kit by the shared `BACKORDERS_CONTEXT` constant
(`admin-presentation/src/products-copy.ts:221-222`). X-20 is a regression gate from here.
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
| R-7 | `table` cells carry only `px-3 py-2`: **no alignment, no width control, and `<tr>` has no click/link handler** — rows handle only column sort and load-more. | `blocks/table.tsx:98-106` | Every list needs an explicit drill-in control, and "money in the last column" is the only alignment lever there is. Unreachable on Block Kit; see §14 item 2. |
| R-8 | A sortable header fires `page_action_id` with `value:{sort}` and **no `cursor`**; it does send `block_id`. | `blocks/table.tsx:52-57` | Pre-foundation this decodes to `null` and resets to the unfiltered root list. Post-foundation the `page` fallback is `renderPath(readNavPath(input) ?? [])`, so a sort click **keeps the drill path** and loses only the filter and the sort itself. Either way `sortable` stays forbidden (T-3). |
| R-9 | `table` with 0 rows **and** `empty_text` renders one centered muted line — no header row, no table chrome. | `blocks/table.tsx:69-71` | `empty_text` is already cheap. It is the default empty treatment. |
| R-10 | `form` has no `confirm`. Only `button` does. | types `ConfirmDialog`, `elements/button.tsx:48-66` | A destructive act must be triggered by a button (§8). |
| R-11 | `ButtonElement` has **no `disabled`**, and neither do `text_input`/`number_input`/`select`. Otta's mirror declared it **four times** (`types.ts:157,165,179,207`); no renderer reads it. | `elements/*.tsx` (grep: nothing) | `disabled` was a phantom — a "disabled" control rendered fully live. The foundation **deletes all four**, so after PR #151 a `disabled` button is a **compile error**, not a review catch. |
| R-12 | **Mount-only** (value read once, at mount): `text_input`, `number_input`, `select`, **`toggle`**, `secret_input`. **Effect-synced**: `combobox`, `date_input`, `checkbox`, `radio`. | `elements/text-input.tsx:42`, `number-input.tsx:45`, `select.tsx:33`, `toggle.tsx:15`, `secret-input.tsx:15`; `combobox.tsx:22`, `date-input.tsx:16`, `checkbox.tsx:17`, `radio.tsx:17` | The server cannot repopulate a mounted mount-only control. Refreshing a form's prefill requires a **remount** (§10, B-3). |
| R-12a | The effect-synced four resync their **own display state only** — the `useEffect` calls `setValue`/`setSelected` and **never `onChange`**, while `form.tsx:44-46` seeds `values` once at mount. | `combobox.tsx:22-24`, `date-input.tsx:16-18` | After a re-render the operator **sees the new value and submits the old one** (or nothing, if the field had no `initial_value` at mount). A silent display/submit divergence, strictly worse than "cannot refresh" — it is why F-6 restricts `combobox` to non-prefilling fields. |
| R-12b | `form.tsx:27-35` seeds `values` **only** from fields that declare an `initial_value`. | `blocks/form.tsx:30` | An untouched control with no `initial_value` is **absent from `values`**, not defaulted. A handler doing `Boolean(values.x)` on an untouched `toggle` silently writes `false` (F-6b). |
| R-13 | `BlockRenderer` keys children by `block.block_id ?? index`; `actions`/`empty` key elements by `action_id ?? index`; `form` keys fields by `action_id`. | `renderer.tsx:78`, `blocks/actions.tsx:14`, `blocks/empty.tsx:18`, `blocks/form.tsx:68` | Block state (form values, accordion open, active tab) persists while the key is stable. Duplicate `action_id`s in one `actions` block collide — that, not a renderer bug, is why the transition buttons were split one-per-block. |
| R-13a | A block nested inside `accordion`/`tab`/`columns` is keyed by its index **within that container's own `BlockRenderer` call**. | `blocks/accordion.tsx:20` → `renderer.tsx:78` | A sole child of an accordion is `block_id ?? 0` — index **0 forever**. The incidental remount a top-level block gets when a banner is prepended and shifts indices **does not happen inside a container**. This is why B-3a exists. |
| R-14 | `tab` keeps `activeTab` in local state and renders `panels[activeTab]?.blocks ?? []`. | `blocks/tab.tsx:14,26` | If the panel count shrinks between renders while the tab block's key is stable, the operator sees a **blank panel**. The panel set must be constant (§4, D-3). |
| R-14a | `accordion` reads `default_open` **once**, at mount: `useState(block.default_open ?? false)`. | `blocks/accordion.tsx:14` | A changed `block_id` remounts the group — and the remount **re-reads `default_open`**. Forcing a group open therefore needs **both** (§10, B-6). |
| R-15 | `validateBlocks` does **not** include `"tab"` in `BLOCK_TYPES` — all 17 others are there. Re-verified on the installed 0.31.1. | `validation-Dq-a7CXm.js:325-343` | Runtime is unaffected (`validateBlocks` is exported but invoked nowhere in the runtime or admin app), but any test or tool that validates reports `Unknown block type 'tab'`. No upstream PR is filed under D1; see §14 item 4. |
| R-16 | `stats` is a non-wrapping `flex` row of bordered cards; `empty` always uses a fixed Package icon; `code` renders a syntax-highlighted snippet. | `blocks/stats.tsx:34`, `blocks/empty.tsx:25`, `blocks/code.tsx` | `stats` max 4 items; `empty.command_line` is never appropriate here; `code` has no use on these screens. |
| R-17 | `SelectElement` has **no `placeholder`**. Re-verified on the installed 0.31.1. | types `SelectElement` | Nothing can be shown in an unresolved trigger. No fork exists to fix it; see §14 item 3. |
| R-17a | **The `select` trigger — and only `select` — renders the raw resolved *value*, never the option label, and renders empty when that value is `""`, `null` or absent.** `select.tsx:30-42` passes the options as **children** and passes no `items`, `placeholder` or `renderValue`. Kumo 2.6.0 wraps **Base UI** (`@base-ui/react ^1.5.0`; 1.6.0 installed), **not Radix**. With `items === undefined`, Base UI's `SelectValue` falls through to `resolveSelectedLabel(value, undefined, undefined)` → `stringifyAsLabel` → `serializeValue(value)`, i.e. the value string; and its `hasSelectedValue` selector treats `""` as "no value" exactly as it does `null`/`undefined`. | `elements/select.tsx:30-42`; `@base-ui/react/select/value/SelectValue.js:41-58`, `internals/resolveValueLabel.js` (`resolveSelectedLabel`), `select/store.js:20-32` | This is the **real** cause of every blank select — not an unresolvable `initial_value` and not the `""` option value; both earlier diagnoses were wrong. Kumo's own `Select` *does* accept `renderValue`/`placeholder`, but with no fork there is no path to change it (§14 item 3). Two consequences: F-6a's rules remove the blank, and F-6c — a `select`'s option **value is operator-visible**. Scope this to `select`: `combobox` behaves differently (R-17b), and `radio` renders each option's label as its own row caption. |
| R-17b | **`combobox` renders the option LABEL, and it has a real `placeholder`.** `combobox.tsx:50-52` passes `items={element.options}` **and** a whole-option object as `value`, so Base UI resolves a label instead of falling through to `serializeValue`; `Combobox.TriggerInput` takes `element.placeholder ?? "Search..."`; and an `initial_value` that matches no option resolves to `null` (`:16-19`), which shows the placeholder rather than a blank 36px box. `ComboboxElement` declares `placeholder?: string` (`types.ts:82-89`); `SelectElement` does not (R-17). | `elements/combobox.tsx:16-19,50-52`; upstream `types.ts:82-89` | **This is the correction that matters most in revision 4.** Revisions 1–3 said selects show the raw value and named "the order picker reads a raw UUID" as the worst instance. That wart **does not exist** — every L-7 picker is a `combobox`, and the surviving one reads `SUMMER25 · 20% off · 3 uses` (`coupons-page.ts:689-700`). Consequences: F-6c binds on `select`/`radio` only; a record picker whose option value is an opaque id **must** be a `combobox` (L-7); and §14 item 3 is worth less than claimed. |
| R-18 | `banner.variant` is `"default" \| "alert" \| "error"` and is passed straight into Kumo. `banner` renders `{title, description}` only — a legacy `text` field is dropped. | types `BannerBlock`, `blocks/banner.tsx:7,21,24` | `"info"`/`"success"` are **phantoms**: Otta's mirror allows them, the renderer forwards them unvalidated to Kumo. Constrain to the three real values (M-9). |
| R-19 | `chart` **cannot format money.** `TimeseriesChartConfig` exposes only `style`/`series`/`x_axis_name`/`y_axis_name`/`height`/`gradient`; series data is `[number, number][]`; and for a `custom` chart `formatter` is stripped as a DANGEROUS_KEY. | types `TimeseriesChartConfig`, `blocks/chart.tsx:53,108-118` | A chart renders **raw minor units** on the axis and in tooltips. Plotting major units instead puts a display float on the money path. `chart` is therefore forbidden here (§2, §12.5). |
| R-20 | `meter` takes a bare `number` with no currency, and renders `custom_value` verbatim when present. | types `MeterBlock`, `blocks/meter.tsx:7-13` | Money in `value`/`max` is unlabelled minor units. `custom_value` is **mandatory** whenever they are (M-8). |
| R-21 | `TableBlock.page_action_id` is **required** by the authoritative type. Otta's mirror keeps it optional (a pre-existing MOD-3 divergence). | types `TableBlock` | A table without it typechecks in Otta today and violates the renderer's contract. Reports has four such tables (§12.5). Always set it (T-6). |
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
| `SectionBlock.accessory?: Element` | `types.ts:233-236` has `type` + `text` only | L-6 `Clear filters` | **Foundation (#151 revision)** |
| `combobox` element + field spec | absent from `Element` (`types.ts:186`) and from `FormBlock.fields` (`types.ts:352`) | L-7 drill-in picker | **Foundation (#151 revision)** |
| `multiline?: boolean` on the text-input field spec | `FormFieldSpec` (`types.ts:310-316`) has no `multiline`; upstream `TextInputElement` does | the retired Orders screen's note form — **no surviving Block Kit consumer** | **Foundation (#151 revision)** |
| `toggle` element + field spec | absent from both unions | F-6, §12.3 Tax (`Applies to shipping`) — **the only consumer**; §12.4 Shipping has none | **The Tax screen**, not "increment 5" — increment 5 is **six** parallel screens (Pricing, Coupons, Tax, Shipping, Reports, Settings) and is not an owner |
| `ImageBlock` in the `Block` union | `types.ts`' union ends at `FormBlock`; upstream has `image` | §2 image row, a product detail *if* a product image URL ever lands | **Deferred** — add with the first real consumer, not before |

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
exist on `main`). Fixing them per screen would give every screen its own behaviour.

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
X-11's "eight budgets" (now seven), §13's "23 of 33" (now 32 of 53), V-1's foundation ownership, and the
Orders listing lines fixed below. Reading that PR against this document, the offsets are the **fix**,
not staleness: every one of the nineteen is live and indexed here.

**The screen these findings came from is gone; the findings are not.** ADR-0015 retired the Block Kit
Orders screen and this sweep deleted its §11 listing, so the "Landed in" column names only the **rule**
each finding became. That is the durable half in any case — a finding's value was never the listing
line it corrected.

| # | Finding | Landed in |
|---|---|---|
| E-a | `combobox` renders the option **label**; only `select` renders the raw value. The "order picker reads a raw UUID" wart cited twice was never real. | R-17b, F-6a, F-6c, L-7, §14 item 3, §16 item 3 |
| E-b | DA-3 state 2 nested inside another accordion puts the confirm button behind a parent the **response** leaves collapsed. **Restated:** the finding as filed said the confirm "is invisible"; on the happy path the parent is still expanded from the operator's own click (B-5), so it is visible — the defect is that visibility then depends on click history, and R-24 resets it. | DA-3 |
| E-c | A DA-3a refusal that re-renders without the staged payload silently opens a **different** group and discards what the operator typed. | DA-3a (new) |
| E-d | `-review` never bound-checked the amount, so `900.00` on a $50 order staged a red button and a confirm dialog that were both false. | DA-3c (new) |
| E-e | The only red control on the Fulfilment panel was **"Mark refunded"** (moves no money) while the irreversible cancel was a quiet trigger. | D-6, DA-5 |
| E-f | A row of five danger buttons makes the reason enum the loudest thing on a panel whose likeliest next act is a small quiet "Mark paid". **Restated:** the finding as filed said "~1100px of solid red"; `actions` is a single wrapping row of intrinsically-sized buttons, so the cap is about emphasis, not height. | DA-2c (new) |
| E-g | The Money panel can show `Total $95.00` beside `Captured $0.00 · Remaining $0.00`, and the D-6 label degenerates to `$0.00 of $0.00 refunded`. | M-11 (new), D-6 |
| E-h | A fail-closed banner asserted *"Could not reach the commerce service"* on a path a console bug also reaches — sending the operator's page to the wrong team. | E-1, E-3, E-7 (new) |
| E-i | X-9's raw-minor-units heuristic rejects the Orders listing's own `Refunds recorded` count. | X-9 |
| E-j | X-11's `fields`-value budget cannot be H-enforced on a data-derived value (a 45-char email fails through no authoring fault). | X-11, §1 |
| E-k | `filterPanel` emits **no** `default_open` key; L-4's "always `false`" invited a `=== false` assertion that would fail. | L-4 |
| E-l | The Orders transition listing omitted the observed-state watermark, so transitions were the one write exempt from DA-3a. | DA-2b, DA-6 |
| E-m | The Orders listing mandated a `Kind (badge)` column that **T-5's own third bullet forbids**, and T-5's whitelist entry for it was never valid anywhere it applies. | T-5 |
| E-n | The Orders `Customer` (4) and `Shipping address` (8) `fields` listings drop `Buyer reference`, `Email verified`, `Email` and `Region`. | §4 (D-1a) |
| E-o | On a guest the Customer group says "no account" **five** ways, and `Email` denies an address three other elements display. | D-7, E-3 |
| E-p | The Notes table duplicates the timeline's `Detail` column verbatim. | P-3, D-7 |
| E-q | DA-7 lines narrated the designers' decision (*"There is deliberately no bare 'Mark shipped'"*) instead of naming the alternative. | DA-7 |
| E-r | `V-1`'s `test/helpers/blocks.ts` was assigned to the foundation and never shipped; `V-3`'s `assertBlockContract` had **no owner** and does not exist. | §15, **§15.1** |
| E-s | A staged or refused re-render costs a **full leaf re-read** (5 requests on Orders), not one — and #161's hand-rolled `stagedResponse` paid it **twice** on both of its fallback paths (`detail === null` and its `catch` each fall through to `showLeaf`), from a second render path the leaf's `notFound`/`onError` never saw. The scaffold now carries render state instead, so the level renders itself once. | DA-3a-ii, DA-3a-iii |

Two of the nineteen are recorded and **not** fixed here: an unclickable tracking URL (§14 item 5) and
`ComboboxList`'s spurious React duplicate-key warning (§14, tracked note).

**The meta-finding, and it is the reason N-1 exists:** for the duration of PR #161 the
*implementation* was a more reliable guide to the renderer than this document. Three of its four
substantive defects came from a listing that contradicted a rule. Assume this document is still wrong
somewhere; N-1 tells you what to do when you find it.

### 0.3 Accepted limitations and trades — ruled on, not open

Three things below look like defects on a screenshot or in a diff. All three have been ruled on and
**none is to be "fixed"**. A PR that closes one of them is a change of direction and needs an ADR,
not a commit.

#### ⚠ 1. You cannot close a group. Two open groups after a refusal are permanent. — **B-8**

This is the single most likely thing for a following team to get wrong, so it is stated here and
again as a rule in §10.

`AccordionBlock` carries `type`, `label`, `blocks` and `default_open` and **nothing else** (installed
0.31.1 `validation-5vL6669b.d.ts:306-311`; upstream `types.ts:360-365`), and `default_open` is read
**once, in a `useState` initialiser** (`blocks/accordion.tsx:14` —
`useState(block.default_open ?? false)`, already R-14a). There is no `open` field, no close signal
and no imperative channel in this vocabulary. The **only** thing that makes a mounted accordion
re-read `default_open` is a changed React key, i.e. a changed `block_id`
(`renderer.tsx:78` — `key={block.block_id ?? i}`).

Therefore: **`default_open: false` on a group the operator — or an earlier D-5 rank — has already
opened is a no-op**, and a D-5 rank-2 rule that opens a group guarantees **two visibly-open groups
after every refusal on that screen, permanently.**

**The ruling: accept it.** Forcing the other groups shut means changing their `block_id`s, which
remounts them and **discards the operator's unsubmitted input** in those groups — the exact hazard
F-5a-i documents and `filterRow()` was withdrawn for (§0.1 A). The cure is worse than the condition.
So there is **no rule requiring other groups be forced shut**, and B-8 forbids inventing one.

Read it together with **X-18** and **D-5**, which constrain the **emitted response** only. Two groups
open in a screenshot is B-5 working as documented. See **B-8** for the full rule and **R-14a, B-5,
B-6, F-5a-i** for the mechanism.

#### 2. `failClosed()` does not say "nothing was changed" — accepted

E-7's rewrite made the fail-closed banner honest about **cause**. It is still silent about **effect**:
it does not tell the operator whether the write applied. That is deliberate, and no wording fixes it.

`onError` is one function per level and the engine calls it from **one** `catch`
(`scaffold/list-detail.ts:495-498`) wrapping `load`, `render` *and* `notFound` (`:489-499`). It fires
whenever a re-render fails, and re-renders come from **both** of these:

- a **`-review` or refusal** re-render, where nothing was written and "nothing was changed" would be
  true and reassuring;
- the **post-write** re-render, where the write already applied and "nothing was changed" would be a
  **false statement about money** — the worst possible thing to say right after a refund.

`showLeaf` is the same call on both paths and carries no "did I write" bit, so **no single wording can
carry both**, and E-7's own discipline forbids asserting something the copy cannot know. The resolution
is a division of labour: the *notice* carries the effect ("Nothing was refunded", "Refund recorded")
and the *fail-closed banner* carries only the symptom. Accepted; do not add an effect claim to E-7's
blockquote.

#### 3. A refusal's `notice` is dropped on the `notFound` path — accepted

`renderLeaf` passes **no notice** to `notFound`: `scaffold/list-detail.ts:552` is
`if (detail === null) return { blocks: level.notFound({ actions, path, id }) };`, and the interface
documents the omission (`:185-191`). So if the record stops resolving between a refusal's action and
its re-render, the refusal banner **vanishes** and the operator sees only that level's `notFound`
blocks. Coupons is the surviving instance — `header` "Coupon not found", a back button, and an
`error` banner reading `No coupon matches "<id>" — it may have been deleted.`
(`coupons-page.ts:844-855`).

**Not unsafe:** every refusal applies nothing before re-rendering, so there is no write whose outcome
went unreported, and the vanished record *is* the outcome that matters. DA-3a-iii property 4 already
documents dropping *renderState* on this path; it is amended below to say the **notice** is dropped
too, so nobody reads the silence as a bug.

---

## 1. Principles

Six rules. Each is decidable by reading a diff.

**P-1 — Data inside the first screenful.** Only the blocks on the applicable whitelist may
precede a screen's primary data block. Nothing else may be inserted, in any order.

| Skeleton | Primary data block | Blocks permitted above it, in this order |
|---|---|---|
| List (§3) | the primary `table`, or the `empty` that replaces it | `header` · ≤1 `context` · ≤1 create `actions` block (L-8) · ≤1 notice `banner` · the filter block (a **collapsed** `accordion`, or an inline `form` at ≤2 fields per L-2) · ≤1 active-filter `section` |
| Detail (§4) | the identity `fields` strip | `header` · the back `actions` block · ≤2 `banner`s |
| Report/settings (§4.1) | the first `accordion` | `header` · ≤1 `context` · ≤1 `banner` · `stats` (reports only) |

**P-2 — One `header` per screen; structure comes from `tab` and `accordion`.** `header` is the
page title and appears exactly once, as the first block. Named groups are `accordion`s (inside a
`tab` panel, or at top level). `section` is **never** a heading — it is one line of prose with an
`accessory` control. *Single exception, absent a React migration (§14 item 1, indefinitely
deferred):* **at most one** `header` may
appear inside a `tab` panel, to name a group that must always be visible and cannot be an
accordion (the retired Orders detail's line-item table + totals block was the instance). One per
panel, never two.

**P-3 — Emptiness earns words, not containers.** A collection with zero rows never gets its own
heading *and* table *and* explanatory line. It gets one `context` line, or a `table` with
`empty_text`, or nothing at all when a sibling line already says it (§6).

**P-4 — Data before controls.** Above the primary data, only what P-1's whitelist permits — and
the filter block only in its **collapsed** form, one row tall, with its one-line summary. Every
other control — expanded filters, create forms, edit forms, destructive actions, drill-in
pickers — sits **below** the data it acts on.

**The one thing P-4 lets above the data is a create BUTTON, never a create form (INC-14).** The
distinction is what makes the promotion legal: an `actions` block holding one `primary` button is
one row tall and collects no input, so "data inside the first screenful" survives it; the create
**form** would not, and it does not sit here — it lives on a drill-in create screen (L-8). Shipped
on all five create surfaces: `coupons-page.ts:532-538`, `tax-page.ts:277` and `:602`,
`shipping-page.ts:359` and `:794-799`, all through the same one-button helper
(`tax-page.ts:308-329`, `shipping-page.ts:392-413`).

**P-5 — No internal vocabulary reaches the screen.** No `action_id`s, camelCase field names,
idempotency keys, CAS watermarks, cursor tokens, or drill-path carriers are ever rendered as a
field or in copy. Labels are the words an operator would say out loud (§7, §9).

**P-6 — Every irreversible write passes a `confirm` dialog.** One rule, every screen, no
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

**Where the screens stood when the budgets were set.** Measured 2026-07-29 by AST-extracting each
literal and counting characters. Page-level `context` was close to budget on Reports; the registry
and catalog screens were the problem, and the worst offenders were **in-form explanations**, not page
contexts. Do not conflate the two. **The rows for the two retired screens are gone** — their strings
left the Block Kit tree with `orders-page.ts` and `products-page.ts` (ADR-0015), and a budget row
naming a file nobody can open is worse than no row.

| String | File:line | Chars | Target |
|---|---|---|---|
| Reports page `context` | `reports-page.ts:111` | **191** | ≤140 |
| Tax page `context` | `tax-page.ts:179` | **292** | ≤140; the delete-blocked clause moves to DA-7's withheld line |
| Shipping page `context` | `shipping-page.ts:233` | **340** | ≤140; same |
| Coupons page `context` | `coupons-page.ts:276` | **457** | ≤140; the immutability facts move into the create accordion, the redemption fact to DA-7's withheld line |
| Coupons **edit-form** `context` | `coupons-page.ts:483` | **613** | ≤200 (F-8) |
| Coupons withheld-delete `context` | `coupons-page.ts:492` | **198** at a 1-digit count — *inside* budget, but it grows with the count and crosses 200 at four digits | replaced by §8's normative blockquote for **copy** reasons, not length |
| Coupons delete `confirm.text` | `coupons-page.ts:583` | **301** | ≤200 |
| Tax/shipping level `context` ×3 | `tax-page.ts:338`, `shipping-page.ts:371,508` | 268, 285, 316 | ≤200 each |

Every other `confirm.text` on every screen is already ≤200 (`tax-page.ts:248` 132, `:448` 183;
`shipping-page.ts:308` 113, `:448` 104, `:631` 197), and no `banner.description` anywhere exceeds
240. The budget table is not a blanket rewrite mandate — it is these ten strings.

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
| `columns` | **Nowhere.** Forbidden on every screen. | Everywhere. It appears in no skeleton and no listing here; dead vocabulary in a consistency-first document means six teams invent six uses. The type stays for future screens. |
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
2  context         (cond) the row count, then the standing line   ≤140  [L-1a]
3  actions         (cond) ONE primary "New <entity>" button — omit where
                   the entity is not created in the admin          [L-8]
4  banner          (cond) notice from the last action, or a degraded-read warning
5  accordion|form  the filter                                        [L-2..L-5]
6  section         (cond) active-filter summary + `Clear filters` accessory   [L-6]
7  table           THE DATA — or `empty` in its place                 [§5, E-2]
8  form            (cond) "Open <entity>" drill-in — omit at 0 rows   [L-7]
```

**Block 3 sits above the notice banner, not below it**, because it is part of the standing page
furniture rather than a response to the last action — `coupons-page.ts:488-492`, `tax-page.ts:271-279`,
`shipping-page.ts:353-361`.

**L-1.** Nothing else appears above block 7 (P-1). In particular: no create **form**, no per-row edit
form, no `divider`, no second `context`, no expanded filter. The create **button** of block 3 is the
whole of what INC-14 added to this whitelist, and the reasoning is P-4's.

**L-1a — the row count leads the standing `context` line; it is not a block of its own.** The count
and the sentence share one `context` — `listIntroLine(countLine, intro)` emits
`` `${countLine} · ${intro}` `` (`scaffold/list-detail.ts:1016-1022`), e.g.
`17 orders · Filter, open an order, and move it through its status flow. Money in the order's
currency; dates UTC.` A second block would cost a row and break P-1's one-`context` cap. Two
properties are load-bearing and are shipped in the shared helper
(`admin-presentation/src/list-outcome.ts:119-140`):

- **Zero rows render no count at all** (`:127`) — "17 orders" directly above "No orders yet" is the
  screen contradicting itself in two adjacent blocks.
- **A count that is only this page's says so**: `17 orders` when the page is complete or a service
  total is available, `17 orders on this page` otherwise (`:137-139`). The suffix is the whole
  reason a count is safe to render at all.

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

**L-7 — drill-in.** Table row clicks are unreachable on Block Kit (§14 item 2): one `form`
directly below the table, one field, submit label `Open <entity>`. Omit the whole block at 0
rows.

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

**L-8 — creating: a `primary` button at the top, a create SCREEN behind it.** *(Rewritten by
INC-14, which overturned this rule's earlier "create form in a bottom accordion". The reason is
recorded below rather than only the new state.)*

```
actions  block_id <entity>:create-action
         [ button{ action_id: <entity>:new, label: "New <entity>", style: "primary",
                   value: { __path: encodePath(path) }   ← omitted at depth 0 } ]
```

- **Placement is block 3** — directly under the standing `context` line, above the notice banner
  and above the data.
- **The form is not on this screen.** The button drills into a create screen shaped like every
  other non-list level — `header` · back button · notice · `context` · the form — so the way out
  is where an operator already looks for it (`coupons-page.ts:548-563`, `tax-page.ts` `newClassScreen`
  / `newRateScreen`, `shipping-page.ts` `createZoneScreen` / `createMethodScreen`).
- **`style: "primary"`**, which is the one exception DA-5 now carries.
- **The path rides in `button.value`, never `block_id`** (B-1), and is omitted at depth 0 because
  there is nothing to carry (`coupons-page.ts:528-531`).

**Why it moved, and it is a ruling rather than a preference.** The bottom accordion put the create
action at the least prominent point of a screen whose first task, on an empty or near-empty
registry, is creating one — `tax-page.ts:255-261` states it at the call site. Two objections were
weighed and answered: P-1 (a button is one row tall and collects no input, so the first screenful
still leads with data — P-4), and duplication with E-2's empty state (the `empty` block's action
carries the **same** `action_id` and the **same** label and reaches the **same** screen, so it is
one act named once — `tax-page.ts:290-292`, `coupons-page.ts:475-477`).

**Where there is no create control at all**, the block is omitted rather than rendered inert. **No
surviving Block Kit list is in that case** — the three that have lists (Coupons, Tax, Shipping) all
ship a create control, and Reports and Settings have no list at all. The rule's two instances
were Orders (orders are not created in the admin) and Pricing & inventory (products originate in the
CMS), both of which are now React screens where the same omission holds; the entity originating
elsewhere is what decides it, not the renderer. Keep the rule: the next registry whose rows arrive
from a sync will need it.

**L-9 — registry screens (Tax, Shipping): the per-row accordion list is a runtime branch.** A
level renders as a per-row accordion list (§12.3) **only** when both hold for the fetched page:

1. the page is complete — `nextCursor === null`; **and**
2. `items.length <= 25`.

Otherwise it renders `table` + drill-in (blocks 6–7) and moves editing to a detail level. **Both
branches ship**, and the sandbox suite asserts the branch at 25 rows and at 26.

**Every per-row accordion is `default_open: false`** — a level with 25 rows must not open one of
them, and D-5's precedence does not apply here (it governs detail screens). A registry level
therefore renders with zero open groups. (There is no create accordion left to say this of: L-8's
create control is a button above the data and its form is on another screen.)

**L-9b — zero rows.** The accordion branch has no `table` to carry `empty_text`, so emptiness must
be stated explicitly or the level renders header + context + create button and never says it is
empty. **At zero rows an L-9 level omits the row list and renders the `empty` block per E-2, with
its create action in `empty.actions`.** And **every L-9 fallback table sets `empty_text`** (T-7).

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
silently drops data a §12 mapping table promises to preserve, which is exactly what happened to
`Customer` and `Shipping address` in revision 3 (§0.2 E-n).

**D-2 — panel set: task-named, actions beside their data.** Panels are named after the
**operator's task**, never after read-vs-write. There is no "Actions" panel on any screen: an
"Actions" junk drawer separates the refund form from the totals it is computed against, and puts
the routine path (fulfil → mark completed) in the same box as the irreversible one.

| Screen | Panels (constant, in this order) | Labels ≤12 chars |
|---|---|---|
| **Coupons** (§12.2) | `Coupon` · `Redemptions` | ✓ |

**Coupons is the only Block Kit screen with a detail screen, and therefore the only one D-2..D-5
govern.** Tax and Shipping have no detail screen at all — every level is a list (§12.3, §12.4);
Reports and Settings are §4.1 screens with no panels. The other two rows of this table were Orders
(`Order` · `Fulfilment` · `Money` · `History`) and Pricing & inventory (`Product` · `Stock`), both of
which left Block Kit under ADR-0015 and now render those same panel sets from `@otta-sh/admin-react`.
X-16 checks a panel count against this table, so it now has exactly one screen to check.

**D-2a — two panels are permitted where a third would hold only a `context` line.** Coupons'
would-be `History` panel contains nothing but created/updated: an operator clicking a tab to be told
nothing is there. Those facts go into the **first panel's own `fields` block**
(`coupons:identity`) — **not** the identity strip, which §4 caps at 6 entries. D-3's requirement — a
*constant* set per screen — is unaffected. (Pricing & inventory made the same call for the same
reason, and kept it across its React migration.)

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
response falls through to Rule 2 and opens whatever the record state suggests — on the retired Orders
screen that was `fulfilment`, on a *different tab panel* — while the group whose banner says "re-enter
an amount below" stays shut (§0.2 E-c). Rule 1 is keyed on **"this response carries render state"** — a
staged payload or a refusal, per DA-3a-iii — not on "this response came from `-review`". That is a
predicate the render path can read (`renderState !== undefined`), not an inference about which action
fired.

**Rule 2 — otherwise, first match wins.** At most one group gets `default_open: true`:

| # | Group | Condition |
|---|---|---|
| 1 | a `reconcile`-shaped group | the record is flagged for reconciliation and unresolved |
| 2 | a `fulfilment`-shaped group | the record is mid-workflow and the group is the next act |
| 3 | the screen's **named primary edit group** — Coupons: ***none*** ← AMENDED, was `Discount` | the record is editable (not tombstoned, not terminal) |
| 4 | — | nothing is open |

Everything else is `default_open: false` — always, including every destructive group and every
group whose body is a table that may be empty. There is no taste in this rule and no per-screen
variation: a reviewer computes the expected group from the record state and checks one boolean.

**Ranks 1 and 2 have no live instance, and rank 3 is declined by the one screen that could name it —
so every Block Kit detail response today opens ZERO groups.** Ranks 1 and 2 were written from the
Orders reconciliation and fulfilment groups, which left Block Kit with that screen (ADR-0015); the
Pricing & inventory `Identity` group was rank 3's only instance and left with it. Coupons, the only
Block Kit screen with a detail (D-2), names no rank at all — see below. **The algorithm is unchanged
and still binds**: a screen that adds a mid-workflow group inherits rank 2 without arguing for it,
which is the whole reason the ranks are stated as shapes rather than as a list of group ids.

**A screen may name NO rank-3 group, and Coupons does.** Rank 3 is a slot, not a quota: a screen
whose edit group's **label already carries the answer** (D-6 — `Edit — 20% off · 10 Jul 2026 –
31 Dec 2026`) buys the reader nothing by opening it, and pays a full form's height for it. Coupons
therefore renders **zero** open groups on its detail (`coupons-page.ts:1016-1020`). The rank-3
condition is unchanged where a screen does name one; what is not permitted is a screen naming one
**here** and shipping a different boolean.

**D-5 constrains the emitted response, not the viewport.** The algorithm decides the booleans in
*this* response — at most one `default_open: true` — and it cannot close a group an earlier render
already opened: an unchanged `block_id` means no remount, so the mounted accordion never re-reads
`default_open` (B-5, B-6; `accordion.tsx:14`, keyed on `block_id` at `renderer.tsx:78`), and
an operator can therefore see two groups expanded while the response underneath is fully compliant.
**Check the emitted JSON, never the screen:** two expanded groups in a screenshot are B-5 working
exactly as documented and are **not** evidence of a D-5 or X-18 violation.

**And this is permanent on any screen with a Rule-2 rank, which is accepted — see B-8.** The worked
case was Orders, where rank 2 opened `fulfilment`, so *every* refusal on that screen left two groups
visibly open for the rest of the session. **No Block Kit screen carries a rank today**, so no screen
reaches that state today either — but nothing about the mechanism changed. There is **no close signal
in this vocabulary** (B-8: `AccordionBlock` has only `default_open`, read once at mount), and the only
way to force a group shut is to change its `block_id`, which **remounts it and discards the operator's
unsubmitted input** (F-5a-i). Do not do it, and do not add a rule asking for it.

**A rank the algorithm opens must still render.** The worked case, again from Orders: rank 2 fired on
a `paid` order, where tracking was not yet capturable, so `fulfilment` opened with no form in it. **The
group still renders, and its body is one honest DA-7 line naming the operator's real next act:**
*"Tracking is recorded once this order is processing — use 'Mark processing' below first."* This is the
pattern, not an exception: where a rank opens a group whose content does not exist yet, the answer is a
line, never a dropped group (D-3's logic one level down) and never a silent fall-through to the next
rank.

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

**D-6c — ONE ratified exception to "never fan out per-row reads": the shipping METHODS level
(INC-16).** Recorded as a ruling, with its reason and its bound, because the rule above forbids it
in general and a following team must be able to tell an exception from a violation.

Each method row's label leads with its **price**, which is not on `ShippingMethodWire` — it is a
`getRate(methodId, currency)` per row. Shipped at `shipping-page.ts:689-706` (`pricedMethods`) and
`:712-724` (`methodPrice`).

| | |
|---|---|
| **Why it was allowed** | The price is the number the operator came to this level for, and the level exists to answer "what does each method cost?". A bare `standard — Standard shipping` sends every operator into a drill-in to read one figure. The zone-count case above has no such claim: a method count is navigational, not the answer. |
| **What bounds it** | **`Promise.all` over at most 25 rows**, because the fan-out runs **only on the L-9 accordion branch** — past 25 the level renders the table branch, which shows no price and fires **no** rate reads at all (`shipping-page.ts:103-113`, and `isRegistryAccordion` at `:271-273`). The bound is structural, not a constant a team can raise. |
| **How it degrades** | Per row, never per level: a failed read logs and renders that one label as `Price unavailable`; an absent rate reads `No rate set`; the table branch reads `Price not loaded` (`methodPriceLabel`, `shipping-page.ts:743-753`). One slow zone never fails the screen. |
| **What is priced and NOT bought back** | The reads recur **per render of the level** — on the drill-in, on every filter apply, and on every post-write re-list — and they carry no `AbortSignal` and no deadline. Both are recorded as follow-ups at the call site (`shipping-page.ts:676-687`), not as unknowns. |

**This exception does not generalise.** It licenses a per-row read only where (a) the fetched value
*is* the answer the level exists to give, (b) a structural branch caps the fan-out, and (c) a single
row's failure degrades that row alone. A zone's method count meets none of the three, which is why
the bullet above still stands unchanged.

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
**S-3.** **At most** one accordion is `default_open: true`, named explicitly per screen (§12.5,
§12.6) — D-5's precedence table does not apply, because there is no record state to derive it from.
*(Was "exactly one". INC-15 made Settings open **zero**, so the cap is what binds and the floor is
gone.)*

| Screen | Open group | Cite |
|---|---|---|
| Reports (§12.5) | `reports:revenue` — the one open group | `reports-page.ts:552-559` |
| Settings (§12.6) | **none** — all three groups render `default_open: false` | `settings-form.ts:676-681`, `:743-748`, `:758-763` |

**Why Settings opens nothing, stated as a ruling.** Every group's **label** now carries its own
current values — `Store — <name>`, `Checkout & holds — 15 min hold · low stock at 5`,
`Service connection — token not set · service token not set` — so the screen answers "what is this
set to?" with **zero** clicks rather than one group's worth (D-6's discipline, applied to a
settings screen). An opened group answers one question and buries the other two; three labels answer
three. Label builders: `settings-form.ts:641-674`; the reasoning is at `:480-489`. Zero open groups
is legal under X-18, which caps `default_open: true` at one per response and sets no floor.

**A label that cannot state its value says so, and does not imply a zero.** When the secondary
`GET /settings` read failed there is nothing persisted to name, so the label reads
`Checkout & holds — not loaded` rather than a fabricated `0 min hold` (`settings-form.ts:645-656`).
This is E-3's successful-empty / failed-read distinction, one level up, in an accordion label.
**S-4.** Every form on these screens obeys the change-token rule (B-3, B-3a): its `block_id` comes
from `carriedForm(...)`, so a save re-renders with fresh prefill. This applies to **all four**
Settings forms and is the only reason a saved value redisplays correctly.
**S-5.** A save re-renders the **whole** screen, never a fragment. Every save and every validation
branch returns the full screen plus a notice. **Shipped on all four saves** — `save-display`'s
success and its invalid-name branch both return `renderPage(...)`
(`settings-form.ts:244-282`), as do the two token saves (`:305`, `:331`); `save-operational` builds
the same three-accordion output through `buildSettingsBlocks` directly, because it already holds a
fresher settings wire than a second `GET` would return (`:370-405`).

**Why the rule is stated this hard.** The fragment receipt was **terminal**, not merely ugly:
`SandboxedPluginPage.tsx:46` is an unconditional `setBlocks(data.blocks)` and its `page_load` effect
is keyed on `[sendInteraction, page]`, so nothing re-fetches and the operator had to navigate away
to recover. Two branches did it — a success that returned `[header, section]`, dropping the other
three forms; and an invalid-name refusal that returned `[header, banner]`, stranding a merchant who
typed a 201-character name **with no field to correct it**. Both are fixed and both are commented at
the call site, so the shape does not come back.

**S-5a — retiring an invariant is a deliberate act, and this one was retired.** `renderPage` calls
`client.getSettings()` over `ctx.http`, while the display-name path used to document that it
"provably never touches `ctx.http`", with a suite asserting `stub.requests` was empty. The choice
was (a) re-render without a fresh GET and keep the invariant, or (b) drop it and update **both** the
comment and the assertion in the same change. **(b) was taken**, for a stated reason — there is no
operational-settings value in scope on that path to re-render the other two groups from — and the
comment and the sandbox assertion moved with it. The rule this leaves behind is general: **do not
leave a comment claiming something the code stopped doing**, and when a suite is *green over* a bug
(the old one asserted only that *some* block contained the name), the fix ships a new assertion that
the forms are still present.

---

## 5. Tables

**T-1 — column ceiling.** 5 on a list screen, 6 on a detail sub-table. Hard maximum 6. There is no
alignment or width control; wider tables scroll horizontally and stop being scannable.

**T-1a — one ratified exemption: the Coupons list ships SIX columns (INC-07).** Recorded as a
ruling, not as a reading of the rule — the 5-column guidance for a list screen is what the screen
exceeds, and it lands exactly on T-1's hard maximum of 6, which is not exceeded. Shipped at
`coupons-page.ts:606-636`: `Code · Status · Discount · Valid · Uses · Min spend`.

**The reason, because a following team must be able to tell an exemption from a violation.** The
increment added two columns to a four-column table and neither is derivable from another cell:

- **`Status`** is the question the screen exists to answer. Computed per render from the coupon's
  own fields (`couponStatus`, `coupons-page.ts:335-343` → `active` / `scheduled` / `expired` /
  `used up`). Without it the only signal that one code ended last month and another has not started
  is the raw date text in `Valid`, i.e. date arithmetic on every row of a screen whose whole purpose
  is "which discounts are live right now".
- **`Min spend`** is the one condition that makes a live coupon not apply, and it is absent from
  every other cell.

**The scope of the exemption is exactly this table.** T-1's 5-column guidance is unchanged for every
other list screen — the React Orders and Pricing & inventory lists both ship 5 — and a second
candidate is a signal that a column is restating a neighbour, not that the ceiling is wrong.

**T-2 — column order.** Identity first (the thing you searched for), then the columns you scan,
**money last**. There is no right-alignment or column alignment of any kind (R-7), so putting money
in the final column is the only way to get a readable money edge.

**T-2a — "identity first" yields where the identity is an OPAQUE id (INC-06).** Money-last is the
half of T-2 that is load-bearing and it never yields; identity-first is the half that does, on
exactly the screens whose identity column is a token rather than a name. The instance is Orders,
which ships `Placed · Customer · Status · Order # · Total`
(`admin-react/src/orders/orders-list.tsx:394`) — the Block Kit screen shipped the same five in the
same order until ADR-0015 retired it, which is why the migration was able to be a move rather than a
redesign. A short order id leads nothing — an operator scans this list by date and by buyer, and the
id is what they carry *away* from it. So the id takes the slot in front of the money rather than the
lead. **No surviving Block Kit list has an opaque identity column**, so T-2a is dormant on this
renderer and T-2 applies unqualified.

Where the identity column *is* a name, T-2 stands unchanged: Pricing & inventory leads with `Title`
(`admin-presentation/src/products-copy.ts:465-471`) and Coupons with `Code`
(`coupons-page.ts:606-636`).

**T-3 — `sortable` is forbidden** until the scaffold's `page` action handles `value.sort` and
`ListLevelDef.fetchPage` threads an ordering parameter into the service list ports. Today a sort
click discards the filter and ignores the sort (R-8). When sort lands, `sortable` goes only on
columns the service can order by — never on a derived or formatted column (a formatted money
string, a joined address, a summary sentence).

**T-4 — `format` by column kind.**

| Column kind | `format` | Notes |
|---|---|---|
| Record id, SKU, provider ref | `code` | Monospace chip; keeps UUIDs from reading as prose. |
| Timestamp in a table | `relative_time` | "3 days ago" — for a column read as an AGE and stated on no other surface. A timestamp the detail screen ALSO shows renders absolute, in M-6's format, so the two agree (INC-13). |
| Count, quantity | `number` | `num.toLocaleString()` — locale grouping (`table.tsx:26-29`). |
| Money | *(none — plain text)* | Pre-formatted by `formatMoney` (M-1). **Never** `number`: `9900` would render as `9,900`, which is worse than raw because it looks like a formatted total. |
| Lifecycle state | *(none — plain text)* | Subject to T-5: a status column is **never** a badge column. |
| A closed set of ≤3 values, none of them a happy path | `badge` | The only badge left (shipping-method `Type`). Subject to T-5. |
| Everything else | *(none)* | |

**T-5 — badge discipline: badge the exceptions, and a status column cannot.** *(Rewritten by
INC-10, which overturned this rule's earlier "lifecycle state ⇒ badge" whitelist. The per-screen
wireframes that still drew the old badges were corrected in the docs sweep; **one** `format:"badge"`
remains in the whole console — `shipping-page.ts:1012`, the method `Type` column, and it renders the
mapped human name rather than the raw enum.)*

The right rendering for a status column is "mark the exception, leave the happy path quiet", and
**Block Kit cannot express it**: `format` is a property of the COLUMN, not of a cell
(`blocks/table.tsx`'s `formatCell` reads `col.format`), so a table badges every row of a column or
none of them — and blanking the happy-path cell to fake the split is worse than either end, because
`Badge` draws its pill from padding and a radius alone, so an empty cell in a badge column is a
solid mark with no word in it. So:

- **No status/lifecycle column is a badge column.** Order status, product status, coupon status,
  timeline event kind: all plain text. A badge on them spends the heaviest ink on the value nearly
  every row carries (`paid`, `active`), and one filter click later — Orders filtered by status,
  Pricing & inventory filtered to Active — every row carries the SAME value, which is X-4.
- **The exception is marked in the cell's own words**, the convention `On hand` ships
  (`0 · Out of stock`) and Orders extends (`cancelled · closed`). What the mark says must be a fact
  the console can stand behind and must come from ONE constant per vocabulary, never one per screen;
  a value not in that set renders bare, so a new state never acquires the loudest rendering by
  default. **The two shipped vocabularies live in the shared presentation package**, which is what
  makes "one constant" true across the Block Kit and React surfaces at once:
  `orderStateCell` over `TERMINAL_ORDER_STATES` = `{failed, expired, cancelled, refunded}`
  (`admin-presentation/src/order-status.ts:63-68,115-117`), and `onHandCell` / `statusLabel`
  (`admin-presentation/src/product-status.ts:34,37,62-97` — `Out of stock`, `Low`, and the four
  product status words including `active (not priced)`). Coupons needs no added mark, because every
  value its `Status` column renders except `active` already **is** the exception spelled out —
  `scheduled`, `expired`, `used up` (`coupons-page.ts:595-604`).
- **`format:"badge"` survives only for a closed, small set in which no value is the happy path** —
  today exactly one column, the L-9 shipping-method `Type` (2 values, both meaningful, an operator
  distinguishes them at a glance). At most **one** such column per table.
- Never badge: a property near-constant across rows (`kind: physical` — the column of identical
  black pills the products list used to draw), a boolean rendered yes/no (`Applies to shipping` —
  use `yes` / `—`), a currency code (delete the column instead, M-2), an id, money, a date, or free
  text.
- Because every badge renders identically (R-6), a column whose values never differ is pure
  decoration. If you cannot name two values an operator would want to tell apart at a glance, it is
  not a badge.

**`refund kind` is struck from the whitelist, and the near-constant clause is why.** Revision 3
listed it as a lifecycle badge while the third bullet above forbade it — a contradiction inside one
rule, which the Orders listing then mandated (§0.2 E-m). It resolves against the badge, decisively:
`kind` is `gateway.refundable ? "gateway" : "manual"`
(`domain/src/orders/refund-order.ts:211`), and the gateway is resolved once from the **order's own**
`paymentMethod` (`service/src/routes/admin.ts:742`), so within any single order's ledger the value
**cannot vary** — and the per-order ledger, now a React surface, is the only table in the console that
renders it at all. The
whitelist entry was therefore never valid anywhere it applied. `Kind` is deleted from the refunds
table, not demoted to plain text: a constant column of the word `manual` is a column of nothing. If a
refund's kind ever needs stating, it belongs in the group's capability `context` line, which already
explains whether refunds here move money.

**T-6 — `page_action_id` is always set** — the authoritative type requires it (R-21) — even on a
table that can never page. Keep the `// never fires: no next_cursor, no sortable column` comment
convention so the intent is readable. `next_cursor` is set only when a next page exists, and never
in a leaf detail (T-8).

**T-7 — every table sets `empty_text`** (R-9), subject to §6.

**T-8 — a table inside a leaf detail MUST NOT set `next_cursor`.** The case that earned the rule was
the retired Orders detail, with seven sub-tables sharing one `page_action_id`. A load-more click sends
`{cursor: <that table's cursor>}` into the scaffold's `page` branch, which either fails
`decodeListCursor` and bounces the operator to the unfiltered root list
(`list-detail.ts:290-293`) or reaches `renderList` at a **leaf** depth where `listLevelAt` returns
`undefined` and the response is `{blocks: []}` — a blank page
(`list-detail.ts:198-201,209-210`). Both outcomes are unacceptable. Instead: **cap the read** and
state the cap in one `context` line — `Showing the 20 most recent notes; older notes are not listed.`

**T-8a — the cap line is emitted only when the read was actually truncated.** The cap is real either
way; the *sentence* is only true news when rows were withheld. "Showing the 50 most recent events" on
a 4-event record is noise on a console this document is trying to make quieter. Condition it on
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
"No coupon matches that code.").

- **With** a create action on the screen: the action goes in `empty.actions` as a `button` carrying
  the **same `action_id` and the same label** as L-8's promoted button above, so both reach the same
  create screen — one act, named once (`tax-page.ts:290-292`, `coupons-page.ts:475-477`). Title +
  description + one button. *(Was: "re-renders the list with the create group forced open (B-6)".
  That group no longer exists — INC-14 replaced it with a create screen, so there is nothing to
  force open and B-6 does not apply here.)*
- **Without** one: title + description only, and `empty.actions` is **omitted, not an empty array**.
  **No surviving Block Kit screen is in this case** — the two that were are Orders (orders are not
  created in the admin) and Pricing & inventory (products originate in the CMS), both now React
  (L-8's matching note). The clause stays because it is the same condition L-8 turns on, and the two
  must not be allowed to disagree.

**A filtered-to-zero list is a third state, and INC-12 gave it its own copy.** The shared outcome
helper renders a distinct `empty` block for "the filter matched nothing" — its `noMatch` copy plus a
`Clear filters` button the **helper appends**, so no screen can forget it
(`scaffold/list-detail.ts:899-902`, outcome 4 at `:931-932`; screen copy at
`coupons-page.ts:479-485`). Its one action is the **undo**, not the create: the way in is already on
screen above (L-8). E-2's ban stands where it was aimed — the large `empty` must not be the
*create* affordance for a filtered list — and there are two further outcomes the helper decides so
that a screen cannot: a zero page that is **not** the first gets page-scoped wording rather than a
whole-collection claim, and a zero page with **another page behind it** gets no `empty` block and no
`empty_text` at all, because the pinned renderer short-circuits such a table to a bare `<p>` and
takes `Load more` with it (`list-detail.ts:918-930`).

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

**It deliberately does not say "nothing was changed", and that is an accepted trade, not an omission
to fix (§0.3 item 2).** The banner is honest about **cause** and silent about **effect**: `onError` is
reached from one `catch` (`scaffold/list-detail.ts:495-498`) that fires on a `-review`/refusal
re-render — where "nothing was changed" would be true — *and* on the post-write re-render, where it
would be a false statement about money. `showLeaf` is the same call on both paths and carries no
"did I write" bit, so **no single wording can carry both**. The effect belongs in the *notice*
("Nothing was refunded" / "Refund recorded"); the fail-closed banner carries only the symptom. Do not
add an effect claim to the blockquote above.

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
| Edit / save (sparse PATCH) | content hash of the submitted wire + `expectedUpdatedAt` (`deriveEditIdempotencyKey`, `products-actions.ts:307-324`) |

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
against `cmd.amount`**. The refund handler then renders "Already refunded (a duplicate submission)"
(`orders-actions.ts:657-666`). So the same key with a *different* amount would produce a success
banner for an amount never applied. And the carrier's change-token doctrine makes a form's React key
deterministic and stable, removing the accidental index-shift remount that would otherwise refresh a
nonce some of the time — a nonce in the carrier turns an intermittent bug into a reliable one.

**There is no live violation.** The console's four were on the two retired screens — a rendered
`nonce` carrier and a nonce-keyed refund on Orders, and the two stock movements on Pricing &
inventory — and all four were deleted rather than relocated when those write paths were extracted:
the shipped keys are `admin-refund:${orderId}:${amountCents}:${observedSoFar}`
(`orders-actions.ts:642`) and `${productId}:${direction}:${onHand}:${qty}`
(`stockMovementKey`, `products-actions.ts:430-437`), both watermarked and neither random. X-28 is a
regression gate from here. This also keeps the document self-consistent: §2 already lists nonce
fields under `form` → forbidden, and F-2 already says a key is never something a human can see, pick
or alter — a render-time carried nonce satisfies neither half.

**F-2b — a field ANOTHER system owns is displayed, never given an input.** F-2 forbids fields the
operator must not *see*; this forbids inputs on values the operator must not *set*. Where a column
in our database is a **derived cache** whose writer is elsewhere — today the CMS content sync — the
screen renders it as a read-only `fields` row and offers no form field for it, however natural the
grouping looks. An input there would appear to work and be silently reverted by the owning system's
next write, which is the worst failure a console can ship: the operator sees a success banner and
loses their edit.

The two instances today, both on Pricing & inventory — which is now a React screen, while the port
type and wire that enforce this are the plugin's and are cited below — both owned by the CMS:

| Value | Owner | How it is actually changed |
|---|---|---|
| `active` / **Status** | `content:afterPublish` / `content:afterUnpublish` | publish or unpublish the CMS document |
| **Title** | `content:afterSave` / `content:afterPublish` | rename the CMS document |

Two supporting requirements, because a rule nobody can see at the point of editing is not a guard:

1. **Where the value has a row, label the row with its owner**, not just its name —
   `Status (set in the CMS)`, not `Status`. The parenthetical is where the merchant is already
   looking, and it is free; an explanation buried in a `context` line is not (and on this screen
   that line is already over the §1 budget). Shipped as one shared constant so both surfaces say
   it identically: `STATUS_FIELD_LABEL` (`admin-presentation/src/products-copy.ts:180-184`).

   **An owned value that IS the record's own handle needs no row and therefore no parenthetical.**
   Title is that case: it is the detail `header` (M-10), and INC-15 deleted the `fields` row that
   restated the H1 verbatim one block below it
   (`admin-react/src/products/product-detail.tsx:275-276`). A deleted row cannot carry an input, so
   F-2b is satisfied more strongly here than by a labelled one — this is a **stronger** compliance
   with the rule, not an exemption from it. Requirement 2 is what still guards it.
2. **The port type must refuse it.** Whatever backs the screen, the write input should not *have*
   the field, so re-adding a form control fails to compile rather than failing at runtime.
   `UpdateProductCommerceFieldsInput` (`domain/src/product-commerce/use-cases.ts`) does this for
   both `active` and `title`, and the plugin's own edit wire `ProductEditWire`
   (`admin-products-client.ts:122-142`) repeats it at the screen's own boundary — so a form control
   fails to compile on either side of the wire, on both surfaces.

X-52 rejects both the input and the owner-less label.

Reasoning for the Title instance, including why the cached column was kept rather than dropped:
[ADR-0013](../../adr/0013-product-title-is-cms-owned.md). A new instance of this shape needs its
own ADR — "who owns this field" is a decision, not a screen detail.

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
`buildEditWire` assigns conditionally only (`products-actions.ts:205-291`, with the
`// field not in the form ⇒ preserve.` comment at `:242`), every wire field is `.optional()`
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

The exact split per screen is enumerated in §12 where a screen has one — teams do not choose it.
**No surviving Block Kit screen splits a form.** The only instance is Pricing & inventory's
three-way edit split, which is now React: the split itself outlived the renderer, because it is a
property of the *update path* (a verified sparse PATCH — `buildEditWire` above) rather than of the
block vocabulary, and the one function still serves all three forms
(`products-actions.ts:188-194`). So F-5a-i is stated here rather than left to be rediscovered by
whichever Block Kit screen next earns a split.

**F-5c — a full-replace form is exempt from F-5, up to 8 fields.** Counted the way F-5 counts —
**authored**, i.e. before any `condition` is evaluated. *(Was "up to 8 **visible** fields", and its
instance was cited as "6 visible for `fixed_amount`, 7 for `percentage`". Corrected on two counts:
the basis is authored, which is what F-5's own sentence says and what makes the exemption decidable
without rendering; and the shipped figures are 7 and 8, at the cap rather than under it.)* Where
F-5a forbids
splitting, the budget cannot be met by splitting and dropping a field is data loss, so the form is
allowed to exceed 6. Cap 8. **Exactly one instance: the coupon edit form**, which authors **7**
fields for a `fixed_amount` coupon and **8** for a `percentage` one — at the cap, not under it
(`coupons-page.ts:1096-1175`; the extra field on `percentage` is `Discount cap`). No other form may
invoke F-5c; a second candidate is a signal that the update path should become a sparse PATCH.

**F-5c licenses the AUTHORED count; it does not license eight full-bleed inputs on screen.** The
two are different problems and the coupon form solves the second separately, with **F-5b's
`condition` inside the same submit**: one `toggle` — `Edit spend and use limits`,
`initial_value: false` — gates the four rarely-touched bounds, so the form opens at **four** visible
fields either way (the economics field, the two window dates, the toggle). Seven full-bleed inputs
stacked, five of them empty on a typical coupon, was the worst proportion offender in the console;
this is what fixed it.

**It could not have been a second accordion**, and that is worth knowing before someone proposes
one: an accordion holds *blocks*, and a form's fields are not blocks, so a second group means a
second **form** — which F-5a forbids here, because on a full-replace `PUT` saving one half nulls
the other (`coupons-page.ts:1049-1052,1066-1077`). A `toggle` + `condition` buys the same collapsed
shape inside one submit. **Reach for this pairing before widening a budget:** it hides nothing the
leaf does not already state as read-only text — the cap rides in `Discount`, the floor in
`Minimum spend`, and both use bounds in the Redemptions panel.

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
| Secret | **`text_input`, always empty**, with the contract in the **placeholder** (`blank keeps current`) | Never echo the stored value — which no variant does, so masking hides only the operator's own keystrokes. `secret_input` has **no live use** in the console after INC-09; whether a secret is *set* is a fact about the credential and belongs in the group's D-6 **label**, not in the field. A `secret_input` is not forbidden; it must earn its masking against a real shoulder-surfing threat, and echoing-the-stored-value is not one. |
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
that value is `""`, `null` or absent, so a control with **no `initial_value` at all** is blank
whatever its options look like. That is the whole of the argument and it is decidable from the
renderer alone; the counterexample that used to be quoted here was an Orders control and went with
that screen, and **no replacement is offered rather than one invented** — a rule that follows from a
cited renderer line does not need an exemplar. Rule 2 exists because `""` is the one value that is
*always* blank, and because it also trips `hasSelectedValue`; a non-empty `initial_value` alone fixes
the blank even if a `""` option stays.

**The `""`-valued-option inventory over `packages/plugin/src` is now EMPTY.** Its five entries were
all on the two retired screens and left with them; Coupons, Tax, Shipping, Reports and Settings never
had one, and every filter sentinel on those screens is a word (`"any"` — `tax-page.ts:674`). X-23 is
a regression gate from here.

**F-6a — verification.** Any increment touching a `select`, `radio` or `combobox` attaches a
screenshot showing the trigger is **non-empty**, and states in the PR what it reads. What to expect
differs by control, and revisions 1–3 got this wrong:

| Control | The trigger reads | Verified instances |
|---|---|---|
| `select` | the raw **value** (R-17a) | the coupon create form's type reads `fixed_amount` (`coupons-page.ts:731-736`); the tax rates filter's zone reads `any` (`tax-page.ts:674,688`) |
| `combobox` | the option **label** (R-17b) | the Coupons picker reads `Choose a coupon…` closed, and `SUMMER25 · 20% off · 3 uses` selected (`coupons-page.ts:689-700`) |

So a screenshot criterion asking for a "resolved label" is **unsatisfiable on a `select`** and must
not be written — but it is exactly right on a `combobox`, and a `combobox` screenshot that shows an
id is a **fail**. Revisions 1–3 named "the order picker reads a raw UUID" as the worst instance on
these screens; **that wart never existed** — every L-7 picker is a `combobox`, which is why the rule
survived that screen's retirement unchanged.

**F-6c — a `select`'s or `radio`'s option value is operator-visible, so it must read acceptably as
text.** This follows from R-17a and is a **new constraint on M-7/X-22**: on those two controls "the
label never contains the id" is necessary but not sufficient, because the *value* is what the trigger
shows. So sentinels are words (`any`, `none`), never `""` or `0`.

**F-6c does not bind on `combobox`** (R-17b — it renders the label), and that is what makes L-7's
"always `combobox` for a record picker" buildable. Where a value can only be an opaque id, the control
is a `combobox` or it is not a dropdown at all: the row-action drill-in would be preferable, but
it is unreachable on Block Kit (§14 item 2).

The worst *live* instance is now the coupon type `select`, whose trigger reads `fixed_amount`. That is
inside F-6c's tolerance — a word, readable, unambiguous — which is the whole point of the constraint.
**Revisions 1–3 named the Orders picker's "raw UUID" here; it was never real** (§0.2 E-a), and the
picker it referred to has since left Block Kit anyway.

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

One rule, applied identically on every screen.

> **DA-1.** An irreversible write is triggered **only** by a `button` carrying a `confirm` dialog with
> `style:"danger"`. A `form` may collect its inputs; a form submit may never be the trigger. The
> button itself is `style:"danger"` too — **except** under DA-2c's fan-out cap and on a DA-3a-v refusal
> render, the **two** places the red moves from the button into the dialog.

This resolves R-10 (forms cannot confirm) and removes the inversion the console shipped with, where
"Mark refunded" was red-with-confirm while "Cancel order (cannot be undone)" was a plain submit.

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

Used for: every delete (coupon, tax class, tax rate, zone, method, shipping rate). **This is the only
one of the three shapes with a live Block Kit instance** — all six danger buttons on the surviving
screens are DA-2 deletes (`tax-page.ts:363`, `:741`; `shipping-page.ts:488`, `:940`, `:1244`;
`coupons-page.ts:1329`), each a single button with a `confirm`.

**DA-2b — closed-set or already-known input: one button per value, no staging.** Render one danger
button per legal value, the value in `button.value`, and **name it in the confirm text**. No round
trip, no staleness window, no staged payload to decode.

> **No Block Kit screen builds this shape today, and none is planned.** Both instances were on the
> retired Orders screen and moved to the React console with it (ADR-0015), where the write handlers
> still enforce every clause below. The rule is kept in full because the shape is the console's answer
> to a closed-set destructive act and the next screen that needs one must not re-derive it — not
> because a listing somewhere still draws it.

- **Cancel order** (the worked instance, now React). The reason is a closed set. One danger button per
  reason, the reason **named in the confirm text**:
  *"Cancel this order as 'out of stock'? This is permanent and releases the held stock."*
  **Four buttons, not five:** `other` gets no button, because a bare `Other` button records no detail
  and a label promising detail (`Other (add detail below)`) promises a field the button does not have
  and points at a group that may be collapsed. Button labels are the **bare reason** — `Out of stock`,
  not `Cancel — Out of stock`; the group label and the confirm already say "cancel" twice. **The
  offered list is SHIPPED from the plugin, derived from the same constant the dispatch table derives
  the per-reason ids from** — `CANCELLATION_REASONS` and `ONE_CLICK_CANCEL_REASONS`
  (`orders-actions.ts:102-133`) — so the exclusion is stated once and a surface cannot post an id that
  does not exist (ADR-0015's first 2026-08-03 amendment; DA-6's derive-never-hand-list rule applied
  across a process boundary).
- **Refund the full remaining balance.** The majority path, so it gets one danger button
  `Refund $99.00 (full remaining)` whose `value` carries
  `{orderId, amountCents, refundedSoFarCents}` — the amount **and the observed watermark** — which is
  exactly what `refundOrderAction` re-checks (`orders-actions.ts:607-642`).
- **A status move (DA-6)** carries `{orderId, toState, state}` — `state` being the record state the
  operator saw. See DA-2a.

**DA-2a — DA-2b carries a watermark and re-reads, exactly like DA-3.** DA-2b has no *staging* window,
which is why revision 3 left it out; but a **rendered button ages** — an operator can sit on a detail
page for ten minutes while someone else moves the record. So every DA-2b button's `value` carries the
watermark the operator saw, and its handler runs DA-3a's re-read-and-compare before writing. The cost
is one request; the alternative is one class of write with no staleness check at all. **An absent
watermark refuses** — it is never a reason to skip the compare (DA-3a-iv).

This is why revision 3's Orders transition listing (`value {orderId, toState}`) was a defect: it made
**status moves the only destructive write on the console exempt from DA-3a** (§0.2 E-l). Transitions
are also the write most likely to race, because the state an operator is moving *from* is the thing
another operator is most likely to have changed. The shipped handler carries the fix
(`transitionAction`, `orders-actions.ts:248-291`).

**DA-2c — fan-out cap: above 4 values, the buttons go quiet and the dialog stays loud.** One danger
button per value is right at two or three. **This cap is about emphasis, not space** — `actions`
lays its elements out in a **single horizontal flex row** with intrinsically-sized buttons
(`actions.tsx:12`, `flex flex-wrap gap-2`), so five reason buttons are one wrapping row, not a
vertical wall, and invoking DA-2c buys **no height back and no scroll**. What it buys is the
emphasis: at five, a row of same-weight destructive controls becomes the loudest thing on a panel
whose likeliest next act is a small quiet routine one, and every button competes with every other
for the alarm that should belong to the act (§0.2 E-f) — the emphasis inversion §8 exists to remove.
**No Block Kit screen fans out at all today** (DA-2b's note), so nothing reaches this cap; it binds
the moment one does. So:

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
to **four** once `Other` goes (`ONE_CLICK_CANCEL_REASONS`, `orders-actions.ts:128-133` — `Other`
promised a detail field the button could not provide), and four is inside the cap. A 9-value enum is a
genuine DA-2c case; a 5-value enum is usually a listing that has not been pruned.

**DA-3 — free text or a typed amount: stage, then confirm. Two action ids.**
`<entity>:<verb>-review` and `<entity>:<verb>`. There is **no** `-edit` id.

> **DA-3 GOVERNS NOTHING TODAY, and this is stated rather than left to be discovered.** A grep for a
> `-review` id over `packages/plugin/src` returns **nothing**: the two flows that had one — Orders'
> refund and cancel, and Pricing & inventory's stock removal — were retired with their screens, and
> **the review halves were not ported**, because a React surface can show a confirm dialog over the
> values just typed and therefore composes its own. ADR-0015's two 2026-08-03 amendments record
> exactly which checks went with them, and are the reason DA-3c, DA-3c-i, DA-3a-v and DA-3a-vi are
> likewise dormant below. **Nothing here is relaxed.** A Block Kit form cannot show a dialog over its
> own values (R-10), so any future Block Kit screen collecting free text for a destructive act still
> has to build this shape, with all of it — and re-introducing a server-side two-step means *writing*
> the deleted checks, not restoring them.

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

Forcing both groups open instead breaks X-18 (§0.2 E-b). The resolution, and it is a rule rather than
a screen's choice because every screen that ever builds this shape will hit it:

> **The `:review` id and `default_open: true` go on the OUTERMOST group on the open path**, and its
> body on a state-2 render is the staged form plus the confirm button **directly**. The inner
> collect-group is **not rendered at all** in state 2. One changed id, one flag, confirm on screen.

So `orders:<id>:refunds:review` (not `…:refunds:refund-partial:review`), and the state-2 body of
`Refunds` is `banner` + staged form + confirm — the ledger, the meter, the capability line and the
full-remaining DA-2b button are all suppressed, because the operator is mid-decision on one amount and
a second refund control beside it is a trap. **A refusal is not the same case: it keeps the read blocks
its copy points at (DA-3a-vi), and suppresses only the controls (DA-3a-v).**

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
*(Dormant with DA-3 — no `-review` exists. The two that did were deleted as unreached surface, taking
this bound check with them; ADR-0015's two 2026-08-03 amendments record it, and record that the
reachable writes are bounded by the SERVICE instead — `REFUND_EXCEEDS_TOTAL`/`REFUND_EXCEEDS_CAPTURED`
on a refund, a guarded decrement on a stock removal. The rule below is what a future `-review` owes,
written as new work rather than restored.)*
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

**DA-3c-i — any `-review` that renders a confirm carrying a watermark RE-READS FIRST, and refuses on a
mismatch.** DA-3c's own title is "not only the confirm handler"; this is the general form of it and it
binds on every screen that has a `-review`. *(Dormant with DA-3 — none does.)*

A `-review` writes nothing, so it is tempting to treat it as pure formatting. It is not: it renders a
**button label and a `confirm.text` that are statements over a watermark** — *"Cancel this order as
'out of stock'? This is permanent…"*, *"Refund $99.00 to …?"* — and the confirm it draws carries that
watermark into `button.value` for the write to compare against. If the record moved between the form
rendering and this submit, the write **will** refuse (DA-3a), so the `-review` has rendered a
statement it already knows to be false, on the one step that exists to let an operator check exactly
that. **Rendering a statement the write will refuse is the defect the staged step exists to prevent.**

So the `-review` re-reads whatever the write will compare, and refuses per DA-3a-i when it differs —
naming the movement and its cause, not merely the mismatch. **The ordering is the part worth carrying
forward:** the watermark comparison runs **before** the DA-3c bound check, so the ceiling the bound
check judges against is one the operator has just been shown. Orders built exactly that and the code
is gone with it; the ordering is recorded here rather than in a file, and in ADR-0015's first
2026-08-03 amendment, because it is the half that is easiest to get wrong when someone writes this
flow again.

**The cost is one request, and it is priced.** DA-3a-ii already establishes that a staged or refused
round trip pays the level's whole read set rather than avoiding it; the `-review`'s own read is **one
more on top of that**, not free and not hidden. Nothing may buy it back with a client-side stash or a
carried record (DA-3a-iii property 3).

**Where this does not bind:** a `-review` whose staged confirm carries **no** watermark has nothing to
compare and needs no read. That is a shape, not an excuse — a destructive confirm without a watermark
is an X-38 violation on its own.

**Count your refusal sites before you start, and expect one you did not plan for.** Orders had **five**
handlers that could produce a refusal — its two `-review`s, its refund and cancel confirms, and
`transitionAction` — and the plan listed **four**. The missed one was a **`-review`**, because nobody
thinks of the staging step as a refusal site: it writes nothing, so it reads like validation. **Every
DA-3 flow has one**, and DA-3a-i binds on it exactly as it binds on that flow's confirm. Enumerate
your screen's refusal-producing handlers in the PR body and state which of them can refuse; a flow
whose `-review` is not on that list has not been counted. (Counting is still the point on a screen
with no `-review` at all: Tax and Shipping each refuse from a save handler and from a create handler,
and both are easy to miss for the mirror-image reason — a *create* does not read like a refusal site
either.)

**DA-3a — every confirm handler re-reads before writing. Mandatory, no exceptions.** An absent
watermark is itself a refusal, not a reason to skip the comparison (DA-3a-iv). **This is the one rule
of the DA-3 family that ADR-0015 restates as binding on every write that carries a watermark**, and it
survives verbatim on both extracted screens — `transitionAction` and `cancelOrderAction` re-read the
order (`orders-actions.ts:254`, `:489`), `refundOrderAction` re-reads the ledger (`:625`) and
`removeStockAction` re-reads the product (`products-actions.ts:510`). On Block Kit the equivalent is
a **service-side CAS** rather than a plugin-side re-read — Tax sends `expectedRateBps`
(`tax-page.ts:1281`) and Shipping `expectedAmountCents` (`shipping-page.ts:1673`), and the service
refuses `stale` — which satisfies the requirement more strongly, because the check and the write are
one statement. The handler takes the watermark out of the staged payload, **re-reads the record**, and
compares:

- **Match** ⇒ derive the key per F-2a and write.
- **Differ** ⇒ **apply nothing**, and re-render per DA-3a-i below with an `error` notice naming
  **both** figures **and the cause**:
  *"$20.00 was staged and was not recorded — someone else refunded this order since you started.
  $40.00 now remains refundable; re-enter an amount below to try again."* (162 chars ≤240.)

**The causal clause is not optional.** "The ledger changed" states an effect and leaves the operator
to guess whether they hit a bug; "someone else refunded this order since you started" is the fact, it
is what stops them retrying identically, and at 76 characters it is nowhere near the 240 budget. E-4
says say what is true — this is the case E-4 was written for.

The bug this closes: refunds are additive with no CAS and the form
defaults to full remaining. Operator A stages $99.00; operator B refunds $99.00; operator A's
dialog still says "Refund $99.00 to …" — a false statement — and posts it. F-2a's watermarked key
prevents the *silent swallow*; DA-3a prevents *acting on a stale amount*. Both are required, and
they compose: DA-3a rejects the stale submit before the key is ever derived.

**DA-3a-i — every refusal re-renders STATE 1 OF THE SAME GROUP, forced open, with the submitted values
prefilled.** Binds on **both** refusal kinds — DA-3a's stale watermark and DA-3c's failed bound check.
All four clauses, or the refusal is worse than the race it caught:

| Clause | Why |
|---|---|
| **the same group** | D-5's open-group algorithm has no idea a refusal happened. Re-render without render state and it falls through to Rule 2, opening whatever the record state suggests — on the retired Orders screen that was a group on a **different tab panel** — while the group the banner points at stays collapsed (§0.2 E-c). The render state the action passes is what tells the level a refusal happened (DA-3a-iii). |
| **forced open** | B-6, both halves: a changed `block_id` **and** `default_open: true`. A banner reading *"re-enter an amount below"* above a closed accordion is not an instruction. |
| **values prefilled** | The operator typed an amount, an optional reason and their name. Discarding all three to tell them to try again makes the safe path the expensive one, and the next thing they reach for is the DA-2b full-remaining button — which is not what they wanted. |
| **flattened onto that group** | The forced-open group is the **outermost group on the open path** (B-6, DA-3's outermost-group rule), so the refusal's body renders the collect form **directly** in it and the inner collect-group is **not rendered at all** — exactly as state 2 is flattened. Force the outer group open and leave the form inside a nested `default_open: false` child and the operator's rejected input is on the page but invisible, which is the "values prefilled" clause failing while passing an id check. |

D-5 Rule 1 covers this: a DA-3a refusal **is** a state-2-shaped response for open-group purposes — one
group forced open, every other `false`, X-18 satisfied. Say so in the render path; do not let the
refusal fall into Rule 2.

**The one shape these four clauses do not fit, and it is not an exemption.** All four are about a
**group with a collect form in it**. A DA-2b/DA-2a control that is a bare `actions` button — a status
move — has no group to force open and no operator-typed input to prefill, so its refusal passes **no
render state at all** and re-renders the level plainly, with the notice naming both figures and the
live state visible in the identity strip. `transitionAction` is still the worked instance, and the
reasoning is still recorded at the call site now that it is a structured action rather than a renderer
(`orders-actions.ts:244-246` — *"NO DRAFT IS RETURNED ON THE REFUSAL, and that is not an omission"*).
Everything else still binds: it applies nothing, it returns 200, and its copy names the cause (DA-3a,
E-7). A screen invoking this shape says so in its PR; a DA-3 flow may never invoke it, because a DA-3
flow always has a form.

**"State-2-shaped" scopes to which group is open, and to nothing else.** It settles `default_open` and
the `block_id`; it licenses **nothing** about the body. A refusal's body is **state 1** — its alert
banner, the collect form, the `Review …` submit — and it carries **no confirm control**, because the
payload a confirm would carry is the payload just refused. Re-offering it re-stages a stale amount
(DA-3a) or the very figure the bound check rejected (DA-3c) — a red `Refund $900.00` on a $50 order,
§0.2 E-d walking back in.

**"No confirm control" is the narrow case; DA-3a-v is the rule.** The general form is *no control that
would commit the class of act just refused*, and it is scoped to **the refused group, not the whole
response** — with a second half about the unrelated danger controls left loud on that render. Read
DA-3a-v before implementing this clause, and DA-3a-vi for what the body **keeps**: "state 1" leaves the
group's own read blocks undecided and DA-3a-vi decides them.

**DA-3a-ii — a staged or refused re-render costs the leaf's normal read set. Priced, not avoided.**
`showLeaf`/`showList` carry render state (DA-3a-iii), so a `-review`, a DA-3c refusal and a DA-3a
refusal all re-render **through the level's own `render`**: the reads are the level's, they happen
once per response, and the screen writes **no second read-and-render path**. On the Orders detail
that was measured at **five requests** — the order plus its four secondary surfaces — per click, not
the one the reference PR estimated. Nothing about the channel reduces that number; what it removes is a duplicate
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
the one to skip. On Orders those two left nothing safely skippable — every one of the four surfaces
fed a panel D-3 keeps rendering, and one of them carried the ceiling the refusal copy must name — so
five requests was the priced answer there, not a tuning target. The primary `load` is not branchable and
is not meant to be: it receives no render state, and it *is* the re-read DA-3a depends on. What is never
the fix: a client-side stash, or a nonce (F-2a).

**Two costs this paragraph does not cover, so do not read it as the whole bill.** A `-review` pays
**one more request** for its own pre-render re-read (DA-3c-i) on top of the read set above — it was
six on Orders, not five. And this paragraph prices the *skip* case only: a secondary read that
**fails** on a refusal re-render is DA-3a-vi's second clause, not a tuning decision.

**DA-3a-iii — the render-state channel: what it carries, and what it does not.** A custom action
re-renders through `api.showLeaf(path, notice?, renderState?)` or
`api.showList(path?, notice?, renderState?)` (`scaffold/list-detail.ts`, `CustomActionApi`). The third
argument is **positional and optional**; it is the screen's own type; the target level's `render`
receives it verbatim beside `notice`. A banner says **what happened**, render state says **what to
render now** — which group to open, which values to put back in a form — and DA-3a-i needs both at
once. Five properties, each binding:

1. **One discriminated union per screen, named at the handler.**
   `createListDetailHandler<TaxRenderState>({…})` (`tax-page.ts`; Shipping and Coupons each declare
   their own), members discriminated on `kind`. A level that
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
4. **`notFound` and the failed-action fallback get none, deliberately — and `notFound` loses the
   NOTICE too.** A form prefilled for a record that no longer resolves is a lie, and the fallback
   after a custom action throws must be the simplest render that can still work. `open`, `back`,
   `page` and `apply-filter` get none either: a staged view does not survive a "Load more", and must
   not. **State the notice half explicitly, because a refusal is where it shows:**
   `scaffold/list-detail.ts:552` passes `notFound` neither the render state nor the notice
   (`if (detail === null) return { blocks: level.notFound({ actions, path, id }) };`, documented at
   `:185-191`), so a refusal whose record stops resolving loses its banner as well as its prefill —
   the operator sees only "not found". Accepted, because nothing was written on any refusal path and
   the vanished record is the outcome that matters (§0.3 item 3). Do not read the missing banner as a
   bug, and do not route a notice into `notFound` to "fix" it.
5. **Money in render state is minor units or verbatim operator text, and the member name says which.**
   `…Cents: number` is integer minor units (M-3); `…Input: string` is what the operator typed,
   unparsed. A refusal prefills from the `…Input` member, because `19,99` or `900.00` cannot be
   re-derived from cents — that is the whole reason the draft members exist.

   **The operational tell, so `…Input` is not mistaken for defensive over-engineering:** the two
   commonest refusals on a money field are a **decimal comma** (`19,99`) and **three fractional
   digits** (`12.345`), and `parseMinorUnitsInput`'s pattern `/^(\d+)(?:\.(\d{1,2}))?$/`
   (`admin/money-input.ts`) rejects both. On exactly those paths the parse returned `null`, so there
   is **no `amountCents` in existence** to prefill from — the raw string is not a nicety, it is the
   only channel that can put the operator's figure back on screen. A screen that carries only
   `…Cents` blanks the field precisely when the operator most needs to see what they typed.

The five ways a screen gets this wrong. Each is a diff a reviewer can rule on:

| Mistake | What the operator gets | Reviewer's check |
|---|---|---|
| Render state set, group `block_id` unchanged (or changed with no `default_open: true`) | A banner pointing at a **collapsed** group | B-6, both halves, on the **outermost group on the open path** only — X-29, X-39 |
| Outer group forced open, collect form left in its nested `default_open: false` child | Rejected input on the page and invisible | DA-3a-i's **flattened** clause: the refusal body renders the form directly; the inner collect-group is absent |
| A loaded record in the channel, to save a read | The figures the re-read just proved stale | DA-3a-ii: no union member holds a record the level's `load` or secondary reads return |
| A formatted money string where minor units are expected, or `…Cents` where the operator typed `19,99` | A refusal that discards or mangles the amount | Property 5: every money-bearing member is `…Cents: number` or `…Input: string`, and the refusal prefills from `…Input` |
| Reading `renderState` for something the *next* click needs | A staged payload that vanishes on confirm | Property 2: anything crossing an interaction is in `button.value` or the `block_id` carrier |

**DA-3a-iv — AN ABSENT WATERMARK REFUSES. It is never a reason to skip the comparison.** X-38 counts
"a confirm handler that writes without re-reading", and **a comparison you skip is a re-read you did
not do**. So a `value.state.length > 0` / `if (watermark) { compare }` guard around the DA-3a check is
the X-38 hole dressed as tolerance: it lets a stale payload, or one edited in devtools, write
**unchecked** — which is the one class of write §8 exists to make impossible.

There are exactly two ways a watermark can be absent from a control this document requires to carry
one, and refusing is right for both: a `button.value` altered by the operator (B-1 — `value` is on the
wire and untrusted), or a browser tab rendered before the watermark existed, which **is** the stale
view DA-3a is for. Treat `""` and whitespace as absent: an empty state is not a state, and no
comparison against it can mean anything.

**Where it binds — state this precisely, because there is one deliberate exemption:**

| | |
|---|---|
| **Binds** | **Every handler that writes.** No exemption for a closed-set DA-2b button, a status move (DA-2a), or a DA-3 state-2 confirm. |
| **Binds** | **Every `-review` that carries the operator's watermark forward into the staged payload.** The staged confirm will be judged against that value, so a `-review` that stages an absent one has staged a confirm that cannot succeed. |
| **May be exempt** | A `-review` that **re-stamps the watermark from its own fresh read** may tolerate an absent one — it is not carrying the operator's value forward, so there is nothing to compare and the confirm it stages is against current truth by construction. **It must say so at the call site**, in one comment naming the re-stamp. An unexplained `!== undefined &&` guard is indistinguishable from the X-38 hole and a reviewer must fail it. |

**The binding half is shipped and cited; the exemption has no live instance.** `transitionAction`
refuses outright on an absent watermark **before any read** (`orders-actions.ts:252-253`),
`cancelOrderAction` refuses before its re-read (`:482-487`), and both route through `readWatermark`,
whose own docblock states the rule and enumerates every site that answers to it
(`orders-actions.ts:182-205`). Pricing & inventory does the same for a count rather than a state name
(`parseOnHand`, `products-actions.ts:170-182`; `removeStockAction` at `:501,509`). The **exemption**
row was written from a `-review` that re-stamped its watermark from a fresh read; that handler was
deleted as unreached surface (ADR-0015, first 2026-08-03 amendment), so **no code claims the exemption
today** — which is exactly the state a reviewer should expect, since an unexplained
`!== undefined &&` guard is indistinguishable from the X-38 hole.

**And the refusal NAMES THE REAL CAUSE.** Folding an absent watermark into the parse-failure branch is
a second defect on top of the first: it tells the operator to fix a field that is already correct. The
retired Orders `-review` did exactly that, and the extraction did **not** carry the fold across: the
refund handler groups an absent watermark with the other *payload-level* faults and says so at the
call site — four disjuncts, one branch, "none of the four is fixable by re-typing the amount"
(`orders-actions.ts:615-623`) — which is the opposite failure from blaming the amount field, and is
correct for the same reason. Both readings are E-7's rule one level down: **do not assert a cause you
do not have.** Where a screen *can* tell the causes apart, a watermark-absence refusal gets its own
branch, its own copy, and a prefill that keeps whatever did parse.

**DA-3a-v — A REFUSAL BODY OFFERS NO CONTROL THAT WOULD COMMIT THE CLASS OF ACT JUST REFUSED. And the
danger controls OUTSIDE that body go quiet.** This subsumes DA-3a-i's scoping note ("it carries
no confirm control") and generalises it: the test is not "is this the same button", it is **"would
clicking this commit an act of the kind this response just refused?"** If yes, it is absent from the
refusal body.

*(Dormant with DA-3, and with DA-2b: this rule needs a refusal render that is co-located with a
one-click equivalent of the refused act, and no surviving Block Kit screen has either half. It is kept
in full because the reasoning is the expensive part, not the code.)*

Do not implement this as a list of cases; the two on the retired Orders screen are only instances, and
both show that the re-offered control is *worse* than the one refused:

- **Refund, DA-3c bound check.** The rejected figure was **too high**. The only other refund control in
  the group is the DA-2b one-click **largest possible refund** — the one button a mis-keyed extra zero
  must not be one click away from. Suppressed.
- **Cancel, validation or movement.** The suppressed controls are the four DA-2b per-reason buttons.
  Each cancels **immediately, recording no detail** — which is exactly what the operator was in the
  middle of recording. Suppressed.

The refusal's copy names **one** route (the form directly beneath it), which is DA-7a's
one-route-per-line discipline applied to a refusal.

**Scope: the refused group, not the whole response.** This is the over-reading to avoid, and it fails
in both directions. DA-3a-v **removes** the controls *of the refused class* from *the group the refusal
re-renders*; it does not silence the screen. The rest of the panel — the identity strip, the other
panels, an unrelated create form, a quiet routine control — renders exactly as it always does. **The two
halves act on different things and do not conflict:** the first half **removes controls**, inside the
refused group only; the second half **changes one property of buttons that stay** — their `style` —
outside it. Nothing is removed outside the group, and nothing outside the group loses its `confirm`.

**The second half, and it is the failure mode this rule creates if you stop at the first.** Silencing
the related controls hands the alarm to whatever red is left. On the built Orders screen a **cancel**
refusal suppressed four red reason buttons and left a red `Mark refunded` — a move into a
**terminal** state (`domain/src/orders/state-machine.ts`: `refunded: []`), and bookkeeping whose own
confirm text says it *does not move money* — as the loudest thing on the panel, **directly above** the
very form the operator had just been told to re-submit: the transition row and the cancel group were
adjacent siblings, and the refusal force-opened the group immediately below that button row. That is
§8's opening inversion, rebuilt by a rule meant to remove it. So:

> On a refusal render, **every `style:"danger"` button outside the refused group drops its `style`**
> (default `secondary`). Its `confirm` is **untouched** and keeps `style:"danger"`. This is the
> **DA-2c quiet-buttons move**, and DA-3a-v is the **second** of the two places in this document where
> the red moves from the button into the dialog (DA-1, DA-5).

**The test is positional, not a relatedness judgment**, and deliberately so: "is this button related to
the refusal?" is the kind of question that makes a rule undecidable, and it is the wrong question
anyway — an operator reading a refusal is not weighing relatedness, they are reading whatever is
loudest. So the boundary is the refused group, which a reviewer can see in the JSON. Nothing becomes
less safe: the guard is the dialog (DA-1, DA-2c), and every one of those buttons still has one.

Emphasis is a **V-4 tier-3** claim (a screenshot), but the mechanism is tier 1: a reviewer counts
`style:"danger"` buttons in a refusal response and expects **none outside** the forced-open group.

**DA-3a-vi — A REFUSAL BODY IS STATE 1 *PLUS* WHATEVER READ CONTEXT ITS COPY POINTS AT — and its copy
may not name a control or figure the same render can omit.** DA-3a-i says the body is "state 1", which
settles the form and the submit and leaves the group's own read blocks undecided. Decide them here,
because both Orders behaviours were correct and neither was stated, so six teams would have picked at
random. *(Dormant with DA-3 — a screen needs a state 2 for the first row of this table to mean
anything. The second row still describes any refusal that names a live figure.)*

| Response | The group's read blocks (on Orders: `meter` · ledger `table` · capability `context`) | Why |
|---|---|---|
| **state 2** | **suppressed** | The confirm carries the watermark the operator *originally saw*; a freshly-read figure beside it is a **second reading of the wrong number**. Already required by DA-3's outermost-group rule. |
| **a refusal** | **kept** | The refusal's copy names the **live** figure and points at it — *"$40.00 now remains refundable"*, *"is more than the $50.00 that remains refundable"*. Copy that names a figure the render omits is not an instruction. |

The rule generalises to any screen: **keep exactly the read context the refusal's own copy refers to,
suppress the rest.** Orders implemented it in one place — the read blocks were pushed only when
nothing was staged, so a draft kept them and state 2 did not — which is the shape to copy: one
condition, at the point the blocks are assembled, never a per-block test.

**Second clause — a refusal's copy must not name a control or figure the render is allowed to omit.**
Where a refused group's body depends on a **secondary** read, that read can fail on the refusal
re-render, and E-1 correctly degrades a failed secondary read to a `context` line — which deletes the
control the copy was pointing at. On Orders the whole Money panel collapsed to one line when the
refunds read failed, and the refund group was reached only past that branch, so a banner reading
*"re-enter an amount below to try again"* would have sat above **no form, no group and no figure**.
D-3 and DA-3a-ii cover the *skip* case (a level branching its own secondary reads on `renderState`);
they do not cover the *failure* case. So:

- either the refusal's copy is written so it survives the degraded render (name the act, not the
  control: *"nothing was refunded"* rather than *"re-enter an amount below"*), **or**
- the degraded branch carries the refusal forward — its `context` line states that the submission was
  not applied, so the operator is not left with a vanished banner and an unexplained panel.

Pick one per screen and say which in the PR. What is **not** acceptable is copy that names a control on
a render that can omit it.

**DA-3b — a payload that fails to decode renders an `error` notice, never a silent redirect.** The
defect this replaced was `if (id === undefined) return showList()`, which bounced the operator to the
list with no explanation. The shipped shape is one named constant per screen, returned from every
undecodable branch: *"That action could not be read — nothing was changed. Reload the order and try
again."* (`UNREADABLE`, `orders-actions.ts:172-180`; the same shape at
`products-actions.ts:137-145`). Naming it rather than inlining it is deliberate — a payload-level
refusal is reached from a dozen branches and must read identically from all of them.

**DA-4 — non-destructive writes stay one-shot.** Plain `form`, no confirm, no danger: add note,
restock, save/rename, create, resolve reconciliation (it records a decision and moves no money —
say so in the copy, and never style it as danger).

**DA-5 — button colour means exactly one thing.** `danger` ⇔ **irreversible, or reversible only by
a separate manual operation an operator can forget.** Everything else is default `secondary`. A red
button without a `confirm`, or a `confirm` on an act outside that definition, is a review failure.

**`primary` has exactly one use, and it is enumerable (INC-14).** *(Was "`primary` is not used".)*
It marks **L-8's create button**, and nothing else, on the five surfaces that have one:
`coupons-page.ts:536`, `tax-page.ts:322` and `shipping-page.ts:406` (the two shared helpers, one
call each per level). The rule survives the addition because the colour still means exactly one
thing on each screen: `primary` is *the act this screen is for and no form's submit expresses* —
a create whose form lives on another screen entirely, so there is no submit button competing with
it. A second `primary` anywhere is a review failure, and a `primary` on a form submit is one too:
the form renderer's own submit is that form's primary affordance and takes no `style`.

**Two stated exceptions, and only two — both drop the button's colour and keep the dialog's.** DA-2c's
fan-out cap (≥5 values in one `actions` block) and DA-3a-v's refusal render (every danger button outside
the refused group). In both, `confirm{style:"danger"}` is untouched, so the biconditional above still
holds where it matters: **an act outside DA-5's definition never gets a `confirm`**, and the guard was
always the dialog. Do not read either exception as licence to invent a third.

**Exactly one act qualifies under the second clause: remove stock** — on the React Pricing &
inventory screen, and on any Block Kit screen that ever grows a stock movement. Restocking is not an undo — it
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

**And it must not be able to dispatch to a blank screen.** A single registered `transition` id with
the target in `value.toState` is safe; splitting it into **per-state ids** is what introduces the
hazard, and it is the split this rule requires. The offered transitions come from the **service**
(`detail.allowedTransitions`) while the registered ids are fixed at **module load**, and
`admin-route.ts` dispatches on set membership with a `{blocks: []}` fall-through at `:152`. So a
service offering a state outside the plugin's closed `ORDER_STATES`
(`admin-presentation/src/order-status.ts:31`) would render a control that can only ever refuse. So:

1. Derive the per-state ids from the `ORDER_STATES` constant and build the dispatch table from the
   same constant — one source, no hand-listing.
2. **Do not render** a service-offered transition that is not in that list.
3. Assert it: a stub returning an unknown state must produce no button and no blank page.
4. **Take the target from the action id, never from `value.toState`.** The id came from
   `ORDER_STATES`; `value` is operator-alterable (B-1). Emit `toState` in `value` for devtools
   legibility if you like, but do not read it.
5. **Carry the observed `state` in `value` and re-read before writing** — DA-2a. A transition is a
   destructive write and gets no exemption from DA-3a.

All five survived the write-path extraction and are now easier to check than they were as a renderer:
the dispatch table is built by mapping `ORDER_STATES` (items 1 and 3, `orders-actions.ts:761-767`),
the id set is read straight off that table so the gate and the table cannot disagree (`:782`), and
each handler closes over its own target so `value.toState` is never read (item 4, `:248`). **The
rule generalises past Orders and past the renderer** — DA-6's "derived, never hand-listed" is the
same rule ADR-0015 applied to the one-click cancellation reasons when a process boundary opened
between the two halves.

The UI steering stays: on a `processing` order the bare `shipped` move is withheld (use Fulfilment,
which records tracking), and `cancelled` is always withheld (use Cancel, which records a reason) —
`offeredTransitions`, `orders-read.ts:158-170`, which applies the `ORDER_STATE_SET` filter of item 2
in the same function. Each withheld move gets a DA-7 line, written per DA-7a.

**DA-7 — withheld actions: generalize the coupons pattern.** When a precondition knowably forbids
an action, render **no control** plus one `context` line stating the reason and the alternative.
Never a "disabled" button (R-11 — and after the foundation, a compile error).

The normative copy, ≤200 chars — **this blockquote is the spec, and the code is trimmed to it.**
The current string (`coupons-page.ts:492`) is 217 chars and says "3 time(s)":

> `This coupon has been redeemed 3 times — deletion is blocked to keep the redemption audit
> trail. To retire it, set its expiry to a past date.`

Applies to: coupon delete when redeemed; tax class / zone / method delete when referenced; edit and
stock forms on a soft-deleted product; refund action when nothing remains refundable; cancel when the
order is in a terminal state; every transition DA-6 steers away from. **On Block Kit the live
instances are the first two**; the rest are on the React screens, which inherited the rule.

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
- The wrapper both surfaces call is `formatAmount(minorUnits, currencyCode)`
  (`admin-presentation/src/format-money.ts:96-105`). It handles the negative case above and, on any
  amount `Intl` cannot format, **renders `UNFORMATTABLE` (`:62`) rather than raw minor units** — the
  M-1 violation it replaced was a `catch` returning `` `${currencyCode} ${minorUnits}` ``, i.e. raw
  minor units in the one place they are least visible. A wrong number is worse than a missing one, and
  **absent is not zero** — that dash is never `$0.00`. Where a block can contain one, emit one
  `context` line at the block level: *"One or more amounts could not be formatted and are shown as —."*

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
table  block_id <entity>:totals
       columns  Line (text) | Amount (text)          ← money last, T-2
       rows     Subtotal | Discount | Shipping | Tax | Total
       page_action_id <entity>:page   // never fires: no next_cursor, no sortable column
       (no empty_text — the ladder always has five rows)
```

The rule is about the **block type**, not the row order: the order-totals ladder that earned it
already emitted Subtotal, Discount, Shipping, Tax, Total in that order and still read across rather
than down, because `fields` is row-major (R-3). There is no reordering of `fields` entries that would
help — any earlier claim of a "reported bug" here is withdrawn. **No surviving Block Kit screen
renders a money ladder**, and X-10 is a regression gate.

**M-5 — snapshots are labeled once.** The order's line-item table gets one `context` line: *"Titles
and prices are what the buyer paid — later product edits never change them."* Nothing else on the
screen re-litigates it.

**M-6 — dates.** ONE dialect, from **`@otta-sh/admin-presentation`'s `datetime.ts`** — the module
moved into the shared package when Orders went React, so both surfaces render the same words;
`scaffold/datetime.ts` is now a re-export shim and not the implementation. An absolute instant renders
`8 Jul 2026, 10:30 UTC` (`formatTimestamp`) — day-first and spelled-month so it cannot be misread
the way `7/8/2026` can, minutes only, and the zone is part of the VALUE, so the label names the
event (`Placed`) and carries no `(UTC)` suffix. **A raw wire timestamp never reaches an operator**
(INC-13, enforced console-wide by X-13 inside `assertBlockContract`) — this supersedes the earlier
rule that `fields` show ISO trimmed to seconds. Tables use `relative_time` only where T-4 still
allows it; a field the detail screen also shows is absolute on both. Date-only bounds stay DAYS —
a `date_input` submits and prefills `YYYY-MM-DD`, and a day a merchant set never acquires an
invented time. A bound stated as a VALUE renders in the dialect, through `formatDate`: a coupon's
validity window reads `10 Jul 2026 – 1 Aug 2026` (`couponWindowSummary`, `coupons-page.ts:281-288`).

**Three date-only renderings, and the third is a RANGE HEADING rather than a value — do not unify
them.** All three are day-precision and all three are UTC-pinned; they differ in what the reader is
doing with the day.

| Rendering | Helper | Reads | Where |
|---|---|---|---|
| a single day as a value | `formatDate` | `10 Jul 2026` | a coupon's `Valid`, any date-only field |
| a **range heading** — the year stated once, at the end | `formatDay(day, withYear)` | `1 Jul – 31 Jul 2026`; `28 Dec 2025 – 3 Jan 2026` when the two days straddle a year | Reports' period subtitle (`reports-page.ts:285-290`, rendered at `:660-668`) |
| a machine day the operator typed or aligns rows by | *(none — verbatim)* | `2026-07-10` | see below |

`formatDay` is not a fourth dialect: it is `formatDate` with the year made conditional
(`admin-presentation/src/datetime.ts:181-185`), and it exists because a heading that reads
`1 Jul 2026 – 31 Jul 2026` states the year twice in eleven words. **The suppression is
conditional on the two days sharing a year**, computed per render — a cross-year range keeps both.

**Two surfaces keep `YYYY-MM-DD` on purpose** — the Orders filter summary's custom-period parts
(`from: 2026-07-10`, `activeFilterParts`, `admin-react/src/orders/orders-list.tsx:98-108`), which echo
back what the operator typed into a field they can reopen and edit; and Reports' `Period` **column**,
whose cells are the bucket KEYS its rows are aligned by rather than dates being read
(`reports-page.ts:1038-1042`, `bucketStart.slice(0, 10)`). A **relative** period contributes no date
at all — it names itself, `period: Last 7 days` (same function; the period vocabulary is
`orders-read.ts:44-54`). No timezone conversion anywhere: every rendering is UTC-pinned.

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

**M-9 — `banner.variant` is `default` | `alert` | `error`.** Nothing else. Otta's mirror allows
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

**B-7a — the prefill digest and the accordion key are TWO MECHANISMS WITH TWO JOBS. Neither
substitutes for the other.** B-7 states this for the filter panel; it is general, and conflating the
two is how a correct requirement acquires a false reason.

| Mechanism | Its job | Its evidence |
|---|---|---|
| `carriedForm`'s `__v` digest (plus B-3's watermark) in the **form**'s `block_id` | remounts the **form**, so a changed `initial_value` is actually read | R-12 (mount-only controls), B-3, B-3a |
| the **accordion**'s `block_id` | remounts the **group**, so `default_open` is re-read | R-14a (`accordion.tsx:14`), B-6 |

The accordion key does not refresh a form's values *as its job* — it happens to, because remounting a
container remounts its subtree (`renderer.tsx:78`). And the form key can never open a group, because
`default_open` lives on the accordion. **So neither reason may be given for the other's requirement**,
and a PR that justifies a changed accordion key by "otherwise the form keeps the old values" has stated
a reason a reader can falsify.

**The live instance is Settings, and it is the distinction in miniature.** The two token forms are a
plain, always-empty `text_input`, so `carriedForm`'s own prefill digest is **constant** and cannot
signal a save; a per-token **save generation** rides in the carrier *context* instead, bumped on every
successful non-empty submit, so the **form**'s `block_id` changes and the mount-only field remounts
blank (`settings-form.ts:587-596`, and the key pair at `:87-88`). **No accordion key moves, and none
should** — the thing that must clear is the form (X-50).

**The instance that taught the rule was Orders, and its lesson was a bad reason, not a bad
requirement.** A refusal there took a **third** accordion key (`…:cancel:refused` /
`…:refunds:refused`) and the call-site comments justified it as stopping the form from "showing the
amount the confirm just failed with". That reason did not hold — on every state-2 → refusal path the
**form's own** `block_id` already changed, either because its prefill changed (`__v`) or because its
carried watermark, rebuilt from the fresh read, changed. The requirement was still right, on the
ground the rest of §8 stands on: **the response must not depend on client open state it did not set.**
Reusing `:review` for a refusal leaves the group's visible state resting on the operator's click
history and on R-24 not having fired — the same defect DA-3's outermost-group rule was restated to
remove.

**B-8 — YOU CANNOT CLOSE A GROUP. Two visibly-open groups after a refusal are permanent, and that is
accepted. Do not try to close one by changing its key.** Ruled on in §0.3 item 1; this is the
normative form.

**The mechanism, cited.** `AccordionBlock` is `{type, label, blocks, default_open?}` plus
`BlockBase.block_id` and nothing else (installed 0.31.1 `validation-5vL6669b.d.ts:306-311`; upstream
`types.ts:360-365`). `default_open` is read **once, at mount** —
`useState(block.default_open ?? false)` (`blocks/accordion.tsx:14`, R-14a) — and the open state is then
local (`Collapsible.Root open={open} onOpenChange={setOpen}`, `:17`). There is **no close signal in
this vocabulary**: no `open` field, no imperative channel, nothing the server can send. The only thing
that makes a mounted accordion re-read `default_open` is a changed React key, i.e. a changed `block_id`
(`renderer.tsx:78`).

**Three consequences, each checkable:**

1. **`default_open: false` on an already-open group is a no-op.** So a screen with a D-5 rank that
   opens a group (Orders' rank 2, `fulfilment`) shows **two open groups after every refusal on that
   screen, permanently** — the rank-opened one and the refusal's. This is B-5 working as documented.
2. **X-18 and D-5 constrain the EMITTED RESPONSE.** At most one `default_open: true` per response;
   two expanded groups on screen is not a finding at any tier (X-18's own row, D-5's "constrains the
   emitted response" paragraph, V-4 tier 3's "nothing runs the other way").
3. **An implementer must NOT attempt to close a group by changing its `block_id`.** It would work —
   and it would **remount the group and discard the operator's unsubmitted input** in it, which is
   F-5a-i's documented hazard and the reason `filterRow()` was withdrawn (§0.1 A). On a refusal render
   this is at its worst: the operator has just been told to re-submit, and the cure destroys typed work
   in every other group to tidy up an appearance no rule objects to. **The cure is worse than the
   condition.**

**There is therefore no rule requiring other groups be forced shut, and B-8 forbids adding one.** A
`block_id` changes for the reasons B-3/B-3a/B-6/B-7 give — prefill changed, context changed, this
response is force-opening the group — and for no other reason. "To close it" is not one of them.

---

## 12. Per-screen block listings

Each Block Kit screen gets the same artifact: an abbreviated block-order listing plus the deltas that
are not obvious from it. Prose-only deltas are not startable, so there are none.

**§12.1 was Pricing & inventory and is deleted** (ADR-0015, sixth amendment) — that screen is now
React and this document does not govern it. Its number is retired rather than reused; §12.2–§12.7
keep theirs, and every "§12.N" reference elsewhere in this document still resolves.

> **N-1 applies to every listing below.** These were written before any screen was built and have
> **not** had the scrutiny the retired Orders listing accumulated. Where one conflicts with §5–§10 or
> §13, build the rule and report the line in your PR. Expect to find some: revision 3's Orders
> listing had five.

Throughout, `cf{ns, ctx}` is shorthand for **`carriedForm({ namespace: ns, context: ctx, form })`**
— the helper takes the whole `FormBlock` and returns it with `block_id` set, so a line reading
`form cf{...}` means "this form is produced by `carriedForm`", never "assign this token to
`block_id`". Every prefilling form goes through it (B-3a); **no §12 listing hand-rolls a form's
`block_id`.**

### 12.2 Coupons (`coupons-page.ts`)

```
── LIST ──
header      "Coupons"
context     "<count> · Search a coupon and open it. Discounts apply to the cart subtotal
             at checkout."                                            (L-1a; ≤140)
actions     block_id coupons:create-action                                       (L-8)
            [ button "New coupon" style primary → coupons:new ]
            ← ABOVE the data and above the notice banner; carries NO value (depth 0 has
              no path to carry). The FORM is on the create screen it opens, never here.
banner      (cond) notice
form        cf{"coupons:filter", {__path:""}}                1 field → INLINE (L-2)
            text_input "Code (exact match, case-insensitive)"   submit "Search"
section     (cond) filterSummary(["code: SUMMER25"]) + accessory button "Clear filters"
                   value { __path: encodePath([]) }                    ← depth 0
table       block_id coupons:list
            Code (code) | Status (text) | Discount | Valid | Uses | Min spend
            ← SIX columns — T-1a's one ratified exemption, at T-1's hard maximum
            ← `Status` is COMPUTED per render from the coupon's own fields:
              active / scheduled / expired / used up. Plain text, never a badge — a pill
              on every live coupon spends the heaviest ink on the least informative value,
              and every value except `active` already IS the exception spelled out, so this
              column needs no added mark                              (T-5, X-4)
            ← `Type` column DELETED: `Discount` already reads `20% off` / `$5.00 off` (T-5)
            page_action_id coupons:page ; next_cursor when present
            empty_text "No coupon matches that code."
empty       (cond unfiltered zero) title "No coupons yet" ·
            description "Create one to start discounting carts." ·
            actions [ button "New coupon" → coupons:new ]
            ← the SAME action id and the SAME words as the promoted button above: one act,
              named once, reaching the same create screen                (E-2, L-8)
empty       (cond FILTERED to zero) title "No coupon matches that code" ·
            description "Nothing came back for that search. Clear it to go back to every
                         coupon." · the `Clear filters` button, appended by the helper
            ← one act per state: the way IN is already on screen above, so this state
              offers only the UNDO                                       (E-2, INC-12)
form        (cond ≥1) combobox "Open coupon" options "<code> · 20% off · 3 uses"
            ← combobox, NOT select: the option VALUE is the coupon id (distinct from
              `code` — the create form authors both), and a select renders the value
              (R-17a, X-22). Corrected in revision 4; revision 3 said `select`.
            placeholder "Choose a coupon…"
            initial_value "none"                        submit "View / edit"

── THE CREATE SCREEN ── what "New coupon" drills into                             (L-8)
header      "New coupon"        block_id coupons:new:hdr
actions     [← Back to coupons]   ← the cancel verb re-lists the level came from; no path
banner      (cond) a refusal notice — ABOVE the form, because it explains the values the
                   form below has just put back
context     "ID, code, type and currency are fixed at creation — to change them,
             retire this coupon and issue a new code."                            (≤140)
form        block_id coupons:create        3 unconditional + 2 gated = 5 VISIBLE
            Coupon ID · Code · Type (select: fixed_amount | percentage)
            + condition-gated (F-5b):
              Amount off · Currency        condition {field:"type", eq:"fixed_amount"}
              Rate (%) · Discount cap      condition {field:"type", eq:"percentage"}
            `type` declares initial_value "fixed_amount"  ← required (F-5b, R-12b)
            submit "Create coupon"
── FIVE fields stay OFF the create form: `Starts at`, `Expires at`, `Minimum spend`,
   `Max total uses`, `Max uses per customer`. All five are editable and all five have a
   home in the detail's one edit form below. A coupon created without them is valid
   immediately, forever, unlimited and unrestricted — the common case — and dropping them
   is what keeps the create form at 5 visible instead of 8. `Minimum spend` in particular
   must NOT appear in both forms. ──

── DETAIL ── 2 panels (D-2a)
header      "Coupon — SUMMER25"                                                  (M-10)
actions     [← Back to coupons]
banner      (cond) notice
fields      block_id coupons:identity      6 entries
              Status   | Discount
              Type     | Uses
              Currency | Created            ← D-2a puts Created here
            ← the first entry is `Status`, not `Code`: the `header` above already reads
              "Coupon — SUMMER25", so a `Code` row would restate the H1 verbatim one block
              below it — the same duplication INC-15 removed from Products' Title. The row
              carries the computed status the list column shows instead    (P-3, M-10)
            ← `Created` carries no `(UTC)` suffix: the VALUE states the zone   (M-6)
            ← `Currency` reads "— (currency-agnostic)" when the coupon has none, never a
              bare dash: an absent currency is a FACT about a percentage coupon, not a
              missing value                                                    (E-3)
tab         block_id coupons:<id>:tabs   default_tab 0   panels ALWAYS 2

├─ panel "Coupon"
│    fields     block_id coupons:more    Minimum spend | Valid
│               ← read-back of the two fields whose form value is easiest to mis-read; the
│                 form below is the only place they are edited
│    accordion  block_id coupons:<id>:edit   default_open FALSE            ← AMENDED
│               label "Edit — 20% off · 10 Jul 2026 – 31 Dec 2026"               (D-6)
│               ← the window renders in M-6's dialect, never `2026-12-31`
│               ← CLOSED, not "per D-5 rank 3". The label carries the answer (D-6), which
│                 is what makes shipping it closed cost the reader nothing; and this is a
│                 render-time `default_open: false`, never a programmatic close — forcing a
│                 mounted group shut means changing its `block_id`, which remounts it and
│                 discards whatever the operator had typed          (B-8, X-50, F-5a-i)
│               └─ context "Saving replaces EVERY field below — this is a full replace, so a
│                           blank optional field saves as unset, not unchanged."  (≤200,
│                           trimmed from 613)
│                  context "Dates are UTC. A coupon becomes valid at the start of its start
│                           date and stops at the END of its expiry date. Blank either one
│                           for no bound."                                        (≤200)
│                  ← the domain window is `[startsAt, expiresAt)`, so a date read as
│                    midnight would retire the code a whole day before its stated expiry.
│                    Same whole-day, both-ends-inclusive semantics as Reports' range
│                    form (§12.5)                                                 (M-6)
│                  ── ONE form. NOT split — F-5a forbids it: `updateCoupon` is a PUT and the
│                     service coerces absent ⇒ null (`rules-admin.ts:434-443`), so a split
│                     "Discount" save would silently wipe startsAt / expiresAt / maxUses /
│                     maxUsesPerCustomer. It is F-5c's ONE instance, now AT the cap: 7
│                     authored fields for fixed_amount, 8 for percentage. The limits toggle
│                     (F-5b) is what keeps only FOUR of them on screen at once — a separate
│                     problem from the authored budget, solved separately.  ← AMENDED ──
│                  form  cf{"coupons:edit", {couponId, token:<hash of mutable fields>}}
│                        ← B-3: CouponWire has NO updatedAt, so the token is a stable hash
│                        the ECONOMICS branch is chosen by the coupon's IMMUTABLE `type`,
│                        so the server emits only the applicable field:
│                          fixed_amount →  Amount off (<currency>)            1 field
│                          percentage   →  Rate (%)                           1 field
│                        then, always visible:
│                          Starts at (optional, UTC) · Expires at (optional, UTC)  2 fields
│                          Edit spend and use limits          (toggle)            1 field
│                        then, GATED on that toggle (F-5b, R-23 — condition {eq:true}):
│                          Discount cap (optional)   ← percentage only
│                          Minimum spend (optional) · Max uses (optional) ·
│                          Max uses per customer (optional)
│                        ⇒ 7 AUTHORED for fixed_amount, 8 for percentage — F-5c's one
│                          instance, at its cap — and FOUR VISIBLE on open, either type
│                                                                        ← AMENDED
│                        ← the toggle is a DISCLOSURE control, not a coupon field: it
│                          reveals the four bounds an operator rarely touches. It declares
│                          `initial_value: false`, which F-6b/X-24 require and which R-12b
│                          makes load-bearing — an untouched toggle with no initial value is
│                          absent from `values` entirely
│                        submit "Save coupon"
│                  ── every editable field on `coupons-page.ts:1096-1175` has a home here:
│                     amount, ratePercent, cap, minSubtotal, startsAt, expiresAt, maxUses,
│                     maxUsesPerCustomer. None is orphaned. ──
│
└─ panel "Redemptions"
     fields     block_id coupons:uses     Redemptions | Max uses ·
                                          Max per customer | Remaining redemptions
                ← "Remaining redemptions", never a bare "Remaining": beside a count and two
                  caps, "remaining" could mean remaining uses, remaining per customer, or
                  remaining days                                              (M-11a)
                ← an unset bound reads "unlimited", not "—": no cap is a FACT about the
                  coupon, not a missing value                                    (E-3)
     meter      (cond maxUses set) label "Redemptions" value 3 max 100
                ← a COUNT, so custom_value optional (M-8); OMITTED ENTIRELY when there is
                  no bound — a full-width bar over no denominator is not a ratio  (M-8)
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
parametrized and correctly pluralised (`1 time` / `3 times`, `coupons-page.ts:1348-1350`), and the
delete `confirm.text` 301 → ≤200.

**This screen was the odd one out when it shipped; it is the rule now.** Its `Status` column was the
first place the console reasoned all the way through "badge the exceptions, leave the happy path
quiet" and concluded Block Kit cannot express it (`coupons-page.ts:580-604`). INC-10 took that
reasoning console-wide — Orders, Pricing & inventory and Reports all demoted their status badges to
plain text — and T-5 is its generalisation. One badge column survives anywhere: Shipping's `Type`.

### 12.3 Tax (`tax-page.ts`) — the per-row inline form fix

Today every row renders `divider` + edit form + delete button **simultaneously**: N rows cost
N × (48px + ~5 field rows). Both levels are lists; neither has a detail screen.

```
── LEVEL 0: tax classes ──                        L-9 branch: nextCursor null && ≤25 rows
header      "Tax classes"
context     "A tax class is a rate group; products and rates reference one by id."  (≤140)
actions     block_id tax:create-class-action                                       (L-8)
            [ button "New tax class" style primary → the create SCREEN ]
banner      (cond) notice
            ── NO filter block: this level has no filter fields (L-2, count 0) ──
── the row list (no table at this level; the labels are the columns) ──
accordion   block_id "tax:class:u1.<b64 {classId}>"     default_open false
            label "standard — Standard rate"        ← no count: TaxClassWire is {id,name},
                                                     a rate count is not on the wire (D-6)
            ├─ actions  [ button "View rates" → tax:open
            │             value { target: encodePath([classId]) } ]               (§12.7)
            ├─ form     cf{"tax:class-save", {classId, name}}
            │           Name                        submit "Save name"            (DA-4)
            └─ actions  (cond not referenced) [ "Delete class" danger + confirm,
                          value {classId} ]                                       (DA-2)
                        (cond referenced) context — the DA-7 line naming the references
            ── ORDER IS THE AFFORDANCE HERE, because there is no other (INC-16). A `form` is
               always `flex flex-col` in the pinned renderer (R-1), so these can never sit in
               a horizontal row with the primary on the end — every control is a full-width
               stack item, and the only thing left to say "this one first" is WHICH ONE IS
               FIRST. So the COMMON path (open the class's rates) leads, the rename it wraps
               follows, and the destructive delete goes LAST.
               The DA-7 `context` line between the form and the delete is the SPACER: Block
               Kit has no spacer block and `divider` is off the vocabulary (R-4, §2), so the
               separation between "edit this" and "destroy this" is carried by a block that
               also earns its height — it states the refusal BEFORE the click, where the
               confirm dialog's own copy only appears after. ──
── the create SCREEN (what the button opens) ──
header      "New tax class"   ·   actions [← Back]   ·   banner (cond) refusal
form        Class ID · Name        submit "Create tax class"
── L-9 fallback branch (>25 rows or a next page) ──
table       block_id tax:classes   Class ID (code) | Name
            page_action_id tax:page ; next_cursor when present
            empty_text "No tax classes yet."     ── plus the L-7 drill-in form,
                                                    and editing moves to a rate-level list ──

── LEVEL 1: a class's tax rates ──
header      "Tax rates — standard"
actions     [← Back to tax classes]   value { __path: encodePath([]) }
context     "Each rate applies to purchases shipping to one zone."                (≤140)
actions     block_id "tax:create-rate-action:<classId>"       ← per-LEVEL, not per-screen:
            this level exists once PER CLASS, so an unsuffixed id would repeat across
            sibling renders of different classes                        (B-2b)   (L-8)
            [ button "New tax rate" style primary → the create SCREEN
              value { __path: encodePath([classId]) } ]   ← depth 1, the path is REQUIRED
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
            label "7.25% — United States · std-us · goods only"        ← AMENDED (D-6)
            ← THE RATE LEADS THE LABEL (INC-16). It used to trail the slug
              (`std-us — United States · 7.25% · goods only`), which starts every row's
              number at a different x — the id is the one part whose width varies most, so
              the column of figures an operator is actually scanning was ragged. Leading
              with the percent puts every rate within a few px of the same left edge. Same
              move as Shipping's method price (§12.4).
            ← `goods only` / `also shipping`, never the raw `appliesToShipping` boolean
              and never a raw enum                                       (P-5, F-6c)
            ← the zone NAME with `?? zoneId` fallback, from the ONE `listZones()` this
              level performs per render — one extra read, not N              (D-6)
            ├─ form     cf{"tax:rate-save", {rateId, rateBps:"725",
            │                                  appliesToShipping:"false"}}  ← B-3 token
            │           Rate (%) · Applies to shipping (toggle, initial_value REQUIRED F-6b)
            │           submit "Save rate"                                        (DA-4)
            └─ actions  [ "Delete rate" danger + confirm, value {rateId} ]        (DA-2)
── the create SCREEN (what "New tax rate" opens) ──
header      "New tax rate"   ·   actions [← Back]   ·   banner (cond) refusal
form        Rate ID · Zone (select) · Rate (%) ·
            Applies to shipping (toggle)        submit "Add tax rate"
── L-9 fallback: table  Rate ID (code) | Zone | Rate | Applies to shipping (`yes` / `—`,
   plain text, NOT a badge — T-5, X-4) + drill-in ──
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
context     "A zone groups the shipping methods you offer for a set of destinations." (≤140)
actions     [ button "New shipping zone" style primary → the create SCREEN ]       (L-8)
banner      (cond) notice        ── no filter (0 fields) ──
accordion   block_id "ship:zone:u1.<b64 {zoneId}>"
            label "us — United States"     ← NOT "· 3 methods": ShippingZoneWire is
                                             {id,name,regions}; the count would cost up to
                                             200 extra reads per render (D-6). Filed, not
                                             fanned out. This level does NOT fan out; the
                                             methods level below does, under D-6c.
            ├─ form     cf{"ship:zone-save", {zoneId, name, regions}}
            │           Name · Regions (comma-separated)   submit "Save zone"     (DA-4)
            ├─ actions  [ "View methods" → shipping:open
            │             value { target: encodePath([zoneId]) } ]                (§12.7)
            └─ actions  (cond no methods) [ "Delete zone" danger + confirm ]      (DA-2)
                        (cond has methods) context — DA-7 line
── the create SCREEN ──  header "New shipping zone" · [← Back] ·
   form Zone ID · Name · Regions

── LEVEL 1: a zone's methods ──                                       (L-9 branch, limit 200)
header      "Shipping methods — us"
actions     [← Back to shipping zones]        ── no filter (0 fields) ──
context     '"Flat rate" always charges its rate; "Free shipping" charges nothing above
             its threshold.'                                          ← AMENDED (≤140)
            + ON THE PRICED BRANCH ONLY, appended:
              ' Prices in USD — "No rate set" means no USD rate.'                (138)
            ← HUMANIZED AND QUOTED. The wire values stay `flat_rate` / `free_shipping`;
              only the operator-facing copy is human, and the quotes tie each name to
              the words the row labels above render                    (P-5, F-6c)
            ← the currency clause is SCOPED, not unconditional: it claims a currency
              only on the branch that priced in one, and it carries the whole meaning
              of `No rate set` — stated ONCE here rather than per row       (D-6c)
actions     block_id "ship:create-method-action:<zoneId>"     ← per-LEVEL, not per-screen
            [ button "New shipping method" style primary → the create SCREEN
              value { __path: encodePath([zoneId]) } ]        ← depth 1           (L-8)
accordion   block_id "ship:method:u1.<b64 {methodId}>"
            label "$4.99 — Standard shipping · standard · flat rate"   ← AMENDED  (D-6)
            ← THE PRICE LEADS THE LABEL (INC-16): it is the number the operator came to
              this level for, and leading with it starts every row's amount at the same
              left edge. Same move as the tax rate (§12.3).
            ← the price is a PER-ROW `getRate`, which D-6 forbids in general and D-6c
              ratifies here: `Promise.all` over at most 25 rows, because the fan-out runs
              ONLY on this L-9 accordion branch. Read D-6c before copying it.
            ← degrades PER ROW, never per level: "No rate set" (no rate for the currency),
              "Price unavailable" (that row's read failed), "Price not loaded" (the table
              branch, which fires no rate reads at all)                    (E-1, E-3)
            ← `flat rate` / `free shipping`, never the raw wire enum        (P-5, F-6c)
            ├─ form     cf{"ship:method-save", {methodId, name, type}}
            │           Name · Type (select: flat_rate | free_shipping)
            │           submit "Save method"                                      (DA-4)
            ├─ actions  [ "View rates" → shipping:open
            │             value { target: encodePath([zoneId, methodId]) } ]  ← FULL path,
            │                                                        never a bare id (§12.7)
            └─ actions  (cond no rates) [ "Delete method" danger + confirm ]      (DA-2)
                        (cond has rates) context — DA-7 line
── the create SCREEN ──  header "New shipping method" · [← Back] ·
   form Method ID · Name · Type
── L-9 fallback table: Method ID (code) | Name | Type ← `Type` KEEPS ITS BADGE — a 2-value
   closed set an operator distinguishes at a glance, and the ONLY `format:"badge"` left in
   the whole console (T-5's own exception). The badge renders the HUMAN name (`Flat rate` /
   `Free shipping`): the raw enum was the last operator-facing place this screen leaked
   one, and a badge is the loudest possible frame to leak it in (P-5) ──

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
context     "1 Jul – 31 Jul 2026 (UTC) · Revenue is net order totals on paid-and-later
             orders, bucketed by order time."                    ← AMENDED (INC-02, ≤140)
            ← THE PERIOD LEADS, in absolute dates. The screen used to state the definition
              of revenue and never the window it applied it to, so a figure covering 30
              days read equally well as all-time or as today.
            ← the range renders in M-6's RANGE-HEADING form, via `formatDay`: the year is
              stated once, at the end (`1 Jul – 31 Jul 2026`), and both years when the
              range straddles one (`28 Dec 2025 – 3 Jan 2026`). This is the third of M-6's
              three date-only renderings and it is NOT `formatDate` — see M-6's table.
banner      (cond) the fail-closed error banner, variant "error"                  (E-1)
banner      (cond) a range problem — what was asked for vs what is being shown
form        the range form (INC-02): the period the four tiles and every group below
            report on. Its own bounds are whole days, both ends inclusive — the console's
            ONE date-bounds semantics, shared with the Coupons validity window
            (§12.2) and with the React Orders period filter                      (M-6)
stats       max 4 items (R-16). ALL FOUR ARE FILLED in the ordinary single-currency case
            (INC-02 — the screen used to ship blank cards):                ← AMENDED
              "Revenue (USD) — last 30 days"     value formatMoney(cents, "USD", "en-US")
              "Orders — last 30 days"            value the count
              "AOV (USD) — last 30 days"         value formatMoney(...)
              "Refunded (USD) — last 30 days"    value formatMoney(...)
            ← EVERY LABEL CARRIES THE PERIOD, because a tile is the one thing on this
              screen read without scrolling to the line that states it. It reads
              "last 30 days" on the default range and the absolute
              "1 Jul – 31 Jul 2026" otherwise                                (M-6)
            ← NO description on any tile; the `description: "integer minor units"` line is
              DELETED (M-1)
            ← MULTI-CURRENCY: one Revenue card PER currency, ranked by ORDER COUNT — not
              by revenue, which would compare JPY minor units against USD minor units, and
              amounts in different currencies are NEVER summed (M-2). Extra revenue cards
              push Orders/AOV/Refunded off the four-card cap, and the tiles that lost their
              slot are NAMED in one `context` line below rather than vanishing silently
            ← a REFUND-ONLY currency gets NO revenue card: a currency that appears only
              because money came back is not one the store earned in, and a phantom
              `€0.00` card would push the Refunded card off in exactly the case it exists
              to report. Its figure is stated in its own currency, in one line
            (zero currencies ⇒ one card, label "Revenue", value "—",
             description "No orders in range")
accordion   block_id reports:revenue    label "Revenue by day"           ← AMENDED
            ← NO "(N buckets)": a bucket is this codebase's word for a GROUP BY, not the
              operator's word for anything, and with the series now continuous the count
              only restated the length of the range                        (X-19, D-6)
            default_open TRUE            ← the one open group (S-3)
            └─ context (cond: the series was NOT filled) — a sparse series is never left
                       to look continuous; the group says so, in one line, above the rows
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
            └─ table  Status (text) | Orders (number)   page_action_id reports:page
                      empty_text "No orders in range."
                      ← Status is PLAIN TEXT (INC-10) and the reason differs from every
                        other screen's: this table's values DO chunk — it is one row per
                        status — so X-4 was never going to fire on it. The badge went for
                        the OTHER half of T-5: every row got the identical pill, so the
                        report's whole point (which of these numbers is the one to worry
                        about?) rendered `paid` and `failed` at exactly the same weight.
                        The cell says the exception in words instead: `cancelled · closed`
accordion   block_id reports:top        label "Top products (10)"      default_open false
            └─ context (cond: the range spans several currencies) — revenue is not shown
                       per product, because the wire carries no per-product currency and
                       summing across currencies is not a thing (M-2)
               table  Product | Qty (number) | Revenue (formatMoney)
                      page_action_id reports:page   empty_text "No sales in range."
accordion   block_id reports:low        label "Low stock (3)"          default_open false
            label     "Low stock (3) — at or below 5"   ← when the threshold is known (D-6)
            └─ table  Title | SKU (code) | On hand (text)      ← AMENDED (INC-03, INC-05)
                      page_action_id reports:page
                      empty_text "Nothing low on stock."
                      ← `Title` LEADS: a SKU is what the operator types, not what they
                        recognise, and a low-stock list read only as codes was the one
                        report nobody could act on without a second screen. A missing
                        title reads `(untitled)`, never blank              (T-2, M-10)
                      ← `On hand` is TEXT, not `format:"number"`, because it carries the
                        exception mark — `0 · Out of stock`, `3 · Low` — from the SAME
                        shared helper the React Pricing & inventory list uses:
                        `onHandCell` (`admin-presentation/src/product-status.ts`),
                        which is why the two surfaces cannot disagree     (T-5, T-4)
```

**Why no chart.** `chart` cannot format money (R-19): a timeseries renders raw minor units on the
axis and in tooltips, and plotting major units instead puts a display float on the money path,
which this document forbids (M-1/M-3). A formatted two-column table is correct and is not a
compromise.

**`page_action_id` must be registered as a no-op — and it now is.** The four tables used to omit it,
violating the authoritative type (R-21), and adding it alone would not have been enough: the
dispatcher routes an action interaction by set membership and falls through to `{blocks: []}` — a
blank console — for anything it does not recognise (`admin-route.ts:152`). There was no
`REPORTS_ACTION_IDS`. **There is now**, and it carries two ids rather than one:
`REPORTS_PAGE_ACTION_ID` and `REPORTS_RANGE_ACTION_ID` (`reports-page.ts:120-123`), dispatched at
`admin-route.ts:138-140`.

**The dispatcher's action branch names FIVE screens, not seven.** `SETTINGS_ACTION_IDS`,
`REPORTS_ACTION_IDS`, `TAX_ACTION_IDS`, `SHIPPING_ACTION_IDS`, `COUPONS_ACTION_IDS`
(`admin-route.ts:135-149`). `ORDERS_ACTION_IDS` and `PRODUCTS_ACTION_IDS` are **not** in that list
and their actions do **not** dispatch through Block Kit: those ids are React console actions, gated
**before** any page-load or action branch by `CONSOLE_INTERACTIONS`
(`admin-route.ts:101-110`) — a read names its `resource`, an act names its already-namespaced
action id, and Orders is the deliberate fallthrough so an unrecognised read comes back as a
handler's own refusal copy rather than as `{blocks: []}`.

**Register the ids in the SAME change as the `page_action_id`s, never after.** Nothing can fire on
the four report tables — a sort needs `sortable` (forbidden, T-3) and a load-more needs `next_cursor`
(never set on them) — so an unregistered id is a latent trap that arms itself the instant someone
adds one without the registration. That is the general rule; Reports is now the worked example of
having done it in the right order.

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
── ALL THREE GROUPS RENDER `default_open: false` (INC-15). ZERO open groups is legal:
   S-3 caps at one per response and sets no floor. Each LABEL carries its own current
   values instead, which is why closing them costs the reader nothing.  ← AMENDED (D-6)
accordion   block_id settings:store
            label "Store — <display name>"  |  "Store — no display name"
            default_open FALSE                                            ← AMENDED
            └─ form  cf{"settings:store", {displayName}}                         ← S-4
                     text_input  "Store display name"   initial_value <kv value>
                     submit "Save display name"          → save-display
accordion   block_id settings:checkout
            label "Checkout & holds — 15 min hold · low stock at 5"
                  |  "Checkout & holds — not loaded"   ← when the secondary GET failed:
                     the label says so rather than implying a zero (E-3, D-6b)
            default_open FALSE
            └─ context "These persist in the commerce service and affect live checkout."
                                                                                  (≤200)
               form  cf{"settings:ops", {holdTtl, lowStock}}                     ← S-4
                     text_input  "Cart hold TTL (minutes)"   initial_value "15"
                     text_input  "Low-stock threshold"        initial_value "5"
                     ← both were `number_input`; F-6 routes non-money integers through
                       text_input with one `/^\d+$/` parse. They are NOT money, so
                       `number_input` was not a violation — this is consistency, not a fix.
                     submit "Save operational settings"       → save-operational
accordion   block_id settings:connection
            label "Service connection — token set · service token not set"
            ← the PROVISIONING question this group exists to answer. "token set" is a fact
              ABOUT the credential, never any part of it: only booleans reach the label
            default_open FALSE
            └─ context "Both tokens are stored write-only — a blank submit keeps the current
                        one. Neither is ever displayed."                          (≤200)
               form  cf{"settings:admin-token", {gen:"<save generation>"}}       ← AMENDED
                     text_input "Admin token (X-Internal-Token)"
                     placeholder "Enter new admin token (blank keeps current)"
                     ← PLAIN `text_input`, always empty. NO `secret_input`, NO `has_value`,
                       NO `initial_value`                              ← AMENDED (INC-09)
                     submit "Save admin token"                → save-token
               form  cf{"settings:service-token", {gen:"<save generation>"}}
                     text_input "Service token (X-Service-Token)"
                     placeholder "Enter new service token (blank keeps current)"
                     submit "Save service token"              → save-service-token
               context (cond) "Admin token saved." / "Service token saved."
                       ← never the value (F-6)
```

**Why the masked variant went, and why the carrier had to grow a `gen` (INC-09).** Both are one
change and neither works without the other.

- **`secret_input` bought nothing here and cost clarity.** The field is *always* empty — the stored
  token is never echoed under any variant — so masking dots an operator's own keystrokes while
  displaying nothing that needed protecting. The **placeholder** carries the whole contract in
  words: `blank keeps current`. What the group could not previously say — *is a token set at all?* —
  is now in its **label**, from booleans alone.
- **A plain, always-empty `text_input` cannot self-clear after a save.** It is mount-only (R-12) and,
  inside an accordion, it is its container's index-0 child forever (R-13a), so nothing remounts it
  and the operator's typed token stays on screen after a successful save. The fix is B-3's change
  token with no record field to derive it from: a per-token **save generation** counter, bumped on
  every successful non-empty submit and carried in the `carriedForm` context, so the `block_id`
  changes and the field remounts empty (`settings-form.ts:87-88,160-162,295,326,587-593`).
- **This is B-7a's distinction in miniature**: the digest/context change remounts the **form**, and
  it is the *form* that must clear. No accordion key moves, and none should — X-50.

Two defects this fixed beyond layout, both now shipped:

1. **The display-name save used to destroy the page**, returning `[header, section]` — two blocks —
   so after saving, the operator's Settings page became a receipt and the other three forms
   vanished, terminally (S-5). Every save path now returns the full screen plus a `default` banner
   and the `toast`. The `section` receipts are deleted (P-2: a `section` is not a heading and not a
   receipt).
2. **All four forms need a carrier change token** (S-4, B-3, B-3a). Without it a saved value does
   not redisplay: the forms are mount-only `text_input` (R-12), and once collapsed into an accordion
   each is its container's index-0 child (R-13a), so nothing remounts them. The two token forms have
   no record field to derive a token from, so they carry a **save generation** counter instead — see
   the note above.

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
review catch. **32 of the 53 rows are H, and `assertBlockContract` SHIPPED** —
`packages/plugin/test/helpers/block-contract.ts`, called once per rendered response by every screen
suite. You call it; you do not hand-roll it.

**Three caveats it states about itself, and they matter more than the count.** (1) Some **H** rows
are **not** implemented, on purpose, each with a `NOT IMPLEMENTED` comment naming why — an honest
"cannot be decided without guessing" beats a heuristic that false-positives across six screens
(the X-9 / X-11a failure modes §0.2 E-i and E-j already record). (2) X-29, X-39 and the payload
half of X-38 are inherently **cross-response** claims and stay the calling screen's own
before/after test — a single-`blocks` signature has no earlier response to compare against.
(3) There is **no per-rule opt-out**: every implemented check runs on every call, so a screen
cannot suppress the one rule it fails today. A row the helper does not implement is a human review
catch, exactly as every non-**H** row is — named, not silently dropped.

| # | H | Reject | Rule |
|---|---|---|---|
| X-1 | H | A form field labeled with an internal name (`orderId`, `nonce`, `currency`, `expectedRateBps`, `Scope`, `Revision`, `Product`). | F-2, F-4 |
| X-2 | H | Any `select` with one option. | F-3 |
| X-3 | | A heading whose entire body is "No X" — heading + empty table for an empty collection. | P-3, D-7 |
| X-4 | H | A column of identical badges (`physical`, `USD`, `yes`, `manual`), or more than one badge column in a table. A badge column whose values are constant *within one rendered response* is the case the helper can see; a column constant only *in practice* is a human catch. | T-5 |
| X-5 | | A `disabled` field on any element (a compile error after the foundation), or a control rendered only to reject the click. | R-11, DA-7 |
| X-6 | H | Any `divider`. | R-4, §2 |
| X-7 | | An **expanded** filter form above the data, or any block above the primary data that P-1's whitelist does not list. A create **form** above the data is this row; the one-button create `actions` block is on the whitelist (L-8). | P-1, P-4, L-4, L-8 |
| X-8 | | A destructive form submit with no confirm, or a red button on an act outside DA-5's definition. **Or** a second `style:"primary"` on one screen, or a `primary` on a form's submit — `primary` marks L-8's create button and nothing else. | DA-1, DA-5, L-8 |
| X-9 | H | Money as raw minor units, or `number_input` / `format:"number"` on a money field or column. **Helper heuristic** (a helper cannot otherwise tell raw minor units from a legitimate integer): reject a cell or `fields` value matching `/^\d+$/` whose label matches `/amount\|total\|price\|revenue\|cost\|subtotal\|discount\|refund/i` **and does NOT match the count exclusion `/count\|recorded\|quantity\|qty\|items/i`.** Anything outside the heuristic is a human catch. | M-1, M-3, T-4 |
| X-10 | H | A money ladder in a `fields` block instead of a two-column `table`. | M-4 |
| X-11 | H | Any string over an **authored** §1 budget: page-level `context` 140, any other `context` 200, `banner.description` 240, `accordion.label` 60, `confirm.title` 60, `confirm.text` 200, `empty.description` 200. **Seven, not eight** — the `fields`-value 40 is explicitly **excluded** (X-11a). | §1 |
| X-11a | | A `fields` value over 40 chars **that the author wrote** — prose that belongs in a `context` line, or an address crammed into one entry. **Human catch only, never H:** the value is usually service data, so a 45-char buyer email or a tracking URL busts the budget through no authoring fault, and truncating a tracking number or URL destroys the operator's ability to copy it. Emails, tracking numbers, URLs and free-text reasons are left intact. | §1 |
| X-12 | | `header` used for a subsection beyond P-2's one-per-panel exception; `section` used as a heading or a receipt. | P-2 |
| X-13 | H | A raw wire timestamp on any operator-facing surface — an ISO instant of any precision, milliseconds, or a non-UTC offset. Every instant renders through `scaffold/datetime.ts`. | M-6 |
| X-14 | H | `sortable: true` on any column. | T-3 |
| X-15 | H | Any `columns` or `chart` block. | §2 |
| X-16 | H | A conditionally-present `tab` panel; `default_tab` other than 0; a panel count differing from D-2's table. | D-3, D-4 |
| X-17 | H | A form without an explicit `block_id`; a context-carrying `block_id` with no `:u1.` segment; a prefilling form whose `block_id` did not come from `carriedForm`. | B-1, B-3, B-3a |
| X-18 | H | More than one `default_open: true` **per rendered response**. **Counted on the emitted JSON only.** A screenshot showing two expanded groups is **not** an X-18 finding: client-side open state survives a re-render with an unchanged `block_id`, so a group opened by an earlier response stays open through a response carrying `default_open: false` (B-5) — and on any screen with a D-5 Rule-2 rank this is **permanent and accepted** (B-8). | D-5, B-5, B-8 |
| X-19 | | A bare-noun accordion label where a count or total is available *on the wire the level already reads* (D-6). | D-6 |
| X-20 | H | The phrase "no oversell" / "oversold" / "overselling" in any **rendered string**. Code comments documenting the domain invariant are exempt and must not be changed. No live violation on any screen; a regression gate. | voice |
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
| X-34 | | **The N-1 catch.** A diff that follows a §12 listing line against a §5–§10 rule or a §13 anti-pattern; **or** a correct deviation from a listing that the PR body does not disclose. Both are fails; the first ships a bug, the second leaves six teams to rediscover it. | N-1 |
| X-35 | H | A destructive `accordion` whose label is a bare verb or noun (`Cancel order`, `Delete zone`, `Refund a different amount`) with no consequence clause. | D-6a |
| X-36 | H | A D-6 label containing a degenerate ratio — `$0.00 of $0.00`, `0 of 0`, `0%` of nothing. | D-6b |
| X-37 | H | **More than 4 `style:"danger"` buttons in one `actions` block**; or a DA-2c fan-out whose `confirm` lost its `style:"danger"` along with the button's. | DA-2c |
| X-38 | H | A DA-2b/DA-3 `button.value` carrying no watermark, or a confirm handler that writes without re-reading. Countable on the payload; the re-read is asserted by the screen's own stale-watermark test. **A comparison skipped because the watermark was absent is this row, not an exemption from it** — see X-46. | DA-2a, DA-3a, DA-3a-iv |
| X-39 | H | A DA-3a or DA-3c refusal that does not re-render **the same group**, forced open per B-6, with the submitted values prefilled and **flattened onto that group**. Assert the refused response's open-group id equals the staged group's, the form's `initial_value`s echo the submission, and the nested collect-group is absent from the response. | DA-3a-i |
| X-40 | | A `-review` handler that validates only parseability — no bound check against the live ceiling. (The missing **re-read** is X-47.) | DA-3c |
| X-41 | H | A `context` or `banner` line containing `deliberately`, `there is no`, or `we do not`; a DA-7 line with no actionable verb. | DA-7a, E-4 |
| X-42 | H | A fail-closed banner that names a single cause (`Could not reach the commerce service`) rather than E-7's normative copy. | E-7 |
| X-43 | | A `Total` rendered on the same screen as a smaller `Captured`/`Settled`/`Allocated` with no M-11 line; or a bare `Remaining`/`Available`/`Left` label. | M-11, M-11a |
| X-44 | | A T-8 cap `context` line emitted when the read was **not** truncated. | T-8a |
| X-45 | | A split form set (F-5a) with **no** panel-level sibling-discard `context` line, or that line repeated inside each form's group instead of appearing once above them. Also: any PR that justifies the sibling-discard hazard by claiming the groups are collapsed — open state is sticky (B-5), which is why F-5a-i requires the line. | F-5a-i |
| X-46 | | A watermark comparison **guarded on the watermark's presence** (`if (value.state) { compare }`, `value.state.length > 0`) — an absent watermark must refuse, not skip the check. Also: a watermark-absence refusal folded into the parse-failure branch, so the copy tells the operator to fix a field that is already correct. **Not H** — nothing in the emitted blocks shows it; the screen's own absent-watermark test (zero POSTs) is the gate, and the `-review` re-stamp exemption is a comment a reviewer reads at the call site. | DA-3a-iv, X-38 |
| X-47 | | A `-review` that stages a confirm carrying the operator's watermark **without re-reading** what the write will compare. **Not H** — asserted by the screen's own test that a `-review` submit issues a read before it renders, and refuses when the record moved. | DA-3c-i |
| X-48 | H | A refusal body carrying **any** control that would commit the class of act just refused — the confirm, a DA-2b one-click equivalent, a second form with the same submit. **Or** a refusal response carrying **any** `style:"danger"` button **outside** the refused group (they drop `style`; their `confirm` keeps `style:"danger"`). **Or** the over-reading in the other direction: a refusal that suppresses controls elsewhere on the screen. Countable on one response: no `style:"danger"` outside the forced-open group, no confirm-id button inside it, and every button that dropped its `style` still carrying its `confirm{style:"danger"}`. | DA-3a-v, DA-3a-i, DA-5 |
| X-49 | | A refusal whose copy names a control or a figure the **same render** can omit — e.g. "re-enter an amount below" on a render whose group depends on a secondary read that may have degraded to a `context` line (E-1). Also: a refusal body that drops the read context its own copy points at, or keeps read context nothing points at. | DA-3a-vi, E-1 |
| X-50 | | **Any attempt to close a group.** A changed `block_id` whose only purpose is to make an already-open accordion re-read `default_open: false` — it remounts the group and discards unsubmitted input (F-5a-i). Also: a PR, plan or review comment treating two visibly-open groups after a refusal as a defect. **Not H** — it is a cross-response tier-1 assertion (V-4 tier 1) plus a review catch, not a property of one response. | B-8, D-5, X-18 |
| X-51 | | A sandbox fixture **hand-copying** a domain table (the order state machine, a closed enum, a legal-transition list) instead of importing it. A copied stub passes forever while testing a wire shape the service cannot produce. | V-3b |
| X-52 | H | A form field for a value another system owns — the two known owned keys are `active`/Status and Title, both CMS-owned. **Or** an owned value given a read-only row whose label omits the owner (`Status`, not `Status (set in the CMS)`). Countable on one response: no form field whose `action_id` is an owned key, and every owned key **that has a row** carrying its owner parenthetical in that row's label. **Title has no row** — it is the detail `header` (F-2b requirement 1, second half) — so a Title row appearing at all is this row, parenthetical or not. **Both instances are on Pricing & inventory, which is now React**, so the helper has no live Block Kit violation to find and this row is a gate on the next screen to render a CMS-owned field. The structural guard is unaffected by the renderer: `ProductEditWire` has no member for either (`admin-products-client.ts`), so a form control fails to compile on either surface. | F-2b |

---

## 14. What Block Kit cannot do — and what the React console does about it

*(Heading corrected in the docs sweep. It read "What a fork change would simplify (not required by
this spec)", which described a route the body has ruled out since the D1 decision: there is no fork
and these are not fork items. The item numbering below is load-bearing — this document cites
"§14 item N" in a dozen places — and is unchanged.)*

**Fork work is not pursued.** Under D1, the EmDash fork is out of scope entirely: Otta runs
stock `emdash@0.31.1` / `@emdash-cms/blocks@0.31.1` from public npm, pinned exact — no fork
branches, no fork builds, no upstream PRs, no `patchedDependencies`. Block Kit is frozen. A
capability it lacks is reachable **only** by migrating that screen to the React admin console
(`format: "native"` + `adminEntry`), per ADR-0014 — see that file for current status. The five
items below record what Block Kit cannot do and stays unable to do; none is being patched.

**Two screens have now taken that route: Orders and Pricing & inventory** (ADR-0014 Decision 6, both
shipped). So items 1, 2 and 5 below are **still true of Block Kit and still true of the five screens
that stay on it** — Coupons, Tax, Shipping, Reports, Settings — and are retired only on the two React
screens. Read every "unreachable" below as *unreachable on Block Kit*, which is what it always meant;
ADR-0014 forbids migrating Tax, Shipping and Settings, so for those three it is permanent.

1. **A mid-level heading — `header.level?: 2|3` or `section.style?: "heading"`.** There are
   exactly two text weights (R-5), so a tab panel is a stack of grey accordion triggers with no
   visual hierarchy between them. The research in §0 names the missing mid-level heading as the
   single biggest cause of the flat look, and P-2's "at most one `header` per panel" exception
   exists only because Block Kit has no substitute. Unreachable on Block Kit; only the React
   console can add real heading levels.
2. **`TableBlock.row_action_id`** (R-7). Would delete every "Open X" form (L-7) and every
   button-in-row drill-in (§12.7), and let registry levels stay real tables with drillable rows
   instead of accordion lists — which would in turn retire L-9's dual-branch requirement. Absent
   from stock 0.31.1 and staying absent; the React console is the only path (also the subject of
   the Orders/Pricing migration steps in the ADR-0014 tier).
3. **`select` renders its option *value*, never its *label*** (R-17a), and `SelectElement` has
   no `placeholder` either (R-17). Kumo 2.6.0's own `Select` already accepts `items`/
   `renderValue` and `placeholder` — the gap is Block Kit's `elements/select.tsx`, not Kumo —
   but with no fork there is no path to change it.

   **Downgraded in revision 4.** Revisions 1–3 valued this item on the claim that the order
   picker's trigger reads a raw UUID. It does not — the picker is a `combobox`, which already
   passes `items` and already renders the label (R-17b), and it already has a `placeholder`. So
   this item's real scope is `select` **only**, its worst live instance on the five screens that
   remain is the coupon type reading `fixed_amount` (the cancellation reason reading
   `customer_request` was the instance named here until ADR-0015 retired that screen), and F-6c
   makes that tolerable indefinitely — the fix, if ever taken, is a React field, not a patched
   `select.tsx`.
4. **`"tab"` absent from `validateBlocks`' `BLOCK_TYPES`** (R-15 — re-verified absent in
   0.31.1). The type, builder and renderer already exist; only the validator's allow-list is
   missing it. Runtime is unaffected (`validateBlocks` is invoked nowhere in the runtime or
   admin app), but any test or tool that validates these blocks reports `Unknown block type
   'tab'`. No upstream PR is filed under D1; live with the validator gap.
5. **A clickable link — `format:"link"` on a table column, or a `link` element.** A tracking
   URL is the one value on these screens whose entire purpose is to be followed, and the
   vocabulary can only render it as text the operator selects and copies. That is a **renderer
   limit, not an authoring error**: do not "fix" it by shortening the URL (X-11a) or by dropping
   the field. A tracking URL renders in full, in `fields`, and the group's label carries the
   tracking *number* — permanently, absent a React migration. **The one screen that had a tracking
   URL took that migration** (ADR-0015), so this item currently has no live instance on Block Kit;
   it is stated as a renderer limit, and it binds the next screen to hold a followable value.

A sixth would be nice but is not needed: **per-value `Badge` variants** (R-6) — or, more modestly,
a per-CELL `format` at all, since `formatCell` reads only `col.format`. Either would let a status
column mark its exceptions instead of pilling every row identically. Until then, T-5's rewritten
discipline is the correct one: no status column is a badge column, and the exception is marked in
the cell's own words.

Two upstream nuisances are recorded here rather than tracked as items, because neither affects
rendered output: `ComboboxList` emits a React duplicate-key warning even when every option value is
unique (upstream, not filed under D1), and the EmDash admin does not honour Playwright's
`fullPage` (the content region clips at the viewport, so screenshot with a **tall viewport** —
1440×1800/2200 — not `fullPage` alone).

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
| Orders † | `orders-page.sandbox.test.ts` | 1541 | 40 | **89** | **17** | **14** |
| Shipping | `shipping-page.sandbox.test.ts` | 902 | 31 | 18 | 0 | 3 |
| Products † | `products-page.sandbox.test.ts` | 783 | 22 | 23 | 0 | **7** |
| Tax | `tax-page.sandbox.test.ts` | 653 | 21 | 9 | 0 | 3 |
| Coupons | `coupons-page.sandbox.test.ts` | 1029 | 26 | 5 | 0 | **6** |
| Reports | `reports-widget.sandbox.test.ts` | 148 | 3 | 3 | 1 | 0 |
| Settings | `settings-widget.sandbox.test.ts` | 268 | 7 | 4 | 0 | 0 |

**† These two suites no longer exist.** They were deleted with their screens under ADR-0015, which
also states the terms: **exactly two suites go, and only because the screen each one tests no longer
exists** — no remaining suite is skipped, weakened, made conditional or narrowed, and ADR-0006
Decision 1 is reaffirmed there. Their behavioural assertions moved onto the extracted action modules
(`orders-actions.sandbox.test.ts`, `products-actions.sandbox.test.ts`) and only the *rendering*
assertions died. **The rows stay** because the measurement is what this section argues from and it is
dated; re-measuring the five that remain would not change the argument.

**There is no `reports-page.sandbox.test.ts`.** Reports and Settings are covered by
`reports-widget.sandbox.test.ts` and `settings-widget.sandbox.test.ts`. Orders was the outlier on
every axis and the only screen using `section` blocks as headings — which is exactly why it was the
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

**V-1a — each screen ports its OWN suite, as the first commit of its own PR.** When this rule was
written, `blocksOf()` was hand-rolled in **six** suites (`admin-scaffold-list-detail`,
`settings-widget`, `coupons-page`, `products-page`, `shipping-page`, `tax-page`) and all six were
unported. Revision 3 said "all six switch"; Orders correctly ported only its own and flagged the rest
(§0.2 E-r), because `CLAUDE.md`'s one-PR-one-thing beats V-1's literal wording and absorbing five
foreign suites into a layout PR makes it unreviewable. **The rule worked**: every surviving *screen*
suite now imports `findBlocks`/`group`/`panel` from `test/helpers/blocks.js`, the `products-page`
suite went with its screen, and what is left hand-rolling `blocksOf` is the two **scaffold** suites
(`admin-scaffold-list-detail`, `admin-scaffold-render-state`), which are not screens and have no lane
of their own.

So the rule is per-screen and it is a **sequencing** rule, not a cleanup wish:

> Every screen's PR opens with a **behaviour-free commit** porting that screen's suite onto
> `findBlocks`/`panel`/`group`. `git diff` over `packages/plugin/src` must be **empty** for that
> commit, and the same test count must pass before and after.

A flat search is safe *today* on a screen that is still flat, and returns `[]` silently the moment
that screen is re-laid — which is the failure mode where the suite passes while asserting nothing.
Porting after the re-layout means you never see the port pass against the old tree.

**Your PR ports your suite and nobody else's — §15.1 step 3 was four PARALLEL lanes.** Do not plan on a
predecessor's port having landed: you have no predecessor. `admin-scaffold-list-detail` is not a screen;
it ports with whichever lane touches the scaffold first, and the other lanes must not assume it has.

**V-2 — Orders' suite is rewritten onto these helpers BEFORE its layout changes**, as a separate
**no-behaviour-change commit**, so the layout diff stays reviewable. 89 flat searches and 17
section-heading assertions cannot be reworked in the same commit as a re-layout and still be
reviewed. *Done in PR #161 (`aa2bd97` → `3c7f037`); V-1a generalised it to the other six.*

**V-3 — one shared `assertBlockContract(blocks, { screen, level })`** in
`packages/plugin/test/helpers/`. The two extra arguments are not optional: **X-16** cannot be
decided from the blocks alone (it must compare the panel set against D-2's per-screen table) and
**X-27**'s second half cannot either (it must know whether this response is a leaf detail). It
enforces every rule marked **H** in §13 (**32 of 53**), the **seven** authored prose budgets (not the
`fields`-value 40 — X-11a), and the banned phrase. Every page suite calls it once per rendered
response. **A rule not in that helper is advisory** — it is a human review catch, and a PR that only
runs the helper has not verified the non-**H** rules.

**V-3a — V-3 SHIPPED, in its own PR, and no screen wrote it.** It lives at
`packages/plugin/test/helpers/block-contract.ts` (with its own suite beside it,
`block-contract.test.ts`) and **every** Block Kit screen suite calls it — Coupons, Tax, Shipping,
Reports and Settings. It shipped calling seven; the Orders and Products suites went with their
screens (ADR-0015), and the helper is unchanged by that: it judges an emitted block tree and the two
screens that left stopped emitting one. The terms it shipped under, which stand for any successor:

| | |
|---|---|
| **Owner** | **Its own `[Plugin]` PR.** No per-screen PR may carry it. Shared test infrastructure bolted onto a layout diff is exactly the drive-by `CLAUDE.md` forbids, and — the general form of it — **no screen should write the thing that judges it.** |
| **Sequencing** | **After** the Orders increment merged (it builds on `test/helpers/blocks.ts`, which Orders delivered) and **before** any further per-screen increment started. |
| **Hoisted** | The X-20 banned-phrase guard (which had been Orders-only), X-11's seven budgets, X-9's heuristic **with its count exclusion**, and the H rows added in revision 4 (X-35..X-42) and by its third amendment (X-48). |
| **Signature** | `assertBlockContract(blocks, { screen, level })` — as above, unchanged. |

**Why the gate was hard and not a preference.** §15.1 step 3 was **four concurrent lanes**. Had the
helper landed after them, four screens would each have hand-rolled ~31 checks and all four would have
needed retrofitting — the same duplication V-1a exists to stop, one level up and four times over.

**What is still a human catch, and this is the part that outlives the shipping news.** The helper
declines several **H** rows rather than guessing at them, each marked `NOT IMPLEMENTED` with its
reason at the point of declining; and X-29, X-39 and X-38's payload half are cross-response claims a
single-`blocks` signature cannot see, so they remain the calling screen's own before/after test.
**Do not claim an H rule verified because the helper ran** — check that the helper implements the
row you are claiming. And do not claim one verified because it "reads right".

### 15.1 Increment order — where your screen sits

The order the programme was actually run in. It was **not** a suggestion; step 2 was a gate. (The
plan's increment numbers map on as 3 · 3a · 5 · 5-last — see
[`plans/admin-ui-density-cleanup.md`](../../plans/admin-ui-density-cleanup.md), whose own screen
counts predate ADR-0015 and were not updated with it.)

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
- **Products was last on purpose**, and it is where the helper's banned-phrase guard was first pointed
  at something real — the two live X-20 violations were there. **Both were fixed**, so the guard has
  no live violation to point at on any screen; it is a regression gate from here. Being judged by the
  helper is a different job from writing it.

**All four steps merged, and the two screens at either end of the table have since left Block Kit
entirely** (ADR-0014, then ADR-0015 — see §14 and the sixth amendment). Orders and Pricing & inventory
render from `@otta-sh/admin-react` and are gated by Playwright as well as by the sandbox suites on
their extracted action modules; **their Block Kit twins have been deleted.** This table is the record
of the order the programme was run in, not a plan with work left in it.

**V-3b — three wire-shape facts a suite gets wrong silently.** All three cost an afternoon and none
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
- **The fixture is part of the contract — IMPORT the domain's table, never copy it.** A hand-copied
  stub passes forever while testing a wire shape the service **cannot produce**, which is the worst
  kind of green. That is what happened here: the old Orders responder derived `allowedTransitions` from
  a hand-written ternary returning `paid`'s row for every state it did not special-case
  (`test/orders-page.sandbox.test.ts:378-383`, as it stood before that suite was retired), so it offered
  `processing` **from** `shipped` — which the domain forbids outright — and omitted the legal
  `delivered`. The real service returns `[...legalNextStates(state)]` with no narrowing whatsoever
  (`service/src/routes/admin.ts`), so the fixture must be `ORDER_STATE_MACHINE[order.state]` imported
  from `domain/src/orders/state-machine.ts`. That fidelity is load-bearing, not tidiness: a
  `processing` order's legal targets *include* the bare `shipped` the plugin must steer away from
  (DA-6), and a `shipped` order's *include* `refunded` — a **terminal** state (`refunded: []`) — which
  is the whole reason a transition carries a watermark (DA-2a). Neither assertion is expressible
  against a guessed table. X-51 rejects the copy.

**V-4 — three verification tiers. State which tier a claim rests on; do not blur them.**

| Tier | What it covers | Gate |
|---|---|---|
| 1 — JSON-checkable | Budgets, vocabulary, §5/§6/§7/§9, and §10's invariants expressed as *"the token changed / did not change between these two responses"*. Includes: a DA-3 state-2 accordion carries **both** a changed `block_id` and `default_open: true` (where a screen has one — none does today); the filter **accordion**'s `block_id` is identical across an apply *and* across `Clear filters`, while the filter **form**'s `block_id` differs after an apply **and** after `Clear filters`, whenever the prefilled values changed; a depth-3 open fired from a `button`; an L-9 level branches to accordions at 25 rows and to a table at 26. | the workerd-on-Node sandbox suite |
| 2 — renderer behaviour | B-4, B-5, B-6, D-3, R-13a — claims about what the renderer does with a key. *(Was: "One test each in the upstream `emdash-cms/emdash` repo's `packages/blocks/tests/`, cited in the PR", gated on "upstream test suite". Withdrawn — under D1 there are no upstream PRs and no fork, so that gate names a repo this project cannot write to, and a tier-2 claim had no reachable evidence at all.)* **You cannot write a test for these.** Under D1 there are no upstream PRs and no fork, so there is no repo to add a renderer test to, and the sandbox suite renders blocks without a DOM. A tier-2 claim is therefore discharged **by citation plus its tier-1 shadow**: cite the pinned 0.31.1 renderer line that establishes the behaviour (§0's "verification basis"), and assert in the sandbox suite the *emitted* property the behaviour depends on — that the `block_id` changed, or did not, between two responses. Never claim tier 2 verified from a passing suite alone; the suite proves the token, the citation proves what the token causes. | pinned-renderer citation + the tier-1 token assertion |
| 3 — density and appearance | P-1..P-4, F-6a's non-empty triggers (per-control, per its table), §16's residual flatness, DA-2c's fan-out **emphasis** (the button row's weight, not its height), D-6a's labels next to their buttons. **Screenshot only.** Nobody may claim these verified from a passing suite. **Nothing runs the other way:** a screenshot is not evidence for a tier-1 claim, and specifically not for X-18 (see its row — open state is sticky). | attached screenshot |

### 15.2 The eight things a following team predictably gets wrong

Every item below is a rule elsewhere in this document; this is the index, ordered by how expensive it
is to get wrong, and each line is phrased so a reviewer can rule pass/fail. Read it before you start
and again before you open your PR.

**Items 2, 3, 5 and 6 all describe a DA-3 flow, and no Block Kit screen has one** (DA-3's note). They
are kept, unranked and unedited, because this list is ordered by *cost when you get it wrong* rather
than by *how often it comes up* — and the first screen to build a staged confirm again will get all
four wrong in one PR if they are not here to be read first. Items 1, 4, 7 and 8 bind today.

| # | The mistake | The rule | What a reviewer checks |
|---|---|---|---|
| **1** | Trying to **close a group** — or filing two open groups after a refusal as a defect. There is no close signal in this vocabulary; the only way to force one shut is a changed `block_id`, which **remounts it and discards unsubmitted input**. | **B-8** (§0.3 item 1), R-14a, D-5, X-18, F-5a-i | No `block_id` changes for the purpose of closing a group (X-50). Two expanded groups in a screenshot is **not** a finding. |
| **2** | Reading "no confirm control" as **screen-wide** instead of scoped to the refused group — and its flip side, leaving a danger button **outside** that group as the loudest thing on a refusal render. | **DA-3a-v**, DA-1, DA-5 | In a refusal response: **no** `style:"danger"` outside the forced-open group, every such button keeps its `confirm{style:"danger"}`, none inside fires the flow's confirm id, and no read block or form elsewhere on the screen is suppressed (X-48). |
| **3** | Guessing whether a refusal keeps the group's **read context** (meter, ledger, capability line). State 2 suppresses them; a refusal **keeps** them. Both are correct and only one was previously stated. | **DA-3a-vi** | State 2's body is banner + staged form + confirm and nothing else; the refusal's body carries exactly the read blocks its copy names (X-49). |
| **4** | Conflating the **prefill digest** with the **accordion key**. `carriedForm`'s `__v` remounts the *form*; a changed accordion `block_id` remounts the *group* so `default_open` is re-read. Neither substitutes for the other, and neither may be given as the other's reason. | **B-7a**, B-3a, B-6 | No PR text justifies a changed accordion key by "the form would keep stale values", or a changed form key by "otherwise the group stays shut" (X-17, X-29). |
| **5** | Under-counting **refusal sites**. Orders had five; the plan listed four. The missed one was a **`-review`**, because a step that writes nothing does not read like a refusal site. Every DA-3 flow has one — and on a screen with none, a *create* handler is the one that gets missed for the mirror-image reason. | **DA-3c-i**, DA-3a-i | The PR body enumerates the screen's refusal-producing handlers and includes every `-review` and every create. |
| **6** | Copy that names a **control the render can omit**. If a refused group depends on a secondary read and that read fails, E-1 degrades the body to a `context` line and "re-enter an amount below" sits above nothing. D-3 and DA-3a-ii cover the *skip* case, not the *failure* case. | **DA-3a-vi**, second clause | Either the refusal copy survives the degraded render, or the degraded branch carries the refusal forward — and the PR says which (X-49). |
| **7** | Mistaking a draft's **`…Input` raw-string members** for defensive over-engineering. `19,99` and `12.345` are the two commonest refusals on a money field and neither survives a round trip through cents — on those paths there is no `…Cents` in existence to prefill from. | **DA-3a-iii property 5**, M-3 | Every money-bearing render-state member is `…Cents: number` or `…Input: string`, and the refusal prefills from `…Input`. |
| **8** | **Hand-copying a domain table into a fixture.** The stub then passes forever while testing a wire shape the service cannot produce — which is how a forbidden transition and a missing legal one both went unnoticed. | **V-3b**, third bullet | The fixture imports the table (`ORDER_STATE_MACHINE`, an enum, a closed list) rather than restating it (X-51). |

---

## 16. What will still read flat after all of this

Four things survive this overhaul. They are stated here so they do not surface as a surprise at
screenshot review.

1. **There is no mid-level typography.** Only `header` (`h2 text-xl font-bold`) and plain body text
   exist (R-5). A tab panel with four accordions is a stack of four grey trigger rows of identical
   weight; the labels carry all the hierarchy there is, which is exactly why D-6 makes them carry
   the answer. Absent a migration to the React admin console — indefinitely deferred, §14 item
   1 — **sub-structure reads as trigger rows**, a renderer limit, not a layout failure.
2. **Tables have no alignment and no row click** (R-7). Money in the final column (T-2) is the only
   alignment lever, and every list needs a separate drill-in control (L-7, §12.7). Numbers will not
   form a right-aligned edge.
3. **A `select` shows the option's raw *value*, not its label, and that does not change here.** F-6a
   removes every **blank** trigger without a fork change — but it cannot make a `select` trigger read
   the label, because the pinned renderer never can (R-17a). So the coupon type reads `fixed_amount`,
   the tax rates filter's zone reads `any`, and the shipping method type reads `flat_rate`. A real but
   small wart; F-6c keeps it tolerable by constraining values to words. Only a React migration
   (§14 item 3) would remove it, and none is scheduled for these five screens.

   **This item is smaller than revisions 1–3 claimed, and the correction matters.** They named "the
   order picker reads a raw UUID" as the worst instance on these screens. **It never was** — every
   L-7 picker is a `combobox`, which renders the option **label** and has a real placeholder (R-17b),
   so the surviving one reads `Choose a coupon…` closed and `SUMMER25 · 20% off · 3 uses` selected.
   That was verified in a browser, not inferred. Nothing here reads as an id after L-7, and the
   residual flatness is a handful of readable lowercase words in a handful of triggers.

4. **A tracking URL is not clickable.** The vocabulary has no link (§14 item 5), so the operator
   selects and copies. Do not shorten it to satisfy a budget — X-11a exists for exactly this value.

None of the four is a reason to delay: each per-screen increment is a strict improvement on what
ships today. None of the four has a scheduled fix — they are documented limits of Block Kit, not
open follow-ups. Two screens have escaped all four by leaving Block Kit (§14); the five that remain
are ruled to stay or are unruled (ADR-0014 Decision 6, unchanged by ADR-0015), so for them these are
permanent.

### Known copy residuals — open follow-ups, unlike the four above

Two shipped strings drifted behind the increments that moved what they describe. Both are copy or
comment, neither is a behaviour defect, and both were found by the 2026-08-01 docs sweep — which is
docs-only, so they are recorded here rather than fixed there. **Unlike items 1–4, these are meant to
be closed.**

1. **`shipping-page.ts:575` — an empty state that points the wrong way.** The zones fallback table's
   `empty_text` reads *"No shipping zones yet — create one below."* INC-14 moved that create control
   **above** the data (L-8), so the direction is now wrong. The fix is the word, not the layout:
   name the control (`use "New shipping zone" above`) rather than a position, which is what stops
   this class of drift recurring the next time something moves.
2. **`coupons-page.ts:999` — a docblock that stops one clause short.** It frames the edit form as
   "ONE full-replace form (F-5c, cap 8)", which is correct on the authored count, but does not
   mention the `showLimits` toggle that keeps only four of those fields visible at once. A reader
   reaching for the F-5c precedent gets the exemption without the technique that made it liveable
   (F-5c's own second half, §12.2).
