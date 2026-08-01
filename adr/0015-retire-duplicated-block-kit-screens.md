# 0015. The duplicated Block Kit Orders and Pricing & inventory screens are to be retired, once their write paths move off them

- Status: accepted — the retirement is **authorised and not yet landed**; the screens are still
  in the tree until the increments below merge.
- Date: 2026-08-01
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
