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
	| "order-expired";

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
