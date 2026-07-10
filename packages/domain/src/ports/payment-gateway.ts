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
	/** Begin payment for an order; returns the buyer-facing next action. */
	createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle>;
	/**
	 * Turn a RAW provider confirmation (webhook bytes+headers, or a page-gate
	 * proof) into a normalized, cryptographically VERIFIED settlement — or reject.
	 */
	verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult>;
}

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
