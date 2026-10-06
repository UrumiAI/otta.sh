import {
	type CancelIntentInput,
	type CancelIntentResult,
	type ClientAction,
	type ConfirmationResult,
	type CreateIntentInput,
	type PaymentGateway,
	type PaymentIntentHandle,
	type RawConfirmation,
	type RefundInput,
	type RefundResult,
} from "@otta-sh/domain";

/**
 * The receipt-forwarding model is retired (ADR-0028, increment 2).
 *
 * This package used to verify a "receipt" — a settle response something else had
 * obtained, plus a `signature` — by posting it to one custom facilitator endpoint
 * (`createHttpFacilitator`) or checking it against an offline HMAC secret
 * (`createTestFacilitator`). No standard x402 facilitator has that endpoint, only
 * the offline HMAC could ever produce `signature`, and nothing checked that the
 * money went to our `payTo`. ADR-0028 replaces the model: the resource server
 * calls the facilitator's standard `/verify` and `/settle` itself, through a new
 * `X402Rail` port (increment 6), from a domain use case that is the only thing
 * able to build a `page_gate` confirmation (increment 7).
 *
 * Until then the gateway settles nothing. Its one caller, the public
 * `entitlements/x402/settle` route, is deleted in the same increment, and
 * `verifyConfirmation` refuses every `page_gate` — so ADR-0028 Decision 2's
 * invariant holds from here on: no client-supplied JSON ever reaches a
 * `page_gate` confirmation.
 */
export interface X402PaymentGatewayOptions {
	/** Destination wallet (the x402 challenge `payTo`). */
	payTo: string;
	/** CAIP-2 networks the challenge accepts (e.g. `["eip155:8453"]`). */
	accepts: string[];
}

/**
 * x402 `PaymentGateway` adapter (§5/§6, step 4.7). `createIntent` returns the
 * `x402_challenge` descriptor. `verifyConfirmation` refuses every confirmation
 * until ADR-0028 increment 7 gives the `page_gate` arm a value only the domain's
 * `payForGatedProduct` can build (see the note above). `refund` and
 * `cancelIntent` are capability statements, unchanged.
 */
export class X402PaymentGateway implements PaymentGateway {
	readonly id = "x402" as const;
	/**
	 * x402 CANNOT refund (ADR-0008). On-chain USDC settlement is irreversible and
	 * this adapter holds no signing wallet. `refundable:false` is honest by construction; the domain
	 * records an x402 refund as a `manual`, out-of-band entry instead of ever
	 * pretending money moved.
	 */
	readonly refundable = false;
	readonly #payTo: string;
	readonly #accepts: string[];

	constructor(options: X402PaymentGatewayOptions) {
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

	/**
	 * Refuses EVERY confirmation, `page_gate` included, with `MALFORMED` (ADR-0028,
	 * increment 2). A `page_gate` today carries an `X402Proof` that any caller can
	 * fill in, and the facilitator call that used to stand between it and a settled
	 * order is gone with the receipt-forwarding model. Increment 7 replaces the arm
	 * with a branded `GatedSettlement` that only `payForGatedProduct` can mint, from
	 * a `/settle` it made itself, and this method then normalises its shape.
	 * `MALFORMED` rather than `INVALID_SIGNATURE`: no confirmation of this shape can
	 * be valid, whatever it says.
	 */
	async verifyConfirmation(_raw: RawConfirmation): Promise<ConfirmationResult> {
		return { ok: false, reason: "MALFORMED" };
	}

	/**
	 * x402 has no outbound-payment capability (ADR-0008): an on-chain settlement
	 * cannot be reversed and the service holds no signing wallet. Return the
	 * capability statement `UNSUPPORTED` — NOT a thrown runtime error — so the
	 * domain records a `manual` refund (the admin sends USDC back to the captured
	 * `payer` out of band) rather than treating a failed "x402 refund" as
	 * retryable. The declared `refundable:false` means the domain never even calls
	 * this on the happy path; it is here only to satisfy the port completely.
	 */
	async refund(_input: RefundInput): Promise<RefundResult> {
		return { ok: false, reason: "UNSUPPORTED" };
	}

	/**
	 * Nothing to withdraw: an x402 "intent" is a stateless page-gate challenge,
	 * not a provider-side object that stays payable — a payment only exists once
	 * the buyer brings back a settled receipt. When an x402 order expires, the
	 * receipt path is what guards it (`settleOrder` refuses a dead order, and x402
	 * is not refundable, so a late receipt is flagged for a manual refund). The
	 * capability statement `UNSUPPORTED`, never a throw, so the expiry sweep moves
	 * on without logging it.
	 */
	async cancelIntent(_input: CancelIntentInput): Promise<CancelIntentResult> {
		return { ok: false, reason: "UNSUPPORTED" };
	}
}
