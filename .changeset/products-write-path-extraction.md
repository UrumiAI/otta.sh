---
"@otta-sh/plugin": minor
"@otta-sh/admin-react": patch
---

Extract the Pricing & inventory write path off Block Kit and retire the Block
Kit Pricing & inventory screen (ADR-0015, INC-R3).

The React Pricing & inventory console had no write path of its own. Four of its
five writes were Block Kit FORM submits whose context rode invisibly in a
`block_id` carrier, so the console minted that carrier, synthesized the
`form_submit` the Block Kit handler read, drove that handler, and then read the
outcome back out of the RENDERED BLOCK TREE — the banner off the render, an
empty tree taken to mean "nothing applied". The renderer of the screen the
console replaced was therefore load-bearing for the console, which is why
removing it is a rewrite and not a deletion.

- **New `admin/products-actions.ts`** — each write as a function returning a
  structured outcome (`{ok, notice}`) instead of a block tree. Form fields are
  plain arguments now: the carrier existed so an operator was never asked to
  "pick" a `productId` from a single-option select, which is a rendering concern
  and retires with the renderer. The screen's invariants are carried across
  verbatim rather than paraphrased — the **stale-watermark refusal** (the
  `onHand` the operator saw is re-read against live truth before any stock
  moves, and refuses on a mismatch, with an absent watermark refused fail-closed
  and with no re-read); the **edit watermark** (`expectedUpdatedAt` is mandatory,
  and a save without one — or with a blank one — refuses rather than clobbering,
  guarded at the same tier as the stock watermark rather than left to the service
  to reject); **money as integer
  minor units** (an exact decimal parse, a positive amount, a required ISO-4217
  currency, and a blank compare-at as an explicit clear rather than a zero); and
  **content-derived idempotency keys** with no nonce anywhere.
- **`admin/products-console-route.ts` dispatches directly** — no page handler,
  no synthesized interaction, no carrier, no notice-scraping.
- **Read-path relocation first (ADR-0015 Decision 5)** — filter translation and
  filter-form reading, the low-stock narrowing and its withheld `total`, the
  threshold and tax-class reads, the page limit and the status/kind filter
  vocabularies move into a new `admin/products-read.ts` as a behaviour-free
  move, before the page module is deleted.
- **Deleted** — the page module and its sandbox suite, the screen's `adminPages`
  entry (the Block Kit page list goes from six to five) and its dispatcher
  branches. The suite's behavioural half moves onto the new path as
  `products-actions.sandbox.test.ts`, which drives the writes the way the console
  does, inside the workerd sandbox.
- **`products:remove-stock-review` is left unported as unreached surface, and
  ADR-0015 carries a second amendment recording exactly what went with it.** It
  staged a quantity server-side so a second render could draw a confirm button;
  the React screen shows that dialog over the values just typed, which is why the
  console's gate has excluded the id since the migration and why nothing
  reachable has ever called it. Three things lived only on that step and so never
  ran for any shipped surface: the **DA-3c bound check** of the requested
  quantity against the on-hand just re-read, the **`REMOVE_STOCK_INVALID_QTY`**
  field-level refusal, and the **`remove-draft`/`remove-staged` render state**.
  What protects the reachable path instead is the service's guarded decrement,
  which refuses an over-removal with the real on-hand and is surfaced as a named
  refusal quoting that count (asserted by the new suite), plus the inventory-store
  contract suite pinning that an over-removal removes nothing and never goes
  negative, on every adapter. Re-introducing a
  server-side staged removal means WRITING these checks, not restoring them.

The console's Pricing & inventory sidebar entry loses its `(new)` suffix. It
existed to tell this screen apart from the Block Kit screen at the same path;
with that screen gone, a single entry marked new against nothing is the
misleading thing (ADR-0015 Decision 1).

**Three read-path assertions were rescued from the deleted suite rather than
written off as render-only**, because each is a claim about what the SERVICE is
asked for and outlives the renderer: the internal admin token travelling on the
list and detail GETs (every surviving header assertion was on a write); the
absent-token → 401 fail-closed trigger (the anti-leak contract was otherwise
exercised only through a 500, and an unconfigured token is the failure an
operator actually meets); and the three filter axes — `active`, `productKind`
and `search` — travelling together in ONE query rather than only one at a time.

**The block-tree half of `console-transport.ts` now has no callers** —
`firstNotice`, `forwardConsoleAct`, `forwardedFormSubmit` and `nothingApplied`,
callerless once both consoles are off Block Kit. It is left byte-identical with a
module note saying so; ADR-0015 Decision 1 puts its removal in the increment that
follows, deliberately as its own change.

**Known coverage gap, recorded rather than fixed here.** The stale-edit refusal
tells the operator "the latest values are shown below", and with the Block Kit
re-render gone that promise rests entirely on the React screen re-reading the
product after a refused save. Nothing asserts it at either tier: the plugin suite
ends at the refusal notice, and the React suite does not pin the re-read. The
behaviour is correct today; only the guard against it regressing is missing.
