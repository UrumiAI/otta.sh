# 0015. The duplicated Block Kit Orders and Pricing & inventory screens are to be retired, once their write paths move off them

- Status: accepted — the retirement is **authorised and not yet landed**; the screens are still
  in the tree until the increments below merge.
- Date: 2026-08-01
- Amended: 2026-08-03 — **Decision 3, and one clause of Decision 2 rendered moot.** THREE
  checks are deleted along with the unreached two-step `-review` pair they were the only
  implementation of: two of Decision 3's three refusals, and the `Refunded by` attribution
  guard, which Decision 3 never named. Decision 3's third refusal — the stale-watermark
  refusal — is unchanged and still binding. Decision 2's "the staged state a two-step flow
  needs" is **moot**, not unaffected: the deletion removes exactly that member. Decisions 1,
  4, 5 and 6 stand as written. See "Amended 2026-08-03" at the end of this record.
- Amended: 2026-08-03, second — **Decision 3 again, this time for Pricing & inventory.** The
  first amendment above is scoped by its own text to three named ORDERS ids, and its own
  argument — that enumerating only what an earlier record listed is not a record of what was
  lost — applies to itself. This second amendment records the Pricing & inventory drop:
  `products:remove-stock-review` is not ported, taking the DA-3c bound check, the
  `REMOVE_STOCK_INVALID_QTY` field-level refusal and the `remove-draft`/`remove-staged` render
  state with it. Neither had a reachable caller. The stale-watermark refusal is again
  unchanged and still binding. See "Amended 2026-08-03, second" at the end of this record.
- Supersedes: **one clause of [ADR-0014](./0014-second-native-descriptor-for-react-admin.md)** —
  "The Block Kit screens stay in the tree and stay green until a migration increment replaces
  each one" — **as to Orders and Pricing & inventory only**. That clause is the third bullet of
  ADR-0014's "ADR-0006 Decision 1 is REAFFIRMED, not weakened" section. ADR-0014 is otherwise
  unchanged, including Decision 6 (Tax, Shipping and Settings stay Block Kit permanently;
  Reports and Coupons stay unruled).
- Relates to: [ADR-0006](./0006-trusted-in-process-deployment.md) — **Decision 1 is reaffirmed
  again here**, not weakened; [ADR-0013](./0013-product-title-is-cms-owned.md) (the read-only
  Title rule binds the surviving Pricing & inventory screen exactly as it binds the one being
  retired)

## Context

ADR-0014 permitted React admin screens on a second descriptor, migrated Orders and then Pricing
& inventory onto it, and closed the question of what happens to the originals by explicitly
refusing to answer it:

> **The Block Kit screens stay in the tree and stay green until a migration increment replaces
> each one**, screen by screen. Removing a Block Kit screen or its suite is a separate decision
> and is not authorised here.

Both migrations have landed. This record is that separate decision, for those two screens and no
others.

### The consequence ADR-0014 did not anticipate: the replacement runs *on* what it replaced

The obvious reading — two screens do the same job, delete the older one — is wrong, and the
reason is the substance of this ADR.

The React console does not merely call the Block Kit handlers. It **drives them and parses their
rendered output**:

- `orders-console-route.ts` and `products-console-route.ts` each construct the Block Kit page
  handler (`createOrdersPageHandler()` / `createProductsPageHandler()`) once and hold it —
  "the write path is that handler, so there is exactly one of it", as the route's own comment
  puts it.
- Every console write is forwarded through `forwardConsoleAct` (`console-transport.ts`) as a
  **synthesized Block Kit interaction**, shaped per action rather than per screen: an action the
  Block Kit screen renders as a form is forwarded as the `form_submit` that form would have
  fired, carrier minted from the payload; every other action is forwarded as the `block_action`
  a button would have fired. Orders is entirely the latter; Pricing & inventory is four
  form-shaped writes — three saves and a restock — plus one button, `products:remove-stock`,
  forwarded as a `block_action` like any Orders write.
- The outcome is then **scraped back out of the returned block tree**. `firstNotice(blocks)`
  reads the operator-facing banner off the render, and `blocks.length === 0` is interpreted as
  "nothing applied" — because an empty tree is the Block Kit dispatcher's fall-through, and the
  alternative was reporting a refund that never happened as a quiet success.

That design was deliberate and, when it was made, correct: the alternative was a second
implementation of refunds, cancellations, status transitions, product saves and stock movements —
each with its own watermarks and idempotency keys — which is a second set of concurrency bugs.
Its cost is only visible now. **The Block Kit renderer for these two screens is load-bearing for
the React screens that replaced them**, and the console's signal that a write did nothing is the
*absence of rendering*.

The rationale above explains the choice but does not prevent a repeat, so the process gap gets
named too: **a deliberately temporary, load-bearing bridge was built with no recorded expiry.**
Neither migration increment said when the forwarding would come out or what would have to be true
first, and a bridge with no stated end date becomes the arrangement it was meant to precede. The
lesson is to record the retirement condition when the coupling is introduced — not a release
later, in a record like this one.

**Reads are already independent.** The console's list and detail paths call the admin clients
directly and borrow only **Block-Kit-free** helpers — among them filter translation, the parallel
secondary-surface load, the offered-transition computation, the page limit, and the period and
filter-option vocabularies; Decision 5 describes the class rather than listing it, and neither
list here is exhaustive. Block-Kit-free is not side-effect-free — the secondary-surface load
issues four parallel admin-client calls — and the claim being made is the narrower one: none of
these helpers renders or reads a block tree. Only the **write** path is entangled.

So retiring these two screens is **a rewrite of the write path, not a deletion of two files**.
That is why it is an ADR and a multi-increment effort rather than a chore, and why anyone reading
these screens as dead code has it exactly backwards: they are, today, the live write path for
their own replacements.

### What retirement has to carry across, or it is a silent regression

Refund and cancel are two-step flows (staged → confirm), and their safety lives in the Block Kit
action handler the console drives, not in the console:

- **Stale-watermark refusal.** The watermark the operator saw — `refundedTotalCents`, or the
  order's state — is echoed in the forwarded value and re-read against live truth at confirm
  time; a mismatch refuses the write rather than applying it.
- **Refund-ceiling bound check.** The parsed amount is bound-checked against the remaining
  ceiling *just re-read*, so a confirm dialog can never name an amount that is already false at
  the moment it is shown.
- **Unparseable-amount refusal.** `parseMinorUnitsInput` returning `null` refuses, and the draft
  carries the operator's raw text verbatim rather than re-deriving it from cents. Money is
  integer minor units; a refusal that silently reformats what someone typed is a worse failure
  than the one it reports.

The React screens inherit all three for free today. **Porting them is where a regression would
hide, and a green happy path is not evidence of it.**

## Decision

**The Block Kit Orders and Pricing & inventory screens are to be removed from the tree — page
modules, descriptor entries, dispatcher branches and sandbox suites — after, and only after,
their write paths are re-implemented as structured, block-free actions the React console calls
directly.**

Concretely:

1. **What goes.** The two page modules and their two sandbox suites; their entries in the site's
   `adminPages` list; their `page_load` and `action_id` branches in the admin route dispatcher;
   and, once no caller remains, the block-tree half of the console transport — the forwarder, the
   banner scrape, and the empty-tree refusal. The suffixes that exist only to disambiguate two
   sidebar entries of the same name go with them: with the original gone, "(new)" is the
   misleading thing.
2. **What replaces it.** Each retired write becomes a function returning a **structured outcome**
   — the applied/refused flag, the notice, and the staged state a two-step flow needs — instead
   of a block tree. The console dispatches to it directly: no page handler, no synthesized
   interaction, no notice-scraping.
3. **The three refusals above move across verbatim.** A reworded bound check is a failed port,
   not a port. Dropping one of them is not authorised by this record and would need its own.
4. **Order is a precondition, not a preference.** A screen may not be deleted before the write
   path is off it. Each increment extracts, proves, then deletes.
5. **The read path's imports leave the doomed modules before the modules do.** The console's read
   path borrows a *class* of Block-Kit-free exports — helpers and the types that go with them —
   from the two page modules being deleted: filter translation and filter-form reading, the
   secondary-surface load, transition computation, list narrowing, threshold and tax-class
   reading, the shared page-limit, period, cancellation-reason and reconciliation-outcome
   vocabularies, and each screen's filter-option vocabulary. "The read path is untouched" is
   therefore true of behaviour and false of the build — deleting a module deletes its exports.
   **Each increment relocates every such export its screen's console still imports into a module
   that survives, as a move with no behavioural change, before the deletion** — not as part of
   it. The rule is deliberately the class and not a list of symbols: any enumeration written
   here, the illustrative one above included, would rot as the code moves, and the compiler names
   the members on the day.
6. **The behavioural coverage moves; only the rendering coverage dies.** The two suites total
   over six thousand lines, most of which assert Block Kit *rendering* and cannot outlive the
   renderer. Everything asserting **behaviour** — above all the three refusals — moves onto the
   new path, and each increment states which assertions were dropped as render-only and why. A
   line-count delta is not that statement.

### What is NOT removed — stated positively, so it cannot be read as collateral

- **Tax, Shipping and Settings stay Block Kit, permanently.** ADR-0014 Decision 6, unchanged.
  Nothing here weakens it and nothing here reopens them.
- **Reports and Coupons stay Block Kit and remain unruled.** ADR-0014 Decision 6 leaves them to be
  re-evaluated after the Pricing & inventory migration; **this record does not make that ruling**
  and must not be cited as having made it. This ADR authorises the retirement of exactly two
  screens. It is not a decision to retire Block Kit.
- **`packages/plugin/src/admin/scaffold/` stays.** Five screens call `createListDetailHandler`
  today; three — Tax, Shipping and Coupons — still do afterwards. The scaffold is not a
  compatibility shim for the screens being retired; it is the shared shape of the screens that
  remain.
- **The console's read path is untouched behaviourally.** It was never coupled to Block Kit, and
  this effort does not restructure it to look as if it was. Its helpers change module (Decision
  5); what they do does not change.

### ADR-0006 Decision 1 is reaffirmed, again

Stated separately, because two sandbox suites are being deleted and that is exactly the thing
ADR-0014 named as reopening this ground:

- **The sandbox suites remain the contract gate for `@otta-sh/plugin`.** A change that only works
  trusted is still broken and still must not merge.
- **Exactly two suites go, and only because the screen each one tests no longer exists.** No suite
  is skipped, weakened, made conditional, or narrowed to make this land. If porting a refusal onto
  the new path is hard, the answer is that the increment does not land — not that the assertion
  gets relaxed.
- ADR-0014 lists "any of the 18 sandbox suites being deleted, skipped or weakened" among the
  things that reopen it. **This record is that reopening, made deliberately and in the open**
  rather than by attrition, and it is bounded to the two suites whose subject is being removed.
  (The arithmetic is a coincidence worth pre-empting: there are 20 sandbox suites today, because
  the two console-route suites were added after ADR-0014 was written, so 18 remain afterwards —
  a different 18 than the one ADR-0014 counted.)

## Consequences

### What becomes easier

- **One surface per screen.** A change to Orders or Pricing & inventory is one change, in one
  idiom, with one place to be wrong. Today it is two renderers, two vocabularies of refusal copy,
  and a suite whose bulk asserts a rendering nobody is looking at.
- **The notice-scraping coupling ends.** The console stops inferring "what happened" from "what
  rendered". Outcome becomes a value the write path returns, which is what it has been standing
  in for all along — and the empty-block-tree proxy, the most fragile thing in the arrangement,
  has no successor because it needs none.
- **The staged state stops round-tripping through an encoded carrier and a synthesized form
  submit** on the two-step flows; the console passes arguments and receives an outcome.
- **The dispatcher and the transport shrink.** The transport keeps its interaction vocabulary and
  its refusal constants — the things both tiers must agree on — and loses everything that exists
  only to talk to a renderer.
- **The sunk Block Kit investment stops accruing interest.** ADR-0014 accepted it as sunk on every
  migrated screen; it stops being maintained here.

### What becomes harder, and what we accept

- **The three safety checks stop being free, and re-proving them is this effort's gate.** They are
  inherited today from a handler the console merely drives. On the new path they are code we own
  on both sides, and each one must be demonstrated on the new path before its screen is deleted.
  This is the single largest risk in the effort and the reason the order in Decision 4 is not
  negotiable.
- **Incidental coverage is the quiet exposure.** Six thousand lines of suite cover more than
  their screens' rendering; anything they cover *only* incidentally leaves the tree with them.
  Naming the dropped assertions per increment is the mitigation, and it is a weaker one than a
  compiler.
- **Rollback stops being a descriptor line.** While both screens are in the tree, reverting to
  Block Kit is a registration change. Afterwards, "put the old screen back" is a revert of several
  increments. Accepted: cheap rollback is what the parallel period is for, and by the time a
  screen is deleted that period will have run — the replacement is proven before the original
  goes.
- **The second implementation is also an oracle.** A behavioural question about these screens
  can today be answered by running the other one. Afterwards there is one answer, and the ported
  behavioural tests are the only oracle. That raises what those tests have to carry.
- **This does not reduce the console to one idiom, and must not be sold as if it did.** Tax,
  Shipping and Settings never migrate (ADR-0014 Decision 6), so contributors still meet both
  renderers. What this removes is duplication *within* two screens, not the idiom split.

### What would reopen this decision

- A refusal case that cannot be re-proven on the new path. That stops the retirement of the screen
  it belongs to; it does not proceed with two of three.
- Any of the remaining sandbox suites being deleted, skipped or weakened — which reopens ADR-0006
  on its own terms, unchanged by this record.
- A proposal to retire Reports or Coupons, to migrate Tax, Shipping or Settings, or to change
  `scaffold/`. None of those is decided here, and each needs its own record.

## Amended 2026-08-03 — Decision 3, and one clause of Decision 2

Everything above is left exactly as written on 2026-08-01. This block records one change to
one decision, and notes one clause of a second that the change renders moot.

**Decision 3 said the three refusals move across verbatim, and that "dropping one of them is
not authorised by this record and would need its own." This is that record.** It also records
a fourth check that Decision 3 never named and that goes the same way, because a record of
what was lost that enumerates only what an earlier record happened to list is not a record of
what was lost.

### What happened

The Orders write-path extraction carried the two-step refund and cancel flows across
faithfully — `orders:refund-review` and `orders:cancel-review`, the staged and draft state
they returned, and all three refusals. It was only after they had landed that two independent
reviews established the thing the extraction had not thought to check: **nothing calls them.**
The React order detail can show a confirm dialog over the values the operator just typed, so
it composes its own confirm client-side and posts `orders:refund`, `orders:cancel` and
`orders:cancel-<reason>` directly. There is no surface that reaches a `-review` step, and
none since the Block Kit screen it was written for was retired. The per-reason cancel controls
also omit `other` deliberately — a one-click "Other" fires immediately and records no detail,
so that reason is offered only in the note form, which posts `orders:cancel` — which left
`orders:cancel-other` derived, dispatchable and equally unreachable.

The pair was retained at first under Decision 3, on the reading that a ported shape should
survive its port. That was the wrong call, and the reason it was wrong is worth naming: **an
unreachable safety check is not a safety check.** It is a claim in the tree that a check is
being made, which a reader has every reason to believe, and which the running system does not
honour. Keeping it costs more than deleting it.

### The decision

**`orders:refund-review`, `orders:cancel-review` and `orders:cancel-other` are deleted as
unreached surface**, with the staged and draft members of the action result that existed only
for them.

**THREE checks go with them — two of Decision 3's three refusals, and one more that Decision 3
never named. None had a reachable caller:**

- the **refund-ceiling bound check** (Decision 3) — the parsed amount tested against the
  ceiling just re-read — lived only on the refund review step;
- the **unparseable-amount refusal** (Decision 3), whose draft carried the operator's raw text
  verbatim rather than re-deriving it from cents, lived only on that step's draft;
- the **`REFUND_BY_REQUIRED` attribution guard** — a blank `Refunded by` refused before
  anything was staged, so that no refund could be recorded without a named person behind it.
  Decision 3 did not list it among its three, which is precisely why it is listed here: it was
  the check most likely to be lost silently.

None of the three ever ran for any surface that shipped. Deleting them removes no protection
that any operator has had.

**The third refusal is untouched.** The stale-watermark refusal is on the reachable path and
stays there, with the tests that prove it: the refund confirm re-reads the ledger and refuses
on a mismatch; every cancel and every status transition re-reads the order and refuses on a
mismatch; and an *absent* watermark is refused fail-closed at every one of those sites, with
no re-read. The reachable refund's own money validation — integer minor units, a positive
amount, no float laundered into cents — also stays.

**The reachable refund confirm is therefore protected by the watermark compare plus the
service's own over-refund guards.** An over-ceiling amount that clears the watermark compare
reaches the service and is refused there as `REFUND_EXCEEDS_TOTAL` / `REFUND_EXCEEDS_CAPTURED`,
rendered with the same title the deleted client-side check used. What is gone is the earlier,
better-worded refusal that named the real remaining balance before anything was sent — and the
React screen validates the amount against the remaining balance it is displaying before it
opens its confirm, which is a courtesy to the operator and not a guard, because it runs on the
client.

### Refund attribution is now enforced on the client alone, and that enforcement has a hole

This one is worth stating plainly rather than leaving to be discovered.

With the attribution guard deleted, **nothing on the server requires a `Refunded by`**. The
refund write records whatever the payload carries, and records the literal `admin` when the
field is blank. The only check left is the console's own, applied in the partial-refund form
before it opens its confirm dialog.

**That check does not cover every control on the screen.** The "refund the full remaining
balance" button asks for the confirm directly, without going through the partial form's
validation, so a full refund submitted with the `Refunded by` field blank is recorded against
`admin` — a real refund with no named person behind it.

**This is pre-existing. It was true before this amendment and is not introduced by it**: the
console has always had that path, and the server guard that would have caught it was on a step
the console never called, so it never fired. What changes is the framing. While the guard
existed, the gap read as a redundant client check with a server backstop; it never had one,
and now the tree does not claim one either. **Client-side enforcement is the entire story for
refund attribution, and it is incomplete.**

Closing it belongs to whoever owns that control, not to this record. It is named here so that
the next person to read "attribution is enforced" knows exactly where, and where it is not.

### The consequence to be clear-eyed about

**Re-introducing a server-side two-step confirm later means writing these checks, not restoring
them.** There is nothing left to restore, and a future flow will not have the same shape: the
deleted bound check assumed a staged amount and a watermark carried between two server round
trips. Anyone adding that flow owns all three checks as new work, including the ordering that
made the movement refusal win over the bound refusal when both would fire. This amendment is
not permission to ship a two-step confirm without them.

### The one id that had to be shipped rather than re-derived

Deleting `orders:cancel-other` turned a harmless divergence into a hard failure. The console
was already excluding `other` from its one-click cancel controls with its own copy of the
exclusion, on its own side of the wire; while the id was registered, a drift toward offering it
would merely have cancelled an order with a reason and no detail. It now posts an id that does
not exist, and an unregistered action is refused — correctly, and confusingly, since the
operator asked to cancel an order that is perfectly cancellable.

**So the one-click reason list is shipped from the plugin, derived from the same constant the
dispatch table derives the per-reason ids from, and the console consumes it instead of
re-deriving the exclusion.** It is DA-6 — derived, never hand-listed — and the console's own
reason for shipping its filter vocabulary as data rather than letting the React tier hold a
second copy, applied to the two halves of one rule now that a process boundary runs between
them. A test pins set equality in both directions: no member without an id, no id without a
member.

### What is NOT changed

- Decisions 1, 4, 5 and 6 stand as written.
- **Decision 2 is moot in one clause, not unaffected.** It defines the replacement outcome as
  "the applied/refused flag, the notice, and the staged state a two-step flow needs" — and the
  staged state is exactly what is deleted here. The clause was conditional on a two-step flow
  existing; none does, so the outcome is now the flag and the notice. If a two-step flow is
  ever added, that clause applies again as written, together with the three checks above.
- The stale-watermark refusal remains Decision 3's binding requirement for every write that
  carries a watermark, and a reworded one is still a failed port.
- ADR-0006 Decision 1 is reaffirmed a third time: the sandbox suites remain the contract gate.
  No suite is deleted, skipped or weakened here. The Orders write-path suite loses only the
  tests that drove the deleted ids, and each of those pinned behaviour that no longer exists
  rather than behaviour that moved somewhere else.
- Reports and Coupons remain unruled; Tax, Shipping and Settings remain Block Kit permanently.

## Amended 2026-08-03, second — Decision 3 again, for Pricing & inventory

Everything above the first amendment is left exactly as written on 2026-08-01, and the first
amendment is left exactly as written. This block records one more change to the same decision.

**Why a second block rather than an edit to the first.** The amendment above is scoped by its
own text to three named Orders ids, and it argues — in its own words — that "a record of what
was lost that enumerates only what an earlier record happened to list is not a record of what
was lost". That argument applies to the amendment itself: it enumerates the Orders drop and
nothing else, so folding the Pricing & inventory drop into it silently, or leaving it out
altogether, repeats exactly the mistake it was written to correct. Decision 3 still says a
dropped refusal needs its own record. This is that record, for the second screen.

### What happened

The Pricing & inventory write-path extraction found the same shape one screen along.
`products:remove-stock-review` was DA-3 state 1 → state 2 for the Block Kit screen: it parsed
a quantity, staged it server-side together with the on-hand watermark, and returned a second
render carrying a confirm button — because a Block Kit form cannot show a dialog over the
values just typed. React can. The React screen composes its own confirm client-side and posts
`products:remove-stock` directly, which is why the console's action gate has EXCLUDED the
review id since the migration increment, and why **no shipped surface has ever reached that
step**. Two reviews confirmed it independently: the id is unreachable, and an over-removal is
refused on the path that is reachable.

The reasoning of the first amendment carries over unchanged and is not restated at length: an
unreachable safety check is not a safety check. It is a claim in the tree that a check is being
made, which a reader has every reason to believe and which the running system does not honour.

### The decision

**`products:remove-stock-review` is not ported, as unreached surface.**

**What goes with it — the whole of it, not only what Decision 3 happened to name:**

- the **DA-3c bound check** — the requested quantity tested against the on-hand JUST re-read,
  so that a confirm could never name a quantity already false at the moment it was drawn. It
  lived only on the review step;
- the **`REMOVE_STOCK_INVALID_QTY` field-level refusal** — the per-field line an unparseable or
  non-positive quantity produced against the staged form's own input. Decision 3 never named
  it, which is exactly why it is named here;
- the **`remove-draft` / `remove-staged` render state** — the staged quantity plus watermark
  the step handed back for a second render, and the draft that carried the operator's raw text
  into a refusal. Both are members of a result shape that only a server-rendered second state
  needs; the new outcome (Decision 2, as narrowed by the first amendment) is the flag and the
  notice.

None of the three ever ran for any surface that shipped. Dropping them removes no protection
any operator has had.

### What protects the reachable path instead

**The removal that IS reachable is guarded in three places, and the bound is one of them.**

- **The service applies a guarded decrement.** Removing more than is on hand is refused there —
  never a negative count, never an oversell — and the refusal comes back with the REAL on-hand,
  which the console surfaces to the operator as a named refusal quoting the actual count rather
  than as a generic failure. That is a better bound than the deleted one in the respect that
  matters: it is taken by the same statement that would have applied the movement, so nothing
  can change between the check and the write.
- **The domain contract pins it.** The no-negative-stock behaviour is a contract-suite
  invariant, not an implementation detail of one adapter, so it holds for every store the
  service runs on.
- **The stale-watermark refusal (DA-3a) still runs first**, on the reachable path, and is
  untouched: the on-hand the operator saw is re-read against live truth before anything moves,
  a mismatch refuses with nothing posted, and an ABSENT watermark refuses fail-closed with no
  re-read at all.

What is genuinely gone is the *earlier* refusal — the one that could tell an operator the
quantity was too large before any request left the plugin. On the reachable path that
conversation now happens one round trip later, and it names the real number when it does.

### The consequence to be clear-eyed about

**Re-introducing a server-side staged removal later means WRITING these checks, not restoring
them.** There is nothing left to restore, and a future flow will not have the same shape: the
deleted bound check assumed a quantity staged between two server round trips and a watermark
carried across them, and the deleted field-level refusal assumed a server-rendered form with a
field to attach itself to. Anyone adding that flow owns all of it as new work. This amendment
is not permission to ship a staged removal without them.

### What is NOT changed

- Decisions 1, 4, 5 and 6 stand as written, and Decision 2 stands as narrowed by the first
  amendment — the outcome is the flag and the notice, because no two-step flow remains on
  either screen.
- **The stale-watermark refusal is Decision 3's binding requirement and is carried across
  verbatim on this screen**, for both of its watermarks: the stock on-hand and the edit's
  `expectedUpdatedAt`. A reworded one is still a failed port.
- ADR-0006 Decision 1 is reaffirmed a fourth time: the sandbox suites remain the contract gate.
  The Pricing & inventory write path is proven in the workerd sandbox on its new module, and
  the retired screen's suite loses only assertions about a rendering that no longer exists.
- Reports and Coupons remain unruled; Tax, Shipping and Settings remain Block Kit permanently.
