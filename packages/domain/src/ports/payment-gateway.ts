import type { Cents, Currency } from "../money/cents.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";

/**
 * The `PaymentGateway` port (Phase 4 §5). Pure types — NO pg / ctx / fetch. The
 * seam is drawn at **"raw provider signal → verified normalized settlement"**, so
 * one interface fits both Stripe (async webhook) and x402 (synchronous
 * page-gate): the domain `settleOrder` use-case is gateway-agnostic. All secrets
 * / signature crypto live INSIDE the adapter, never in the domain.
 */
export interface PaymentGateway {
	readonly id: PaymentMethod;
	/**
	 * Whether this gateway can move money BACK (ADR-0008). Stripe is `true` (a
	 * first-class idempotent `refunds.create`); x402 is `false` (on-chain
	 * settlement is irreversible and the adapter holds no signing wallet). The
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
	 * `PAYMENT_INTENT_FAILED`; anything else propagates (bugs are never swallowed).
	 */
	createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle>;
	/**
	 * Turn a RAW provider confirmation (webhook bytes+headers, or a page-gate
	 * proof) into a normalized, cryptographically VERIFIED settlement — or reject.
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
	 * as Stripe's native `Idempotency-Key`. x402 returns `{ ok:false, reason:
	 * "UNSUPPORTED" }` (a capability statement, not a runtime error) — the caller
	 * records a manual, out-of-band refund instead.
	 */
	refund(input: RefundInput): Promise<RefundResult>;
}

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
	 * what we recorded?" A gateway with no provider to ask (x402) ignores it.
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
 *  - `UNSUPPORTED` — the gateway cannot refund at all (x402): a capability
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
	| { ok: false; reason: RefundFailureReason };

export type RefundFailureReason =
	| "UNSUPPORTED"
	| "PROVIDER_ALREADY_REFUNDED"
	| "RETRYABLE"
	| "TERMINAL"
	| "UNVERIFIED";

/**
 * ONE purchased line, as STRUCTURE — never a pre-rendered provider sentence.
 * The domain states WHAT was bought; how a given provider wants that expressed
 * (Stripe's plain-string `description`, its length limit, joining, truncation)
 * is ADAPTER knowledge and lives in the adapter. Keeping this structural is what
 * lets one port serve Stripe's `description`, a future PayPal `item_list`, and
 * x402 (which ignores it) without the domain learning any provider's format.
 *
 * `title` is the order line's **purchase-time snapshot** (`OrderLine.title`),
 * never a live product read — so a later rename can never change what a same-key
 * REPLAY sends, which is precisely what keeps a provider's idempotent replay
 * byte-identical (Stripe rejects a same-key retry whose body drifted).
 *
 * Deliberately NO money here: prices would drag the repo's hundredths-scale
 * minor-unit convention into a free-text field with no currency exponent
 * attached — see `STRIPE_UNSUPPORTED_CURRENCIES`. Quantity + title is what a
 * goods description needs.
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
	message?: string;
}

/**
 * Thrown by {@link PaymentGateway.createIntent} when the provider refused or
 * could not be reached — a gateway-AGNOSTIC, IO-free error so the domain can
 * handle a live-provider failure without importing a Stripe (or x402) type. The
 * shape mirrors the `ReservationCommitLostError` precedent: a typed throw the
 * use-case catches by class, never a stringly-matched message.
 *
 * ALL THREE fields are DIAGNOSTIC today: the domain branches on none of them —
 * every `PaymentIntentError` maps to the same `PAYMENT_INTENT_FAILED`, and
 * `retryable` / `providerStatus` / `providerCode` are LOGGED at the catch site so
 * an operator can tell "Stripe was down" from "the card was declined".
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
	}
}

export interface PaymentIntentHandle {
	gateway: PaymentMethod;
	/** `pi_…` (Stripe) or the x402 resource id. */
	intentId: string;
	clientAction: ClientAction;
}

export type ClientAction =
	| { kind: "stripe_client_secret"; clientSecret: string }
	| { kind: "x402_challenge"; accepts: string[]; price: Cents; payTo: string }
	| { kind: "none" };

export type RawConfirmation =
	| { kind: "webhook"; body: Uint8Array; headers: Record<string, string> }
	| { kind: "page_gate"; proof: X402Proof };

/**
 * The x402 page-gate proof forwarded from the Astro page layer to the service
 * (§6). Modeled on the real `@emdash-cms/x402` facilitator **SettleResponse**
 * (`{ success, transaction, network, payer }`), plus the order binding and the
 * amount the resource required. The x402 adapter **re-verifies server-side**
 * (never trusting the plugin's assertion, §9 Risk 2) before normalizing to a
 * `ConfirmationResult`; `transaction` (the on-chain tx hash) is the unique
 * settlement id used as the dedupe key.
 */
export interface X402Proof {
	orderId: OrderId;
	/** On-chain settlement tx hash — unique per settlement → dedupe key. */
	transaction: string;
	network: string;
	payer: string;
	/** The atomic amount the gated resource required (for the equality check). */
	amount: Cents;
	currency: Currency;
	/** Adapter-verifiable authenticity token (facilitator/test-secret signed). */
	signature: string;
}

export type ConfirmationResult =
	| {
			ok: true;
			/**
			 * A cryptographically verified event. `succeeded` drives `pending → paid`
			 * + commit/grant; `failed` (e.g. Stripe `payment_intent.payment_failed`)
			 * drives `pending → failed` + release (§5). Both dedupe identically.
			 */
			outcome: "succeeded" | "failed";
			orderId: OrderId;
			/** `pi_…` / receipt id — recorded on `payments`. */
			providerRef: string;
			amount: Cents;
			currency: Currency;
			/** Stripe event id / x402 receipt id → `payment_events` UNIQUE. */
			dedupeKey: string;
			gateway: PaymentMethod;
	  }
	| { ok: false; reason: "INVALID_SIGNATURE" | "UNKNOWN_EVENT" | "MALFORMED" };
