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
	/** Begin payment for an order; returns the buyer-facing next action. */
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

export interface CreateIntentInput {
	orderId: OrderId;
	amount: Cents;
	currency: Currency;
	idempotencyKey: IdempotencyKey;
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
