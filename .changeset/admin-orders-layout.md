---
"@otta-sh/plugin": patch
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
keeps `empty_text`. The drill-in is a `combobox` whose option value is the full id
and whose label leads with a short form of it (L-7; see the short-id entry in this
release for the label's final shape).

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
the `Currency` column and the refunds ledger's constant `Kind` badge are deleted
(M-2, T-5/X-4); and no `Payment` value is repeated between the identity strip and
the Money panel (P-3).

**Revision 1 — every refusal is now a render, not just a banner.** The scaffold's
render-state channel (`showLeaf(path, notice?, renderState?)`) replaced this
screen's private staged-re-render path, so a `-review`, a DA-3a stale-watermark
refusal, a DA-3c bound-check failure and every validation refusal all re-render
through the **level's own `render`** — one read-and-render implementation, and the
figures an operator sees after a refusal always come from a fresh read
(DA-3a-i/-ii/-iii). Each refusal re-renders **state 1 into the group it came
from**: forced open on a `block_id` distinct from both idle and `:review` (B-6), the
collect form **flattened** into the group body rather than left inside a collapsed
child (X-39), the submitted values prefilled — the amount **verbatim**, since the
commonest refusal is the one where it did not parse — and **no confirm control**,
because the payload a confirm would carry is the payload just refused.

Three writes gained the staleness check §8 exempts nothing from: **status moves now
carry the observed state and re-read before writing** (DA-2a — `shipped → refunded`
is legal, so the domain guard cannot catch a terminal flip decided on a `paid`
view), and both `-review` handlers re-read as well, so state 2 can never draw a
confirm the write would already refuse (DA-3c). `-review` also **bound-checks the
amount against the live ceiling** (X-40) — an extra zero used to stage a red
`Refund $900.00` on a $50 order, with a dialog saying the same, on the one step that
exists to let an operator check exactly that. An absent watermark is treated as an
unreadable payload rather than as licence to skip the comparison.

Copy and layout follow-ups in the same pass: the DA-3a refusal restores its causal
clause (*"someone else refunded this order since you started"*); the fail-closed
banner stops claiming the service is unreachable when a console bug lands on the
same path (E-7/X-42); both destructive group labels carry their consequence (D-6a);
`Remaining` becomes `Remaining refundable` and a total that disagrees with its
capture is reconciled in one line (M-11/M-11a), with the degenerate `$0.00 of $0.00`
ratio replaced in the label rather than explained (D-6b); the two withheld-transition
lines name the operator's alternative instead of narrating what designers withheld
(DA-7a/X-41); cancellation buttons drop the `Other` reason (which promised a field
it did not have) and their labels become the bare reason, leaving four buttons —
inside DA-2c's cap; the note form's `select` carries **human labels as its option
values**, so the pinned renderer's trigger no longer displays `customer_request`
(F-6c); Notes becomes form-only, since its table repeated the timeline verbatim; a
guest's Customer group is two entries rather than five denials of an account
(§11.2); and the refunds count is a bare integer again (X-9's count exclusion).

The sandbox suite was ported onto the spec's recursive block helpers in a separate
no-behaviour-change commit first (§15 V-2), since a flat top-level search stops
asserting anything the moment content moves into `tab > accordion`. It now covers
the filter panel **with a filter applied**, `Clear filters`, both zero states, D-5's
computed open group, the DA-3 staging round trip, the DA-3a stale-watermark refusal,
the F-2a replay, and DA-6's unknown-state guard.

Revision 1 adds, among others: the DA-3c bound-check refusal and all four DA-3a-i
clauses on each of the four refusal paths; a **positive** watermark assertion (two
deliberate identical refunds derive **different** idempotency keys, so both apply —
the property the whole no-nonce design rests on, and the one nothing asserted); a
`shipped`-order assertion that `Mark refunded` really is offered, against a fixture
whose `allowedTransitions` is the domain state machine copied verbatim; and a
service-side assertion that `GET /admin/orders/:id` on a shipped order returns
`["delivered", "refunded"]`, which is the wire shape the watermark exists for.
