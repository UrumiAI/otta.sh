import { cents, currency } from "../money/cents.js";
import { orderId as brandOrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import type {
	ClientAction,
	ConfirmationResult,
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
	RawConfirmation,
	X402Proof,
} from "../ports/payment-gateway.js";

/** A test event the fake driver signs into a `webhook` RawConfirmation. */
export interface FakeGatewayEvent {
	outcome: "succeeded" | "failed";
	orderId: string;
	providerRef: string;
	amount: number;
	currency: string;
	dedupeKey: string;
}

const SIG_HEADER = "x-fake-signature";

/**
 * IO-free `PaymentGateway` fake — drives `settleOrder`'s state machine and
 * `paymentGatewayContract` before any real adapter. Verification here is a
 * trivial shared-secret check (`x-fake-signature` header / `proof.signature`), not
 * real crypto: the byte-exact HMAC discipline is proven against the real Stripe
 * adapter (§8 step 4.6). Test helpers `webhook()` / `pageGate()` mint the raw
 * confirmations the domain then verifies.
 */
export class FakePaymentGateway implements PaymentGateway {
	readonly id: PaymentMethod;
	#secret: string;

	constructor(options: { id?: PaymentMethod; secret?: string } = {}) {
		this.id = options.id ?? "stripe";
		this.#secret = options.secret ?? "test-secret";
	}

	async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		const clientAction: ClientAction =
			this.id === "x402"
				? { kind: "x402_challenge", accepts: ["eip155:8453"], price: input.amount, payTo: "0xTEST" }
				: { kind: "stripe_client_secret", clientSecret: `cs_test_${input.orderId}` };
		return { gateway: this.id, intentId: `fake_${input.orderId}`, clientAction };
	}

	async verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult> {
		if (raw.kind === "webhook") {
			if (raw.headers[SIG_HEADER] !== this.#secret)
				return { ok: false, reason: "INVALID_SIGNATURE" };
			let event: FakeGatewayEvent;
			try {
				event = JSON.parse(new TextDecoder().decode(raw.body)) as FakeGatewayEvent;
			} catch {
				return { ok: false, reason: "MALFORMED" };
			}
			if (typeof event.orderId !== "string" || typeof event.dedupeKey !== "string") {
				return { ok: false, reason: "UNKNOWN_EVENT" };
			}
			return {
				ok: true,
				outcome: event.outcome,
				orderId: brandOrderId(event.orderId),
				providerRef: event.providerRef,
				amount: cents(event.amount),
				currency: currency(event.currency),
				dedupeKey: event.dedupeKey,
				gateway: this.id,
			};
		}
		// page_gate (x402): verify the proof signature server-side.
		const proof = raw.proof;
		if (proof.signature !== this.#secret) return { ok: false, reason: "INVALID_SIGNATURE" };
		return {
			ok: true,
			outcome: "succeeded",
			orderId: proof.orderId,
			providerRef: proof.transaction,
			amount: proof.amount,
			currency: proof.currency,
			dedupeKey: proof.transaction,
			gateway: this.id,
		};
	}

	// -- test helpers ----------------------------------------------------------

	/** Mint a signed webhook raw confirmation; pass `badSignature` to force reject. */
	webhook(event: FakeGatewayEvent, opts: { badSignature?: boolean } = {}): RawConfirmation {
		return {
			kind: "webhook",
			body: new TextEncoder().encode(JSON.stringify(event)),
			headers: { [SIG_HEADER]: opts.badSignature ? "wrong" : this.#secret },
		};
	}

	/** Mint a page-gate raw confirmation from an x402 proof. */
	pageGate(
		proof: Omit<X402Proof, "signature">,
		opts: { badSignature?: boolean } = {},
	): RawConfirmation {
		return {
			kind: "page_gate",
			proof: { ...proof, signature: opts.badSignature ? "wrong" : this.#secret },
		};
	}
}
