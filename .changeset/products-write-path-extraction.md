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
  and a save without one refuses rather than clobbering); **money as integer
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
- **`products:remove-stock-review` is left unported as unreached surface.** It
  staged a quantity server-side so a second render could draw a confirm button;
  the React screen shows that dialog over the values just typed, which is why the
  console's gate has excluded the id since the migration and why nothing
  reachable has ever called it. One check lived only on that step and so never
  ran for any shipped surface — the bound of the quantity against the on-hand
  just re-read. An over-removal is refused by the service's guarded decrement
  instead, which the new suite asserts.

The console's Pricing & inventory sidebar entry loses its `(new)` suffix. It
existed to tell this screen apart from the Block Kit screen at the same path;
with that screen gone, a single entry marked new against nothing is the
misleading thing (ADR-0015 Decision 1).
