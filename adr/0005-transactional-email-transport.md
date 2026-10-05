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

_Amended 2026-10-02 (pending maintainer sign-off) — `CtxHttpEmailSender` (`packages/plugin/src/email/ctx-http-email-sender.ts`),
the in-process successor to `HttpEmailSender`, is the **Resend** adapter: it posts Resend's
`POST /emails` body exactly. The vendor is still an implementation detail behind the port —
another provider needs its own `EmailSender` adapter, not a different `EMAIL_API_URL`._

## Amended 2026-10-02 — the settle path sends the just-paid order's email inline; the cron is the backstop

Since [ADR-0020](./0020-one-deployable-plugin-owns-commerce-truth.md) the plugin sends order
email itself, and the only dispatcher has been the cron sweep's `order-emails` leg. That leg
now runs every minute, inside a budget of time and D1 queries (ADR-0019's 2026-10-02
amendment). Even so, a confirmation waits for the next tick, and for its turn behind the
rest of the queue, after a payment has already settled. The outbox decision above is
unchanged; what changes is **when the first delivery attempt happens**.

- **The settle routes dispatch the settled order's rows inline.** After `settleOrder`
  returns ok (`webhooks/stripe/settle` and `entitlements/x402/settle`), the route calls
  `dispatchOrderEmailsForOrder` for that order and then returns the response it had already
  decided. Both dispatchers run one shared drain body, and only the claim differs. The
  inline dispatch therefore carries every sweep semantic: `shouldContinue` before each
  claim, `canSend` before each send, the cut-short and genuine-timeout handling, and failure
  reasons. It also renders the late-payment notice rows (ADR-0022's first 2026-10-02
  amendment), and the provider `Idempotency-Key` is still the outbox row id on both paths.
- **Order-scoped, never the global drain.** It claims through a new port method,
  `OrderStore.claimNextEmailForOrder`, which is `claimNextEmail` narrowed to one order: the
  same due predicate, the same lease, the same single-winner compare-and-set. On the
  document store it is one read of the order document and one write. A request never runs
  the queue-wide drain. The cron and an inline dispatch may race for the same row; the
  "concurrent dispatchers never claim the same row twice" property above covers it, and the
  contract suite pins it for the new claim on every dialect.
- **The first attempt only, and never ahead of the sweep's backoff.** The inline claim takes
  only a row no dispatcher has tried: `attempts === 0` **and** `timeouts === 0`, checked
  inside the same compare-and-set, on top of the due predicate. An uncounted timeout leaves
  `attempts` at 0, but its row is the sweep's to retry, on the sweep's backoff. So the
  inline path makes at most one COUNTED attempt per row, every counted retry is the cron's,
  and the total budget (`maxAttempts`) is unchanged. A cut-short inline attempt (below) is
  uncounted and may recur on a later delivery before the sweep takes the row; the provider
  `Idempotency-Key` dedupes it. Otherwise repeated Stripe redeliveries or x402 re-posts
  during a provider outage would each spend an attempt, and could park the confirmation
  `failed` within minutes.
- **One deadline per settle request.** The plugin has no `waitUntil` (see ADR-0004's
  2026-09-29 amendment), so the work is awaited inline. The settle route can also make up to
  two Stripe calls for a late payment's refund (ADR-0022's first 2026-10-02 amendment): a
  pre-flight read and a create, each capped at 3 s. Bounds that each fit do not add up to
  one that does, so each route fixes **one 8 s deadline as it starts**
  (`settle-deadline.ts`). On the Stripe route every slow step after verification draws on
  it. A READ takes `min(its own cap, what is left)` as it starts; a timed-out read issued
  nothing. The refund CREATE is **its full bound or not started**: a timed-out create is
  ambiguous (it may have reached Stripe) and would flag the order "verify in Stripe" and
  block the automatic retry. So it starts only while 3 s plus the writes after it still fit;
  otherwise it answers not-started, and the refund stays reserved, uncounted, for the
  redelivery or the sweep. This is the same rule as the sweep's late-refunds leg, in one
  shared helper (`boundedRefundStripeOptions`). Worst case, then: storage, a read of at most
  3 s, and a 3 s create only if it fits, all inside 8 s, with the inline email taking what
  is left. The whole delivery therefore stays under Stripe's ~10 s webhook timeout. The
  settle's own storage work is charged to the deadline by running first. The inline wait is
  at most 5 s and never past the deadline, and a spent deadline skips the attempt. Each
  inline send is capped at 3 s (`ORDER_EMAIL_INLINE_TIMEOUT_MS`, defined as the login
  email's ceiling), or at what is left of the wait when it starts if that is less. Once the
  wait runs out, the drain claims nothing new. The claim takes a 1-minute lease instead of
  the sweep's 5 minutes, so a request that dies mid-send holds the row only briefly. The
  x402 route uses the deadline for the inline email only; its facilitator call keeps its own
  bound. A shopper waiting on the x402 page gate can therefore see the response delayed by
  up to the inline wait. This was accepted rather than given a tighter x402-only budget,
  because a provider that answers takes about one round trip.
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

## Amended 2026-10-02 (second) — admin writes send their email inline too

[ADR-0026](./0026-admin-order-actions-never-claim-money-that-did-not-move.md) (QA T1-6). The
amendment above gave the settle routes an inline first attempt. The admin console's order writes
now make the same attempt: a status move, a fulfilment, a cancel or a refund that enqueues a buyer
email ends with `sendOrderEmailsNow` for that order. The rules above hold for this caller too:

- the claim is order-scoped and takes first attempts only, through the same drain;
- the budget is the WRITE's one deadline (`settle-deadline.ts`), fixed as the write starts, and
  the wait is never more than 5 s; an inline timeout is cut short, never the provider's fault;
- the lease is 1 minute;
- failures are swallowed and logged, and never fail the write;
- the cron leg remains the at-least-once backstop.

Two things are new. `sendOrderEmailsNow` resolves to the rows it delivered while the request was
waiting, and the dispatchers gained `onSent(row)`. With these the console says "the buyer has
been emailed" only when the row the write enqueued was delivered. The email goes out in click
order: each write sends what is due for that order, oldest first.

## Amended 2026-10-05 — the store chooses its email provider: Resend or SMTP2GO

A store can now send through SMTP2GO's HTTP API as well as the Resend-shaped sender.

- **The choice is a Settings value, and the default is unchanged.** "Email provider"
  (`settings:emailProvider`, readable kv) is `resend` or `smtp2go`. Unset means `resend`, so an
  existing store keeps sending as before. "SMTP2GO region" (`settings:emailSmtp2goRegion`) is
  `global`, `us`, `eu` or `au`, default `global`. The Settings save refuses any other value,
  all-or-nothing with the rest of the payment settings. An unknown value in kv reads as the
  default and is logged once.
- **One key slot.** The SMTP2GO key lives in the existing write-only `settings:emailApiKey`. A
  store sends through one provider at a time, so the slot holds the active provider's key.
  A second slot would leave the inactive provider's live key in kv with nothing reading it,
  and "is email set up" would need to know which slot counts. The key field's shape check
  follows the saved provider (`re_…` for Resend, `api-…` for SMTP2GO), so the operator saves
  the provider first and then its key. When fallback providers arrive, this becomes the
  primary slot.
- **The seam.** `HttpEmailSender` (`packages/plugin/src/email/http-email-sender.ts`) holds
  what every HTTP provider shares: rendering, the per-send timeout and its
  `EmailSendTimeoutError`, and the sanitizing of provider error text (control characters,
  the recipient and the sender's own key redacted, 200-character bound). A provider is a
  subclass with two methods: build the request and read the response. `CtxHttpEmailSender`
  (Resend's body, unchanged) and `Smtp2goEmailSender` are the two. `makeEmailSender` picks
  one from the setting. Refusals are `EmailProviderError`s with a `kind` (`auth`,
  `rate_limited`, `unavailable`, `invalid`, `refused`, `ambiguous`). The outbox treats every
  kind alike today; the kind is there for the retry and failover rules a registry of
  providers will need.
- **SMTP2GO can refuse with HTTP 200.** A send counts only when `data.succeeded ≥ 1` and
  `data.failed = 0`. A 200 with `failed > 0` is a refusal carrying `data.failures`, and a 2xx
  whose body is not SMTP2GO's JSON is `ambiguous` and is not taken as sent.
- **No idempotency on SMTP2GO.** It defines no idempotency key. The outbox row id rides as an
  `X-Otta-Id` message header for correlation only. With SMTP2GO the outbox's claim is the only
  dedupe, so the at-least-once delivery recorded above can, rarely, deliver an email twice:
  after a timeout that came after SMTP2GO accepted it, or a tick that died before marking the
  row sent. The provider research's `in_flight` / `ambiguous` outbox states are the fix and
  are not built here.
- **allowedHosts.** `api.smtp2go.com`, `us-api.smtp2go.com`, `eu-api.smtp2go.com` and
  `au-api.smtp2go.com` are constant entries in `resolveAllowedHosts` (`manifest.ts`), like
  `api.stripe.com`. The region is a runtime choice and kv cannot widen the build-time list, so
  every region's host is granted in every build. Each host only accepts an SMTP2GO key. They
  are exact hosts, not `*.smtp2go.com`. Adding a provider host remains a manifest change and an
  amendment here.
- **No URL needed for SMTP2GO.** "Can this store send" was "the build has `EMAIL_API_URL`". It
  is now that, or SMTP2GO chosen in Settings (`emailSendingConfigured`). The cron leg and the
  inline settle/admin send ask it before claiming a row. A build with a URL answers without a
  kv read; one without reads the provider choice once per tick or attempt.
