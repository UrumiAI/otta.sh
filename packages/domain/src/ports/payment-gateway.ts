import type { Cents, Currency } from "../money/cents.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";

/**
 * The `PaymentGateway` port (Phase 4 §5). Pure types — NO pg / ctx / fetch. The
 * seam is drawn at **"raw provider signal → verified normalized settlement"**, so
 * one interface fits an async-webhook gateway like Stripe and any future
 * gateway: the domain `settleOrder` use-case is gateway-agnostic. All secrets
 * / signature crypto live INSIDE the adapter, never in the domain.
 */
export interface PaymentGateway {
	readonly id: PaymentMethod;
	/**
	 * Whether this gateway can move money BACK (ADR-0008). Stripe is `true` (a
	 * first-class idempotent `refunds.create`); a gateway that cannot
	 * move money back (or has no credential to) is `false`. The
	 * domain and admin UI **branch on this flag** — never a `try/catch` to
	 * *discover* refundability at runtime. A Stripe adapter wired WITHOUT a
	 * `secretKey` is effectively `false` (there is no credential to call the live
	 * refund API with), surfaced honestly rather than failing on first use.
	 */
	readonly refundable: boolean;
	/**
	 * Begin payment for an order; returns the buyer-facing next action.
	 *
	 * A gateway that talks to a real provider (Stripe's `paymentIntents.create`)
	 * signals a FAILED attempt by throwing {@link PaymentIntentError} — the one
	 * failure this port models as a typed throw rather than a result union, so the
	 * happy-path signature stays a plain handle for the three call sites that only
	 * ever succeed. `createOrderFromCart` catches it BY TYPE and maps it to
	 * `PAYMENT_INTENT_FAILED` (or, for an `inFlight` one, `PAYMENT_INTENT_IN_FLIGHT`);
	 * anything else propagates (bugs are never swallowed).
	 */
	createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle>;
	/**
	 * Turn a RAW provider confirmation (webhook bytes+headers) into a normalized, cryptographically VERIFIED settlement — or reject.
	 */
	verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult>;
	/**
	 * Move money BACK for an order (ADR-0008) — the mirror of `createIntent`. All
	 * secrets / crypto stay adapter-side, exactly like the money-in verbs.
	 *
	 * Stripe issues a REAL refund (the repo's first live outbound Stripe call):
	 * it FIRST reads the charge/PaymentIntent's `amount_refunded` (the mandatory
	 * refund-time pre-flight) and **fails closed** with `PROVIDER_ALREADY_REFUNDED`
	 * — issuing nothing — when provider-side refunds already exceed the caller's
	 * `priorRefunded` view or this refund would push the provider past what it
	 * captured; only then does it call `refunds.create`, passing `idempotencyKey`
	 * as Stripe's native `Idempotency-Key`. A gateway that cannot refund returns `{ ok:false, reason:
	 * "UNSUPPORTED" }` (a capability statement, not a runtime error) — the caller
	 * records a manual, out-of-band refund instead.
	 */
	refund(input: RefundInput): Promise<RefundResult>;
	/**
	 * Withdraw a payment the buyer has NOT completed, so it can no longer be paid
	 * — the mirror of `createIntent`, called by the intent-cancel sweep
	 * (`cancelDueIntents`) once an unpaid order's time to pay has run out — at its
	 * hold deadline, or at once when it is cancelled unpaid.
	 *
	 * WHY THIS EXISTS. An expired order's PaymentIntent used to stay live: a buyer
	 * who kept the pay page (or its cookie) open past the hold could still pay it,
	 * and the money landed on an order whose stock had already gone back on sale.
	 * Cancelling the intent at the provider closes that window at the source.
	 *
	 * BEST-EFFORT BY CONTRACT. It never runs inside the expiry or the cancel
	 * itself — the sweep drains due intents in its own bounded leg — and a failure
	 * only reschedules it. A cancel that loses the race to a buyer paying at that
	 * instant is not an error either: the provider reports the intent
	 * `not_cancellable`, the payment succeeds, and `settleOrder`'s late-payment
	 * path refunds it. Prevention narrows the window; the refund is what makes the
	 * window safe.
	 *
	 * Stripe calls `POST /v1/payment_intents/{id}/cancel` with our
	 * `idempotencyKey` as its native `Idempotency-Key`, under a short timeout. A
	 * gateway that holds no standing intent to withdraw, or no credential to call the provider with, answers
	 * `UNSUPPORTED`.
	 */
	cancelIntent(input: CancelIntentInput): Promise<CancelIntentResult>;
}

/** Withdraw one payment intent the order minted (see `cancelIntent`). */
export interface CancelIntentInput {
	orderId: OrderId;
	/** The provider's intent id, as `createIntent` returned it and
	 *  `OrderStore.recordPaymentIntent` recorded it (`pi_…` for Stripe). */
	intentId: string;
	/** Every command carries one (CLAUDE.md); passed to the provider as its
	 *  native idempotency key so a re-swept cancel re-calls nothing. */
	idempotencyKey: IdempotencyKey;
}

/**
 * The normalized result of a `cancelIntent` attempt.
 *  - `cancelled` — the provider withdrew the intent; it can no longer be paid.
 *  - `not_cancellable` — the intent SUCCEEDED: the buyer paid at the instant it
 *    was withdrawn. Its webhook settles a still-pending order normally (its stock
 *    was still held) or takes the late-payment refund path on a dead one. An
 *    adapter reports this only once it has seen the success — an intent that is
 *    still payable must be `RETRYABLE`, never this (QA2 M1b).
 *  - `UNSUPPORTED` — the gateway has no standing intent or no credential: a
 *    capability statement, never retried and not worth an operator's attention.
 *  - `RETRYABLE` / `TERMINAL` — the provider could not be reached / refused. The
 *    sweep retries a RETRYABLE one a bounded number of times and gives up on a
 *    TERMINAL one; either way the late-payment refund is the backstop.
 */
export type CancelIntentResult =
	| { ok: true; outcome: "cancelled" | "not_cancellable" }
	| { ok: false; reason: "UNSUPPORTED" | "RETRYABLE" | "TERMINAL" };

export interface RefundInput {
	orderId: OrderId;
	/** The original charge / PaymentIntent id (from the settled `payments` row) to
	 *  refund against. */
	providerRef: string;
	/** The amount to refund (integer minor units). Partial is supported. */
	amount: Cents;
	currency: Currency;
	/**
	 * The caller's (local ledger's) current Σ refunds for this order — the
	 * pre-flight's reference for "have provider-side refunds already diverged past
	 * what we recorded?" A gateway with no provider to ask ignores it.
	 */
	priorRefunded: Cents;
	/** Every command carries one (CLAUDE.md); passed to Stripe as its native
	 *  `Idempotency-Key` so a replay re-calls nothing. */
	idempotencyKey: IdempotencyKey;
}

/**
 * The normalized result of a `refund` attempt (ADR-0008). A success carries the
 * provider refund id (`refundRef`) + the confirmed amount/currency. A failure is
 * a typed reason from the explicit live-error taxonomy:
 *  - `UNSUPPORTED` — the gateway cannot refund at all: a capability
 *    statement, never treat as retryable.
 *  - `PROVIDER_ALREADY_REFUNDED` — the refund-time pre-flight found provider-side
 *    refunds already exceed the local view (or this would over-refund): **nothing
 *    was issued or recorded** — re-check before retrying.
 *  - `RETRYABLE` — a transient transport failure (network / 5xx) BEFORE issuance
 *    is confirmed one way or the other: safe to retry with the same key.
 *  - `TERMINAL` — a definite provider rejection (4xx that is not the
 *    already-refunded case): retrying the same request will not succeed.
 *  - `UNVERIFIED` — the **ambiguous timeout**: `refunds.create` errored with an
 *    unknown fate. NEVER a clean failure — surface as "unverified, re-check the
 *    provider before retrying" (a blind retry could double-refund).
 */
export type RefundResult =
	| { ok: true; refundRef: string; amount: Cents; currency: Currency }
	| {
			ok: false;
			reason: RefundFailureReason;
			/**
			 * On `PROVIDER_ALREADY_REFUNDED`: the provider's own figures from the
			 * pre-flight read — what it shows refunded, and what it captured, in the
			 * payment's minor units. They tell a payment refunded IN FULL outside Otta
			 * from a partial dashboard refund the requested amount would over-run.
			 * Absent when the adapter cannot say.
			 */
			provider?: { refunded: number; captured: number };
	  };

export type RefundFailureReason =
	| "UNSUPPORTED"
	| "PROVIDER_ALREADY_REFUNDED"
	/** The CALLER's own guard declined to start the issuing call (it had no time
	 *  for a whole one): nothing was issued, and it is not the provider's failure —
	 *  retry under the same key, and do not count it as an attempt. */
	| "NOT_STARTED"
	| "RETRYABLE"
	| "TERMINAL"
	| "UNVERIFIED";

/**
 * ONE purchased line, as STRUCTURE — never a pre-rendered provider sentence.
 * The domain states WHAT was bought; how a given provider wants that expressed
 * (Stripe's plain-string `description`, its length limit, joining, truncation)
 * is ADAPTER knowledge and lives in the adapter. Keeping this structural is what
 * lets one port serve Stripe's `description`, and a future PayPal `item_list`
 * without the domain learning any provider's format.
 *
 * `title` is the order line's **purchase-time snapshot** (`OrderLine.title`),
 * never a live product read — so a later rename can never change what a same-key
 * REPLAY sends, which is precisely what keeps a provider's idempotent replay
 * byte-identical (Stripe rejects a same-key retry whose body drifted).
 *
 * Deliberately NO money here: prices would drag the repo's minor-unit
 * convention (each currency's own exponent, `money/currencies.ts`) into a
 * free-text field with no currency exponent attached. Quantity + title is what
 * a goods description needs.
 */
export interface CreateIntentLine {
	/** The product title snapshotted onto the order line at purchase time. */
	title: string;
	/** How many of this line were bought (a positive integer). */
	quantity: number;
}

/**
 * The recipient a physical order ships to — the POSTAL fields of the order's
 * frozen `OrderAddress` snapshot (ADR-0009) and nothing else.
 *
 * Exists because some jurisdictions require a ship-to on the payment itself:
 * Stripe's India-export rules demand `description` **plus** `shipping.name` +
 * `shipping.address` for an export of physical goods
 * (<https://docs.stripe.com/india-exports>). Absent (`undefined`) whenever the
 * order captured no address — a digital-only order, or one predating capture —
 * which is honest absence, never a fabricated destination.
 *
 * **PII crosses the gateway boundary here.** The shape is deliberately narrower
 * than `OrderAddress`: the buyer's `email` / `phone` are NOT included, because no
 * provider needs them to satisfy an export rule. Adapters must keep every field
 * out of logs and out of error messages (`PaymentIntentError` carries only
 * gateway/retryable/status/code — never this).
 */
export interface CreateIntentShipTo {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	/** State / province / region; `null` when the address captured none. */
	region: string | null;
	postalCode: string;
	/** ISO-3166 country as captured (providers commonly want the 2-letter code). */
	country: string;
}

export interface CreateIntentInput {
	orderId: OrderId;
	amount: Cents;
	currency: Currency;
	idempotencyKey: IdempotencyKey;
	/**
	 * The order's purchased lines — **required**, so no call site can mint a
	 * payment that cannot say what it is for. That is not decorative: an
	 * India-based Stripe account REFUSES every export PaymentIntent with no
	 * `description` ("As per Indian regulations, export transactions require a
	 * description"), which made card checkout impossible until this carried the
	 * data. A required field means the compiler, not a live QA session, catches
	 * the next call site that forgets.
	 *
	 * An adapter must still tolerate an empty array (defensively — a real order
	 * always has ≥1 line) rather than emit an empty description.
	 */
	lines: readonly CreateIntentLine[];
	/**
	 * The order's frozen ship-to snapshot, when one was captured. OPTIONAL by
	 * construction: digital orders have no destination, and inventing one would
	 * be worse than omitting it.
	 */
	shipTo?: CreateIntentShipTo;
	/**
	 * The provider-side customer this order's FIRST intent was created with, as
	 * that intent's record kept it (issue #382 — Stripe: the Customer an
	 * India-based account needs on every payment). Absent: no decision recorded
	 * (the order's first intent, or one recorded before decisions were) — the
	 * gateway decides. `null`: decided "none" — the gateway must not create one.
	 * A string: name exactly this one again, creating nothing. Handing the
	 * decision back is what keeps a replay's request byte-identical however the
	 * gateway's own inputs (an account's cached country) moved in between.
	 */
	customerRef?: string | null;
	/**
	 * Whether this order's payment carries a provider-side customer, DECIDED BY
	 * THE ORDER (issue #382): placed under the payment account's buyer-address
	 * requirement AND holding an address. The same answer for the first intent,
	 * every replay and every resume — the gateway reads nothing of its own to
	 * decide it. {@link customerRef} still says WHICH customer, once one exists.
	 * Absent for an order created before the snapshot existed: the gateway then
	 * decides as it always did.
	 */
	customerRequired?: boolean;
}

export interface PaymentIntentErrorInput {
	gateway: PaymentMethod;
	/** True when re-issuing the SAME command with the SAME idempotency key is
	 *  safe and could still succeed (network / 5xx / 429 / 409). */
	retryable: boolean;
	/** Provider HTTP status — LOGS ONLY, never branched on by the domain. */
	providerStatus?: number;
	/** Provider error code (e.g. Stripe `error.code`) — LOGS ONLY. */
	providerCode?: string;
	/**
	 * True when the provider refused ONLY because a request with the same
	 * idempotency key is still being processed (a double-submitted checkout).
	 * Not a failed payment: the same key, asked again shortly, returns the first
	 * request's result. The one field the domain branches on — it answers
	 * `PAYMENT_INTENT_IN_FLIGHT` instead of `PAYMENT_INTENT_FAILED`, so a caller
	 * can say "busy, try again" rather than "we couldn't start a payment".
	 * Defaults to false. Implies `retryable`.
	 */
	inFlight?: boolean;
	message?: string;
}

/**
 * Thrown by {@link PaymentGateway.createIntent} when the provider refused or
 * could not be reached — a gateway-AGNOSTIC, IO-free error so the domain can
 * handle a live-provider failure without importing a Stripe type. The
 * shape mirrors the `ReservationCommitLostError` precedent: a typed throw the
 * use-case catches by class, never a stringly-matched message.
 *
 * `retryable` / `providerStatus` / `providerCode` are DIAGNOSTIC: the domain
 * branches on none of them, and they are LOGGED at the catch site so an operator
 * can tell "Stripe was down" from "the card was declined". The one exception is
 * `inFlight` (a same-key request still being processed), which maps to its own
 * `PAYMENT_INTENT_IN_FLIGHT`; every other `PaymentIntentError` is
 * `PAYMENT_INTENT_FAILED`.
 * `retryable` is the field a future caller-driven retry would branch on; it is
 * not load-bearing yet. **Adapter contract: no credential (a Bearer key, a
 * signing secret) may ever reach `message`, `cause`, or any enumerable field of
 * this error** — it is logged verbatim.
 */
export class PaymentIntentError extends Error {
	readonly gateway: PaymentMethod;
	readonly retryable: boolean;
	readonly providerStatus: number | undefined;
	readonly providerCode: string | undefined;
	readonly inFlight: boolean;

	constructor(input: PaymentIntentErrorInput) {
		super(
			input.message ??
				`payment intent creation failed at gateway "${input.gateway}" (${
					input.retryable ? "retryable" : "terminal"
				}${input.providerStatus === undefined ? "" : `, status ${input.providerStatus}`}${
					input.providerCode === undefined ? "" : `, code ${input.providerCode}`
				})`,
		);
		this.name = "PaymentIntentError";
		this.gateway = input.gateway;
		this.retryable = input.retryable;
		this.providerStatus = input.providerStatus;
		this.providerCode = input.providerCode;
		this.inFlight = input.inFlight === true;
	}
}

export interface PaymentIntentHandle {
	gateway: PaymentMethod;
	/** `pi_…` (Stripe). */
	intentId: string;
	clientAction: ClientAction;
	/**
	 * The provider-side customer the intent was created with (`cus_…`), or `null`
	 * for a decided "none" — recorded with the intent so every replay of the order
	 * gets it back as {@link CreateIntentInput.customerRef}. Absent from a gateway
	 * with no such notion; nothing is recorded then.
	 */
	customerRef?: string | null;
}

export type ClientAction =
	| { kind: "stripe_client_secret"; clientSecret: string }
	| { kind: "none" };

export type RawConfirmation = {
	kind: "webhook";
	body: Uint8Array;
	headers: Record<string, string>;
};

export type ConfirmationResult =
	| {
			ok: true;
			/**
			 * A cryptographically verified event. `succeeded` drives `pending → paid`
			 * + commit/grant; `failed` (e.g. Stripe `payment_intent.payment_failed`)
			 * is recorded and moves nothing — the order stays payable (ADR-0022).
			 * Both dedupe identically.
			 */
			outcome: "succeeded" | "failed";
			orderId: OrderId;
			/** `pi_…` / receipt id — recorded on `payments`. */
			providerRef: string;
			amount: Cents;
			currency: Currency;
			/** Stripe event id → `payment_events` UNIQUE. */
			dedupeKey: string;
			gateway: PaymentMethod;
	  }
	| { ok: false; reason: "INVALID_SIGNATURE" | "UNKNOWN_EVENT" | "MALFORMED" };
