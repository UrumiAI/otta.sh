import type { Email } from "../money/ids.js";

/**
 * Transactional email templates (Phase 5 §6). `customer-login-link` is the
 * magic-link email (the port's first consumer, §4); the rest are the
 * order-status transition emails. Every template is rendered from data passed
 * explicitly — no template reaches back into a store (keeps `EmailSender`
 * IO-shaped but logic-free).
 */
export type EmailTemplate =
	| "customer-login-link"
	| "order-confirmation"
	| "order-processing"
	| "order-shipped"
	| "order-delivered"
	| "order-completed"
	| "order-cancelled"
	| "order-refunded"
	| "order-expired"
	/** A NOTICE, not a transition email (`OrderNotice` "late-payment-refunded"):
	 *  a payment landed after the order expired or was cancelled, and was
	 *  refunded automatically. */
	| "order-late-payment-refunded"
	/** A NOTICE (`OrderNotice` "refund-issued"): an admin refund that left money
	 *  captured — one per refund, stating its own amount. */
	| "order-partially-refunded";

export interface SendEmailInput {
	to: Email;
	template: EmailTemplate;
	/** Template-specific, validated by the caller. */
	data: Record<string, unknown>;
	/** = the outbox row id for status emails; adapters may use it for
	 *  provider-side dedup too (Phase 5 §6). */
	idempotencyKey: string;
}

/**
 * The `EmailSender` port (Phase 5 §6). Service-owned (not EmDash's
 * `email:send`), so most triggers — a Stripe webhook, an admin REST call —
 * originate service-side without a plugin round trip (§6 draft ADR). The
 * `FakeEmailSender` is the first adapter to pass the contract; a concrete
 * transactional-API / SMTP adapter swaps in behind this shape.
 */
export interface EmailSender {
	send(input: SendEmailInput): Promise<void>;
}

/**
 * A send abandoned because its caller's time ran out — not a provider failure.
 *
 * The cron sweep gives each send only what is left of its tick. A send cut off
 * there says nothing about the row (the provider was never given the time to
 * answer), so `dispatchOrderEmails` hands the row back WITHOUT counting the
 * attempt rather than spending one of the row's `maxAttempts` on it; a row that
 * only ever timed out is therefore never parked `failed`. If the provider did
 * deliver after all, the next try carries the same `Idempotency-Key` (the
 * outbox row id), so the provider dedupes it.
 */
export class EmailSendTimeoutError extends Error {
	readonly timeoutMs: number;
	/**
	 * The caller gave this send LESS than its full allowance (it was short of time
	 * itself). Then the timeout says nothing about the provider at all: the row is
	 * handed back due at once, with no backoff and no timeout recorded.
	 */
	readonly cutShort: boolean;
	constructor(timeoutMs: number, options: { cutShort?: boolean } = {}) {
		super(`email send abandoned after ${String(timeoutMs)} ms`);
		this.name = "EmailSendTimeoutError";
		this.timeoutMs = timeoutMs;
		this.cutShort = options.cutShort === true;
	}
}

/** Whether a timeout error says the send was cut short by its caller (see
 *  {@link EmailSendTimeoutError.cutShort}); structural, like the check below. */
export function isCutShortEmailTimeout(err: unknown): boolean {
	return isEmailSendTimeoutError(err) && (err as { cutShort?: unknown }).cutShort === true;
}

/** What {@link isEmailSendTimeoutError} can promise about a value it accepts: the
 *  name, and the class's fields only as POSSIBLY present — an error that crossed a
 *  bridge is a plain object that may have dropped them. */
export interface EmailSendTimeoutLike {
	readonly name: "EmailSendTimeoutError";
	readonly timeoutMs?: number;
	readonly cutShort?: boolean;
}

/** Structural, not `instanceof`: an error that crossed a bridge is a plain
 *  object on the other side — the same rule the storage errors follow. Narrows to
 *  {@link EmailSendTimeoutLike}, so a caller reads `timeoutMs` typed, and honestly
 *  as maybe-absent. */
export function isEmailSendTimeoutError(err: unknown): err is EmailSendTimeoutLike {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "EmailSendTimeoutError"
	);
}
