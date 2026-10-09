import { cents, currency } from "../money/cents.js";
import { orderId as brandOrderId } from "../money/ids.js";
import type { PaymentMethod } from "../orders/model.js";
import type {
	CancelIntentInput,
	CancelIntentResult,
	ClientAction,
	ConfirmationResult,
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
	RawConfirmation,
	RefundInput,
	RefundResult,
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
 * trivial shared-secret check (`x-fake-signature` header), not
 * real crypto: the byte-exact HMAC discipline is proven against the real Stripe
 * adapter (§8 step 4.6). Test helper `webhook()` mints the raw
 * confirmations the domain then verifies.
 */
export class FakePaymentGateway implements PaymentGateway {
	readonly id: PaymentMethod;
	private refundableFlag: boolean;
	#secret: string;
	/** Every `refund` call, in order — lets a contract assert a replay makes NO
	 *  second gateway call (ADR-0008 idempotency). */
	readonly refundCalls: RefundInput[] = [];
	/** Every `createIntent` input, in order — lets a test assert WHAT the domain
	 *  described (line titles/quantities, ship-to) without a real adapter. */
	readonly intentCalls: CreateIntentInput[] = [];
	/** Overrides the default success result when set (drives the error-taxonomy /
	 *  fail-closed cases without a real transport). */
	#refundResult: RefundResult | undefined;
	/** Every `cancelIntent` input, in order — lets the late-payment contract assert
	 *  WHICH intent an expiry withdrew, and that a re-sweep asked nothing again. */
	readonly cancelCalls: CancelIntentInput[] = [];
	/** Overrides the default cancel outcome: a typed result, or an `Error` the
	 *  call THROWS — the two ways a real gateway can let a caller down. */
	#cancelResult: CancelIntentResult | Error | undefined;

	constructor(options: { id?: PaymentMethod; secret?: string; refundable?: boolean } = {}) {
		this.id = options.id ?? "stripe";
		// Default mirrors the real adapter: Stripe refundable — a test can override
		// (e.g. a Stripe adapter with no secretKey ⇒ refundable:false).
		this.refundableFlag = options.refundable ?? true;
		this.#secret = options.secret ?? "test-secret";
	}

	get refundable(): boolean {
		return this.refundableFlag;
	}

	/** Flip the capability after construction — lets one suite exercise both the
	 *  provider and the record-only (manual) refund path through ONE gateway. */
	setRefundable(refundable: boolean): void {
		this.refundableFlag = refundable;
	}

	/** Force the next (and subsequent) `refund` results — a typed failure to
	 *  exercise the error taxonomy / fail-closed path, or a specific success. */
	setRefundResult(result: RefundResult): void {
		this.#refundResult = result;
	}

	/** Back to the default success — the "the provider recovered" step of a
	 *  retryable-failure-then-redelivery case. */
	clearRefundResult(): void {
		this.#refundResult = undefined;
	}

	/** Force every later `cancelIntent` to answer `result`, or to throw it. */
	setCancelResult(result: CancelIntentResult | Error): void {
		this.#cancelResult = result;
	}

	/**
	 * Mirrors the real adapter's capabilities: a Stripe-shaped fake cancels,
	 * unless a test forced an outcome.
	 */
	async cancelIntent(input: CancelIntentInput): Promise<CancelIntentResult> {
		this.cancelCalls.push(input);
		if (this.#cancelResult instanceof Error) throw this.#cancelResult;
		if (this.#cancelResult !== undefined) return this.#cancelResult;
		return { ok: true, outcome: "cancelled" };
	}

	async refund(input: RefundInput): Promise<RefundResult> {
		this.refundCalls.push(input);
		if (!this.refundable) return { ok: false, reason: "UNSUPPORTED" };
		if (this.#refundResult !== undefined) return this.#refundResult;
		return {
			ok: true,
			refundRef: `re_${input.idempotencyKey}`,
			amount: input.amount,
			currency: input.currency,
		};
	}

	async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		this.intentCalls.push(input);
		const clientAction: ClientAction = {
			kind: "stripe_client_secret",
			clientSecret: `cs_test_${input.orderId}`,
		};
		return { gateway: this.id, intentId: `fake_${input.orderId}`, clientAction };
	}

	async verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult> {
		if (raw.headers[SIG_HEADER] !== this.#secret) return { ok: false, reason: "INVALID_SIGNATURE" };
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

	// -- test helpers ----------------------------------------------------------

	/** Mint a signed webhook raw confirmation; pass `badSignature` to force reject. */
	webhook(event: FakeGatewayEvent, opts: { badSignature?: boolean } = {}): RawConfirmation {
		return {
			kind: "webhook",
			body: new TextEncoder().encode(JSON.stringify(event)),
			headers: { [SIG_HEADER]: opts.badSignature ? "wrong" : this.#secret },
		};
	}
}
