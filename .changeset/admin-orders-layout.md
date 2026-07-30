---
"@urumi/plugin": patch
---

Re-lay the admin Orders console onto the design spec's §11 — the REFERENCE screen
the other six pattern-match on. One flat full-width stack becomes a collapsed
filter panel over the data (list) and five blocks plus four task-named panels
(detail). Presentation only: no port, wire-format or money-handling change, and
the service is untouched.

**The list (§11.1).** `header` + one 101-char `context` + a **collapsed** 4-field
`filterPanel` accordion + the table + the drill-in picker — nothing else above the
data (P-1/L-1), where ~350px of filter form used to sit. The accordion label
carries a **count** (`Filters (2 active)`, never the values, L-3); the values live
in a `section` below it with a `Clear filters` accessory whose drill path rides in
`button.value`, because a button echoes no `block_id` (L-6, B-1). The status
filter's all-values option is the word `any`, not `""`: the pinned renderer treats
an empty value as "no value" and draws a blank trigger, and the trigger shows the
raw **value** rather than the option label (R-17a, F-6a/F-6c). At a true unfiltered
zero state the table is replaced by one real `empty` block (E-2); filtered-to-zero
keeps `empty_text`. The drill-in is a `combobox` whose option value is the id and
whose label never contains one (`alice@example.com · $15.00 · paid`, L-7/X-22).

**The detail (§11.2).** Eleven top-level sections and thirteen `section`-as-heading
labels become five blocks outside the tabs — header, back, ≤2 banners, a 6-entry
identity strip — and four constant panels: `Order` · `Fulfilment` · `Money` ·
`History` (D-2/D-3, `default_tab: 0`). Every named group is an `accordion` because
`section` is not a heading and the renderer has no mid-level weight (P-2, R-5), and
**exactly one group is open per response, computed from the record state**, not
chosen (D-5/X-18). The reconciliation alert stays OUTSIDE the tabs: a state
demanding action must never sit where a tab can hide it (D-1). The totals ladder is
now a two-column `table`, because `fields` is row-major `grid-cols-2` and five
lines can never read downward inside it (M-4). Guest checkout's three
heading-plus-empty-table pairs collapse to one sentence (D-7). Each leaf sub-table
caps its read and states the cap rather than setting `next_cursor`, which at leaf
depth blanks the page (T-8).

**Every carrier dropdown is gone (F-2, F-3).** Twelve single-option `select`s whose
visible labels were raw internals — `orderId` ×5, `currency`, `expectedFlag`,
`Order` — now ride invisibly in each form's `block_id` via `carriedForm`. Not one
single-option select remains on the screen.

**No nonce is minted, carried or exposed (F-2a).** The refund key is
`admin-refund:${orderId}:${amountCents}:${refundedSoFarCents}` — content plus **the
watermark the operator saw**. That is what lets two deliberate identical refunds
both apply while a double-click dedupes; a render-time nonce cannot, because
`refundOrder` resolves a duplicate by key ALONE with no amount comparison and would
render a success-shaped "Already refunded" for money that never moved (#152, not
depended on here). Transitions, notes, cancels and reconciliation keep their
existing content-derived keys.

**Destructive actions follow §8's three shapes.** A form can no longer trigger one
(DA-1): cancellation offers one danger button **per reason** with the reason named
in its confirm (DA-2b), a refund of the full remaining balance is one danger button
carrying amount + watermark (DA-2b), and a typed partial amount or free-text
cancellation stages then confirms with two action ids (DA-3). Forcing the state-2
group open sets **both** a changed `block_id` and `default_open: true` — the id
alone remounts the group, which re-reads the flag as `false` and snaps shut on the
operator the instant they click "Review refund" (B-6). **Every confirm handler
re-reads the record and refuses on a watermark mismatch, applying nothing and
naming both figures** (DA-3a). An undecodable payload renders an error notice
instead of silently bouncing the operator to the list (DA-3b).

**Status moves are one `actions` block with per-state ids derived from
`ORDER_STATES`** (DA-6) — the old one-block-per-button split existed only because
every button shared the literal id `orders:transition` and they collided as React
keys. `customActions` is derived from the same constant and a service-offered state
outside it renders **no button**, because `admin-route.ts` falls through an
unregistered id to `{blocks: []}` — a blank console.

Also: `formatTotal`'s catch branch renders `—` instead of raw minor units (a wrong
number dressed as a formatted total, M-1) and the totals block says so when it
happens; a negative amount formats with an explicit minus prefix rather than
throwing through `cents()`; timestamps in `fields` are trimmed to seconds (M-6);
the `Currency` column and the `Kind` badge are deleted (M-2, T-5); and no `Payment`
value is repeated between the identity strip and the Money panel (P-3).

The sandbox suite was ported onto the spec's recursive block helpers in a separate
no-behaviour-change commit first (§15 V-2), since a flat top-level search stops
asserting anything the moment content moves into `tab > accordion`. It now covers
the filter panel **with a filter applied**, `Clear filters`, both zero states, D-5's
computed open group, the DA-3 staging round trip, the DA-3a stale-watermark refusal,
the F-2a replay, and DA-6's unknown-state guard.
