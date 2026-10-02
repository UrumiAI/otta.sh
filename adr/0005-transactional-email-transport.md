# 0005. The commerce service sends transactional email directly

- Status: accepted
- Date: 2026-07-11
- Refines: ADR-0002 (the plugin→service direction; host-agnostic service)

## Context

Phase 5 fires transactional emails (magic-link login, order-status transitions). component-map.md
left the tier open: EmDash's plugin `email:send` capability + hook pipeline, vs. the commerce
**service** sending mail itself (SMTP / transactional API).

## Decision

The **service sends email directly** — an `EmailSender` port with a concrete adapter
(`ConsoleEmailSender` as the dev default; `HttpEmailSender` for a transactional-API provider;
the vendor is an implementation detail behind the port) — **not** via EmDash's `email:send`.

The outbox gives **exactly-once enqueue** and **exactly-once claim**, but only
**at-least-once delivery**: the guarded state `UPDATE` and the `order_emails_outbox` `INSERT`
commit in one transaction (`UNIQUE(order_id, to_state)`), so a status transition enqueues its
email row exactly once, and a cron dispatcher claims rows with an atomic conditional `UPDATE`
(lease-based), so concurrent dispatchers never claim the same row twice. A crash between
`EmailSender.send()` and `markEmailSent`, however, leaves the row leased-but-unmarked; once the
lease expires it is re-claimed and re-sent. Dedup down to **effectively-once** relies on the
transactional-API provider's idempotency key (`HttpEmailSender` passes the outbox row id as an
`Idempotency-Key`); `ConsoleEmailSender` has no such backstop and can print a duplicate line.

## Consequences

- **Right dependency direction.** Most triggers originate service-side (a Stripe webhook, an
  admin REST call) and never pass through the plugin's request lifecycle; routing through
  `email:send` would invert the plugin→service direction ADR-0002 fixed the architecture around.
- The outbox is naturally commerce-service state; splitting "did we send" from "the sender"
  across the plugin boundary would add a synchronization problem with no benefit.
- **Host-agnostic** (ADR-0002): the service works for non-EmDash storefronts; an
  `email:send`-dependent design would pin transactional email to EmDash.
- Reuses the `PaymentGateway` precedent (a service-owned port, adapters swapped by deployment).
- The service needs its own outbound-email credentials/deliverability (SPF/DKIM) — an ops task.
  If EmDash's pipeline is preferred later, it is an additional `EmailSender` adapter, not a
  redesign.
- The plugin declares **no** `email:send` capability — confirmed by the sandbox capability-surface
  check (only `content:read` + `network:request`).

_Accepted 2026-07-11 — signed off by the maintainer (vedanshu@urumi.ai), implemented per the
Phase 5 plan §6 recommendation._

## Amended 2026-10-02 — the settle path sends the just-paid order's email inline; the cron is the backstop

Since [ADR-0020](./0020-one-deployable-plugin-owns-commerce-truth.md) the plugin sends order
email itself, and the only dispatcher has been the cron sweep's `order-emails` leg. That leg
now runs every minute, inside a budget of time and D1 queries (ADR-0019's 2026-10-02
amendment). Even so, a confirmation waits for the next tick, and for its turn behind the rest
of the queue, after a payment has already settled. The outbox decision above is unchanged;
what changes is **when the first delivery attempt happens**.

- **The settle routes dispatch the settled order's rows inline.** After `settleOrder` returns
  ok (`webhooks/stripe/settle` and `entitlements/x402/settle`), the route calls
  `dispatchOrderEmailsForOrder` for that order and then returns the response it had already
  decided. Both dispatchers run one shared drain body, and only the claim differs. The inline
  dispatch therefore carries every sweep semantic: `shouldContinue` before each claim,
  `canSend` before each send, the cut-short and genuine-timeout handling, and failure
  reasons. It also renders the late-payment notice rows (ADR-0022's first 2026-10-02 amendment), and the
  provider `Idempotency-Key` is still the outbox row id on both paths.
- **Order-scoped, never the global drain.** It claims through a new port method,
  `OrderStore.claimNextEmailForOrder`, which is `claimNextEmail` narrowed to one order: the
  same due predicate, the same lease, the same single-winner compare-and-set. On the
  document store it is one read of the order document and one write. A request never runs
  the queue-wide drain. The cron and an inline dispatch may race for the same row; the
  "concurrent dispatchers never claim the same row twice" property above covers it, and the
  contract suite pins it for the new claim on every dialect.
- **The first attempt only, and never ahead of the sweep's backoff.** The inline claim takes
  only a row no dispatcher has tried: `attempts === 0` **and** `timeouts === 0`, checked inside
  the same compare-and-set, on top of the due predicate. An uncounted timeout leaves
  `attempts` at 0, but its row is the sweep's to retry, on the sweep's backoff. So the inline
  path makes at most one attempt per row, every retry is the cron's, and the total budget
  (`maxAttempts`) is unchanged. Otherwise repeated Stripe redeliveries or x402 re-posts
  during a provider outage would each spend an attempt, and could park the confirmation
  `failed` within minutes.
- **One deadline per settle request.** The plugin has no `waitUntil` (see ADR-0004's
  2026-09-29 amendment), so the work is awaited inline. The settle route can also make up to
  two Stripe calls for a late payment's refund (ADR-0022's first 2026-10-02 amendment), each capped at 3 s.
  Bounds that each fit do not add up to one that does, so each route fixes **one 8 s deadline
  as it starts** (`settle-deadline.ts`). Every slow step after verification draws on it,
  taking `min(its own cap, what is left)` as each call starts. The whole delivery therefore
  stays under Stripe's ~10 s webhook timeout. The settle's own storage work is charged to the
  deadline by running first. The inline wait is at most 5 s and never past the deadline, and
  a spent deadline skips the attempt. Each inline send is capped at 3 s
  (`ORDER_EMAIL_INLINE_TIMEOUT_MS`, defined as the login email's ceiling), or at what is left
  of the wait when it starts if that is less. Once the wait runs out, the drain claims
  nothing new. The claim takes a 1-minute lease instead of the sweep's 5 minutes, so a
  request that dies mid-send holds the row only briefly. The x402 page-gate route uses the
  same budget, so a shopper waiting on that page can see the response delayed by up to that
  wait. This was accepted rather than given a tighter x402-only budget, because a provider
  that answers takes about one round trip.
- **An inline timeout is never the provider's fault.** The sweep gives each send its full
  allowance, so a timeout there counts against the provider: it is backed off, recorded,
  reported and counted past a limit. An inline send gets less, so every inline timeout is
  marked **cut short**. The row is released uncounted and due at once, nothing is recorded
  against the provider, and the sweep sends it with the full allowance.
- **Failures are swallowed; some are logged.** Nothing the dispatch does can change the
  route's status: the payment is recorded, and a non-200 would ask Stripe to redeliver a
  settlement that already happened. A failed send is not logged. The dispatcher catches it
  and reschedules the row past the short lease, exactly as a cron tick would. A store
  rejection from the claim or the mark is logged with `console.error`, giving the order id
  and the error message only, never the error object. A skipped or abandoned attempt is
  logged with `console.warn`, with the order id.
- **The cron leg remains the at-least-once guarantee.** The next tick delivers whatever the
  inline attempt missed. A bundle with no email API URL claims nothing inline, and the leg
  still reports `skipped`. The inline path fires on any ok settle, replays included. A
  delivery can commit the paid flip and then answer 503, so it never reaches the send; its
  row is still unattempted, and the redelivery is the first chance. When nothing is due, a
  replay costs one read of the order document, because the sender (and its kv reads) is
  built only once a row has been claimed.
