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
	/** A NOTICE (`OrderNotice` "refund-issued"): a refund announced on its own — an
	 *  admin partial refund, or a lost-race cancellation's refund — one per refund,
	 *  stating its own amount. */
	| "order-refund-issued";

export interface SendEmailInput {
	to: Email;
	template: EmailTemplate;
	/** Template-specific, validated by the caller. */
	data: Record<string, unknown>;
	/** = the outbox row id for status emails, `login:<challenge>` for the sign-in
	 *  email. A correlation id: the EmDash host's `ctx.email` carries no
	 *  idempotency key, so delivery is at-least-once (ADR-0031). */
	idempotencyKey: string;
}

/**
 * The `EmailSender` port (Phase 5 §6). The plugin's one adapter renders the
 * template and hands the message to the EmDash host's `ctx.email` (ADR-0031);
 * the host's selected email provider delivers it. The `FakeEmailSender` is the
 * contract's reference adapter.
 */
export interface EmailSender {
	send(input: SendEmailInput): Promise<void>;
}

/**
 * The transport has no provider to hand the message to — nothing was sent, and
 * nothing about the row is wrong (ADR-0031: the EmDash host has no email
 * provider selected).
 *
 * `dispatchOrderEmails` releases the row WITHOUT counting the attempt, due again
 * after `TRANSPORT_UNAVAILABLE_RETRY_MS`, and stops the drain: every other row
 * would meet the same answer. The queue waits, intact, until a provider is
 * configured.
 */
export class EmailTransportUnavailableError extends Error {
	constructor(message = "no email provider is configured") {
		super(message);
		this.name = "EmailTransportUnavailableError";
	}
}

/** Structural, not `instanceof`, like {@link isEmailSendTimeoutError}: an error
 *  that crossed a bridge is a plain object on the other side. */
export function isEmailTransportUnavailableError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "EmailTransportUnavailableError"
	);
}

/**
 * A send abandoned because its caller's time ran out — not a provider failure.
 *
 * The cron sweep gives each send only what is left of its tick. A send cut off
 * there says nothing about the row (the provider was never given the time to
 * answer), so `dispatchOrderEmails` hands the row back WITHOUT counting the
 * attempt rather than spending one of the row's `maxAttempts` on it; a row that
 * only ever timed out is therefore never parked `failed` for that alone. That is
 * safe only where a retry cannot duplicate a delivered email. The EmDash host's
 * `ctx.email` has no idempotency key, so the plugin re-throws every timeout as a
 * COUNTED failure (`countTimeoutsAsAttempts`, ADR-0031): duplicates are bounded
 * by the row's `maxAttempts`.
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
