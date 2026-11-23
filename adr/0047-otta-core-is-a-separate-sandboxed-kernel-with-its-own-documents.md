# 0047. Otta Core, a sandboxed registry edition, is a separate kernel with its own documents

- Status: accepted
- Date: 2026-11-22
- Builds on: [ADR-0019](./0019-commerce-aggregates-are-one-document-each.md). Core keeps its
  discipline (one document per aggregate, compare-and-set, idempotency is the document id) on its
  own, smaller document set.
- Relates to: [ADR-0020](./0020-one-deployable-plugin-owns-commerce-truth.md) and
  [ADR-0045](./0045-the-store-ships-as-an-astro-integration-for-one-click-deploy.md). Full Otta
  stays the npm, in-process store. This record adds a second edition beside it and changes
  nothing in it.
- Amends: **nothing.**

## Context

EmDash has a plugin registry. A registry plugin runs sandboxed in a Worker Loader isolate on
Cloudflare Workers Paid, and an operator installs it from the admin without touching code. Full
Otta cannot ship that way. The constraints:

1. **Full Otta does not fit the registry.** EmDash 1.5 caps a registry release at 128 KiB per
   file (so 128 KiB for `backend.js`), 256 KiB in total, 20 files, and a 384 KiB gzipped tarball.
   Full Otta's backend has a **412 KiB floor**, more than three times the per-file cap.
   (Measured on commit 82368528 with esbuild 0.28.1, minified ESM with emdash external: 781,354 bytes
   for the full plugin; 422,349 bytes with the admin, accounts, downloads and cron stubbed out; an
   upper bound of 341,196 bytes even with property mangling. Every figure is over the 128 KiB cap.)
2. **The sandbox meters every request.** One invocation gets **30 bridge calls** (every `ctx.*`
   call counts, `ctx.log` included), **50 ms of CPU** and **30 s of wall time**. Full Otta's
   money paths were designed in-process, with no such budget.
3. **A registry install has its own id and its own storage.** The id is `r_` plus 16
   characters (from a hash), not the slug. `ctx.storage` is scoped per plugin id, so a registry
   plugin can neither read nor write the documents of the npm `otta` plugin, and a later npm
   install cannot read the registry plugin's documents.
4. **The capabilities are shown to the operator at install.** Core asks for `content:read`
   (product sync hooks) and `network:request` with `allowedHosts: ["api.stripe.com"]` only
   (`packages/core/emdash-plugin.jsonc`). No email, no other host.

The question was what a registry edition of Otta is: a cut-down full Otta, a thin front for full
Otta, or its own kernel.

## Decision

**Otta Core is a separate, lean kernel in `packages/core`, with its own storage documents.** It
shares ADR-0019's laws with full Otta, not its code or its documents.

### What it is

- **Its own documents** (`src/model.ts`, schema version `v: 1`): `products` (id = the EmDash
  content id, written only by the sync hooks), `stock` (id = `stockId(item)`, i.e. the product id,
  or `productId:variantId` once variants exist) and `orders` (id = the client-minted key). Settings
  live in kv. Moving to full Otta is an **import** (products, stock, settings, order history)
  through full Otta's own stores, so only full Otta's code writes full Otta's invariants. **The
  importer does not exist yet.** Its fixtures are to be generated from the shapes in `model.ts`.
- **No server cart.** The cart lives in the browser; checkout receives the lines and prices them
  on the server.
- **Stripe hosted Checkout, card only** (`payment_method_types: ["card"]`, Adaptive Pricing
  off). There are no async payment methods, so a session that has expired can no longer be paid
  (see S-b).
- **Stock holds per order.** Checkout reserves a hold on each tracked product. Payment commits
  the hold (the sale), expiry releases it.
- **The sweep** (`src/sweep.ts`), run by the site's cron at 5 minutes or faster, inside the 30 s
  wall time, keeps every promise a dead request left:
  - **A.** Orders with `stockPending = 1`: finish their stock work. An abandoned `reserving`
    order is carried forward like a replay, and given up once its session window has passed.
  - **B.** Pending orders past their session expiry: ask Stripe, expire an open session through
    the API, and release only on what Stripe then reports. A session Stripe no longer knows, or
    one completed unpaid, moves the order to `review`. B only decides (the status CAS sets
    `stockPending`); part A releases the stock on the next run, so B's cost per order is
    constant and a large order cannot block it. A run whose part A is busy with a large
    order's stock may have no budget left for B or E, so without a webhook a backlog of large
    orders clears over several runs rather than one.
  - **C.** Prune unpaid (expired or canceled, stock released) orders 90 days after their
    session ended. Orders with a payment or a merchant note are never deleted.
  - **D.** Delete the order page's lookup stamps (`chk:<id>`) older than an hour, and the
    release counters (`rel:`) of past windows, a few per run.
  - **E.** Payments with no webhook: list the Checkout Sessions Stripe completed in the window
    (40 min session life + interval + margin, 50 min) and settle those that are ours, paging
    across runs, so the webhook is optional. Like B it only decides, and part A commits the
    stock. It runs after B and leaves 3 calls for C and the health stamp.

  Each order is admitted only if its typical cost still fits the 30-call budget, and one
  failing order never fails the run. An overrun under contention is recoverable: every step is
  idempotent, and the next run finishes it.
- **The order page settles from Stripe.** While an order is pending, `GET order` asks Stripe (at
  most once per order every 20 s) and applies the session through the same `applySession` as the
  webhook and the sweep.
- **Opt-in promotion codes.** A setting, snapshotted onto each order (`promoCodes`), so every
  path checks the amount with the rules Stripe was given. The discount is recorded on the order.
- **Refunds are recorded, not acted on.** Each refund event is a signal: Core re-reads the
  payment's refunds from Stripe and merges them per refund id. The order keeps its status and its
  stock is not returned (the merchant uses `set_stock`).
- **Resync.** `resync_products` (private route `products/resync`, also an MCP tool) repairs lost
  product hooks with the hooks' own rules, one budgeted step per call.
- **Abuse limits.** Six limits bound what the public checkout routes can hold:
  1. **Open checkouts**: a store-wide cap on orders awaiting payment (default 100).
  2. **Per buyer**: a cap on one buyer's open checkouts (default 5), keyed by a salted HMAC of
     the IP (IPv6 by /64), kept only while the checkout is open. Without a public buyer IP only
     the store-wide caps apply.
  3. **Recently created**: a store-wide cap on checkouts started in the last 10 minutes
     (default 300), whatever became of them, which bounds Stripe calls and scripted floods.
  4. **Max per line**: at most 99 units of one product (configurable lower).
  5. **Max lines**: at most `MAX_LINES = 8` distinct products per order.
  6. **Releases per buyer**: `checkout/release` (a buyer's changed cart releasing an earlier
     checkout) allows 3 per 10 minutes per buyer tag, so a create-then-release loop cannot
     fill the recently-created cap. It is a soft bound (get-then-set, fixed windows); the
     sweep deletes past windows' counters.

  Zero-total orders are refused. **The residual risk:** a client holding many IPv6 /64s (or
  many IPv4 addresses) passes the per-buyer cap and can fill the store-wide caps, refusing real
  buyers until its checkouts expire. These limits count per buyer tag inside the plugin; they
  are not a request rate limit in front of it, so a
  Cloudflare WAF rate-limiting rule on the checkout and order routes is **recommended for public
  launch** (README, *Limits and abuse protection*).
- **Admin pages in Block Kit.** An *Otta Core* group with **Orders** (list, detail, fulfil,
  resolve review, stock) and **Setup & health**, rendered by the private `admin` route
  (`format: "standard"`, no `adminEntry`). Every button calls the same routes as the MCP tools.

### The laws

Stated as the code states them (headers of `src/stock.ts`, `src/orders.ts`, `src/checkout.ts`,
`src/settle.ts`, `src/sweep.ts`; the comments carry the labels).

- **L1. One CAS per stock move, recording who applied it.** Every stock write is one
  `compareAndSet` that carries the guard, the movement and the record of who applied it ("a
  decrement is idempotent only because the row records who applied it", ADR-0019). A reserve adds
  `holds[order]`; a commit drops the hold and takes the units off `onHand`; an unheld sale (paid
  after its holds were released) is recorded permanently in `sold[order]`; a release drops the
  hold and leaves the tombstone `<order>:x`. A sale's idempotency never depends on the bounded
  `applied` ring.
- **L2. Idempotency is the client-minted order id.** The order's document id is the checkout
  key the client mints per submission (`ord_` + 32 lowercase hex). A replayed place-order reads
  the same document and carries it forward from wherever it stopped. A replay with other lines or
  another email is refused (`KEY_REUSED`): one key is one purchase.
- **L3. The order status CAS is the only arbiter.** The order's status, moved only by
  `compareAndSet`, is the only decision. Whether the holds are committed or released follows
  deterministically from it, and anyone (a request, the webhook, the sweep) can replay it. The
  stock module only makes each step exactly-once.
- **L4. Never decide from `applied: false`.** A lost write is never a decision. The writer
  re-reads, re-checks and retries (`updateOrder`, product sync), and a lost order create is read
  as a replay of the existing order.
- **L5. Price on the server, with an exact amount check.** Checkout prices the browser's lines
  from the `products` documents. A paid session settles only if Stripe charged exactly what Core
  priced; anything else moves the order to `review`, settles nothing and keeps the holds. The
  currency always matches exactly. With promotion codes off: `amount_total` equals the order
  total. With promotion codes on: `amount_subtotal` equals the subtotal, shipping equals the
  shipping, tax is 0, and `amount_total = total - amount_discount` with
  `0 <= discount <= total`; a fully discounted session (`no_payment_required`) must total 0 and a
  paid one more than 0.
- **S-b. Release only after Stripe says expired.** Holds are released only once Stripe reports
  the session `expired`, and a card-only session cannot be paid after that, so stock is never
  released for a session that can still take money. A payment that still lands on an
  expired or canceled order is recorded as an unheld sale from on-hand and flagged for a person
  (it can take stock below zero).

  **The documented exception.** Past the session window (`expiresAt` + 2 minutes), sweep part A
  gives up a `reserving` order whose Stripe session was never recorded on it (the request died
  between creating the order and saving the session) and releases its holds **without Stripe
  confirming** the session expired: Core has no session id to ask about. If that session was in
  fact created and is paid late, the payment lands as an unheld sale from on-hand, flagged for
  review like any other late payment. It needs a request dying in a window of a few calls and the
  buyer then paying a session whose URL they never received.

### Money: an exemption from branded types

The repository rule is that a `number` reaching a money field is a type error and that branded
types (`Cents`) carry a currency. **Core is exempt: its amounts are plain integer `number`s of
minor units**, for these reasons:

- **Brands would be erased at every read.** Core's stored documents are plain JSON in the host's
  plugin storage (`ctx.storage`); a brand survives no read, so every read would need a cast, which
  is the unchecked conversion the rule exists to prevent.
- **Money enters through one checked door.** Every amount comes from one parser,
  `util.toMinor` (decimal-string parsing against the domain currency table, so a price with more
  decimals than its currency is refused), or from Stripe's integer fields. Both are checked at
  runtime (`isUInt`), and L5's exact amount check refuses to settle any session whose amounts
  differ from what Core priced.
- **The currency travels with the order.** Every order snapshots its currency, and L5 requires
  Stripe's currency to match it exactly.
- **The tests cover it.** The flow tests and the Postgres race tier exercise pricing, settling,
  promotion codes and refunds end to end.

Core adopts the domain's `Cents` if it gains a second currency per store, computes money beyond
sums and the exact checks (tax, proportional discounts, currency conversion), or comes to share
money code with full Otta beyond the currency table.
### The measured numbers

Measured on this branch's head unless a row says otherwise.

| What | Measured |
|---|---|
| Registry bundle | The real registry tool (`emdash-plugin bundle`) builds backend.js at **62.4 KiB** (bundle total 92.8 KiB) against the 128 KiB per-file and 256 KiB total caps, and its validation passes. CI fails above 72 KiB for backend.js or 128 KiB in total (`pnpm -C packages/core size`). |
| Calls per checkout, real host | Counted in a real EmDash 1.5 host on the refused path: **12 calls at n = 1, 23 at n = 8**. |
| Calls per checkout, harness | The typical success path counts **2n + 9** with a public buyer IP (n = distinct tracked lines), one fewer without: **11 at n = 1, 25 at n = 8**, of the 30 allowed. This is the typical case, not a worst case: an overrun under contention is recoverable, because every step is idempotent and the sweep finishes it. |
| Why `MAX_LINES` is 8 | At 8 lines place-order is typically 25 of 30 calls, which leaves room for two lost CAS rounds under contention. It can rise once a deployed site shows the real headroom. |
| Postgres race tier | `test/pg-race.test.ts`, every racer on its own `pg` connection to one database, **100 runs per scenario**: 20 buyers race for 3 items; one Stripe event delivered 10 times at once; payment races expiry (both ways, including the adversarial case). Real compare-and-set conflicts happened; nothing was oversold or taken twice. Lost compare-and-set writes, as printed by the run at commit `a591fce3` (100 runs per scenario): 6,147 on the stock document with 20 buyers; 1,453 on the order and 312 on stock with one event delivered 10 times; 109 and 36 for payment against expiry; 123 and 43 for the adversarial case; 629 on stock for mixed commit, release and reserve. This ran in the harness, not in the deployed plugin. |
| Test suite | 453 tests in packages/core on SQLite (446 run, 7 Postgres-only skipped); its Postgres tier (23 files, 302 tests with the race tier) runs in CI's integration job. |
| Sandbox and D1 tier | `pnpm -C packages/core test:sandbox` (CI's unit job): the built bundle, read from the registry tarball, runs in EmDash's own Worker Loader runner and PluginBridge under miniflare, with its storage, kv, settings and cron on the miniflare D1 simulator. It drives install, a product publish, checkout, a signed webhook (and its replay), the order lookup and a sweep; a counting bridge fails any invocation past 30 calls. The 30 is enforced by the test host, not by workerd; Cloudflare's own enforcement and CPU time still need a deployed site. |
| Real sandbox | A local EmDash 1.5 site loads the built plugin in the same isolate and bridge a registry install uses; product sync, checkout errors, webhook signatures, CSRF, encrypted secrets, admin routes, the MCP tools, the sweep, the per-buyer cap, resync, refund events and the buyer-tag salt all passed. |
| CPU per request | Not measured. Local workerd does not enforce the 50 ms limit; it needs a deployed site. |

### Size by module

Minified, from esbuild's metafile (before the registry tool strips the MCP tool descriptions,
which is why this totals more than backend.js):

| Module | KiB |
|---|---|
| src/admin-page.ts | 13.7 |
| src/checkout.ts | 7.6 |
| src/admin.ts | 6.9 |
| src/stripe.ts | 5.8 |
| src/plugin.ts | 4.5 |
| src/sweep.ts | 3.7 |
| src/resync.ts | 3.4 |
| src/settings.ts | 2.6 |
| src/util.ts | 2.5 |
| src/products.ts | 2.4 |
| domain/src/money/currencies.ts | 2.3 |
| src/settle.ts | 2.1 |
| src/stock.ts | 1.5 |
| src/orders.ts | 1.5 |
| src/refunds.ts | 1.2 |
| src/health.ts | 1.2 |
| src/export.ts | 0.8 |
| src/release.ts | 0.6 |
| total | 64.4 |

## Consequences

- **Two editions, two document sets.** Core's money paths are its own code and need their own
  tests, reviews and race tier. A fix to a law in one edition must be checked in the other.
- **Upgrading is a migration, not a switch.** A merchant who outgrows Core installs full Otta
  and imports. Until the importer exists, that path is promised, not built. Every Core document
  carries `v`, so the importer can read every version that shipped.
- **Core's documents are frozen by contract.** `model.ts` is edited only by the money-path
  owner; variants already have their place (`variantId: null`, `stockId()`), so adding them
  migrates nothing.
- **The call budget is a design limit, not a tuning knob.** Every route meters or bounds its
  calls (8 lines, sweep admission by typical cost, resync steps); the counts are the typical
  case, and an overrun under contention is recoverable because every step is idempotent and the
  sweep finishes it. A feature that adds calls per line
  lowers `MAX_LINES` or does not fit.
- **What Core does not do** (README, `LISTING.md`): variants, tax calculation, shipping rules,
  customer accounts, downloads, reports, other payment methods. Those are full Otta.
- **The plugin id is not the slug.** Webhook URLs, the buy-button snippet and the MCP scope
  (`mcp:tools:<plugin-id>`) use the `r_` id, which the Setup page shows.

## Alternatives considered

| | Alternative | Why not |
|---|---|---|
| A | **Strip full Otta** down to the registry | It does not fit: the 412 KiB floor is above the 128 KiB file cap before any feature is removed, and its money paths assume no 30-call budget. |
| B | **A registry "companion" over an npm core** (a thin registry plugin in front of full Otta installed from npm) | A registry-only site cannot install the npm half, so the companion sells nothing alone. And it runs under its own `r_` id, so it cannot read or write the npm plugin's documents (constraint 3); it would need a second, network-facing API to full Otta. |
| C | **Share full Otta's storage** (Core writes full Otta's documents, so an upgrade is in place) | Impossible: `ctx.storage` is scoped per plugin id. It would also let code other than full Otta's write full Otta's invariants. |

## What is not proven

1. **Cloudflare's limits by behaviour.** The 30-call and 50 ms CPU limits have only been counted,
   not enforced: local workerd enforces neither. Proving them needs a deployed site on Workers
   Paid (a spending decision for the maintainers).
2. **Installing from the registry.** The consent screens and the `r_` id of a real install cannot
   be exercised locally: the bundle must match a signed release record on the publisher's
   account. It needs a published release.

Real Stripe test mode was exercised on a local EmDash site: card payments, settling without a webhook, replays, forced expiry, promotion codes (20% and 100%), refunds including one made before the payment's webhook, and Link's bank and pay-later options (which settle as card payments).
