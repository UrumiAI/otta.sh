---
"@otta-sh/plugin": minor
"@otta-sh/admin-react": patch
---

Extract the Orders write path off Block Kit and retire the Block Kit Orders
screen (ADR-0015, INC-R2).

The React Orders console had no write path of its own. It constructed the Block
Kit Orders page handler, forwarded every write through it as a synthesized
`block_action`, and then read the outcome back out of the RENDERED BLOCK TREE —
the banner off the render, an empty tree taken to mean "nothing applied". The
renderer of the screen the console replaced was therefore load-bearing for the
console, which is why removing it is a rewrite and not a deletion.

- **New `admin/orders-actions.ts`** — every Orders write as a function returning
  a structured outcome (`{ok, notice}` plus the staged/draft state the two-step
  refund and cancel flows need) instead of a block tree. The three safety checks
  that make those flows safe are carried across verbatim: the stale-watermark
  refusal (the `refundedTotalCents` or order `state` the operator saw is re-read
  against live truth and the write refuses on a mismatch, and an ABSENT watermark
  refuses too, with no `-review` exemption); the refund-ceiling bound check
  against the ceiling just re-read, which still runs AFTER the watermark compare;
  and the unparseable-amount refusal, whose draft carries the operator's raw text
  verbatim rather than re-deriving it from minor units. Idempotency keys stay
  content-derived from the observed watermark — no nonce anywhere.
- **New `admin/orders-read.ts`** — the read path's Block-Kit-free helpers and
  vocabularies (filter translation and the period window, the parallel
  secondary-surface load, the offered-transition computation, the page limit),
  relocated unchanged out of the module being deleted so the console keeps
  compiling. Behaviour-free move; internal to the package.
- **`orders-console-route.ts`** dispatches to the new actions directly: no page
  handler, no synthesized interaction, no notice-scraping.
- **Removed:** the Block Kit Orders page module and its sandbox suite, the
  screen's `adminPages` entry, and its `page_load`/`action_id` branches in the
  admin dispatcher. `/orders` is now served by the React console alone. The
  package barrel exports `ORDERS_ACTION_IDS` and `dispatchOrdersAction` in place
  of `createOrdersPageHandler`/`ORDERS_PAGE`.
- **The console's Orders sidebar entry is now labelled `Orders`,** not
  `Orders (new)`. The suffix existed to tell it apart from the Block Kit screen
  at the same path; with that screen gone, a single entry marked new against
  nothing is the misleading thing. `Pricing & inventory (new)` keeps its suffix —
  its Block Kit original still renders.

**Two notes for anyone reading the new module.** Neither is a change this release
makes; both are things it would be wrong to leave unwritten.

- The `orders:refund-review` / `orders:cancel-review` pair is retained but has no
  caller today — the React order detail stages its confirm in the browser and
  posts `orders:refund` / `orders:cancel` directly. It is kept because the
  unparseable-amount refusal, which hands the operator's raw text back verbatim,
  lives only there. The consequence is that the review step's live-ceiling bound
  check does not run for the React console. That is pre-existing rather than
  introduced here: the reachable confirm re-reads the refund ledger and refuses on
  a watermark mismatch, and an over-ceiling amount surviving that is refused by
  the service itself. What is lost is the earlier, better-worded refusal naming
  the remaining balance, not the ceiling.
- Resolving a reconciliation flag derives its idempotency key from the order id
  alone, so two resolutions of two different anomalies on the same order collide
  and the second is answered as already-resolved without clearing the new flag.
  Ported unchanged from the deleted handler and left unchanged so this is a port;
  fixing it changes a key and needs its own release.

**Fixes a live defect.** Because the console sent its writes as flat payloads
while the Block Kit handler read its context out of a `block_id` carrier the
console never sent, three React Orders writes — add note, resolve reconciliation
and record fulfilment — answered "That action could not be read" and issued no
request at all. Dispatching directly makes all three work.

The behavioural coverage moved onto the new path as a workerd sandbox suite;
what was dropped asserted the retired screen's rendering only.
