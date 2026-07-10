import {
	type ClientAction,
	type ConfirmationResult,
	type CreateIntentInput,
	type PaymentGateway,
	type PaymentIntentHandle,
	type RawConfirmation,
	type X402Proof,
} from "@urumi/domain";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-side facilitator verification of an x402 settlement receipt (§9 Risk 2).
 * The x402 adapter NEVER trusts the plugin's assertion that payment happened — it
 * asks a facilitator to re-verify the receipt. In production this is an HTTP call
 * to the x402 facilitator (`@x402/core`'s `HTTPFacilitatorClient`, which the
 * `@emdash-cms/x402` Astro integration uses); in tests it is the offline HMAC
 * facilitator below (no network).
 */
export interface X402Facilitator {
	verifyReceipt(proof: X402Proof): Promise<{ valid: boolean }>;
}

export interface X402PaymentGatewayOptions {
	facilitator: X402Facilitator;
	/** Destination wallet (the x402 challenge `payTo`). */
	payTo: string;
	/** CAIP-2 networks the challenge accepts (e.g. `["eip155:8453"]`). */
	accepts: string[];
}

/**
 * x402 `PaymentGateway` adapter (§5/§6, step 4.7). `createIntent` returns the
 * `x402_challenge` descriptor the page layer serves as a 402. `verifyConfirmation`
 * takes the page-gate proof (the facilitator **SettleResponse**: on-chain
 * `transaction` + `network` + `payer` — see `@emdash-cms/x402`), re-verifies it
 * server-side via the injected facilitator, and normalizes it to the shared
 * `ConfirmationResult` — landing on the identical `settleOrder` path as Stripe,
 * granting an entitlement. `transaction` (unique per settlement) is the dedupe key.
 */
export class X402PaymentGateway implements PaymentGateway {
	readonly id = "x402" as const;
	readonly #facilitator: X402Facilitator;
	readonly #payTo: string;
	readonly #accepts: string[];

	constructor(options: X402PaymentGatewayOptions) {
		this.#facilitator = options.facilitator;
		this.#payTo = options.payTo;
		this.#accepts = options.accepts;
	}

	async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		const clientAction: ClientAction = {
			kind: "x402_challenge",
			accepts: this.#accepts,
			price: input.amount,
			payTo: this.#payTo,
		};
		return { gateway: this.id, intentId: `x402_${input.orderId}`, clientAction };
	}

	async verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult> {
		if (raw.kind !== "page_gate") return { ok: false, reason: "MALFORMED" };
		const proof = raw.proof;
		if (typeof proof.transaction !== "string" || proof.transaction.length === 0) {
			return { ok: false, reason: "MALFORMED" };
		}
		// Facilitator-verified server-side — never trust the plugin's word.
		const { valid } = await this.#facilitator.verifyReceipt(proof);
		if (!valid) return { ok: false, reason: "INVALID_SIGNATURE" };
		return {
			ok: true,
			outcome: "succeeded",
			orderId: proof.orderId,
			providerRef: proof.transaction,
			amount: proof.amount,
			currency: proof.currency,
			dedupeKey: proof.transaction,
			gateway: "x402",
		};
	}
}

// -- offline HMAC facilitator (test/dev; NO network) -------------------------

/** Canonical bytes the offline facilitator signs/verifies a receipt over. */
function canonical(proof: Omit<X402Proof, "signature">): string {
	return [
		proof.orderId,
		proof.transaction,
		proof.network,
		proof.payer,
		String(proof.amount),
		proof.currency,
	].join("|");
}

/**
 * An offline facilitator that treats `proof.signature` as an HMAC over the
 * receipt's canonical bytes with a shared secret — a deterministic stand-in for
 * the real facilitator's cryptographic verification (NO network). A real
 * deployment swaps this for an `HTTPFacilitatorClient`-backed impl.
 */
export function createTestFacilitator(secret: string): X402Facilitator {
	return {
		async verifyReceipt(proof: X402Proof): Promise<{ valid: boolean }> {
			const expected = createHmac("sha256", secret).update(canonical(proof)).digest("hex");
			return { valid: safeEqualHex(proof.signature, expected) };
		},
	};
}

/** Mint a valid page-gate proof signed for {@link createTestFacilitator}. */
export function signX402Proof(proof: Omit<X402Proof, "signature">, secret: string): X402Proof {
	const signature = createHmac("sha256", secret).update(canonical(proof)).digest("hex");
	return { ...proof, signature };
}

function safeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}
