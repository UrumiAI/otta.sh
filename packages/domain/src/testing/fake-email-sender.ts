import type { EmailSender, EmailTemplate, SendEmailInput } from "../ports/email-sender.js";

/**
 * In-memory `EmailSender` — the first adapter to pass the port shape (§6,
 * Phase-0.3 precedent). Records every `send()` so the contract suite can assert
 * **exactly one** send per `(orderId, transition)` (headline cases 4–5) without
 * a real SMTP server. `failNextSends(n)` forces the next N sends to throw, to
 * drive the dispatcher's retry path.
 */
export class FakeEmailSender implements EmailSender {
	readonly sends: SendEmailInput[] = [];
	#failures = 0;

	async send(input: SendEmailInput): Promise<void> {
		if (this.#failures > 0) {
			this.#failures -= 1;
			throw new Error("FakeEmailSender: simulated send failure");
		}
		this.sends.push({ ...input, data: { ...input.data } });
	}

	/** Make the next `n` `send()` calls throw. */
	failNextSends(n: number): void {
		this.#failures = n;
	}

	/** How many emails were sent for a template (optionally scoped to an order). */
	countByTemplate(template: EmailTemplate, orderId?: string): number {
		return this.sends.filter(
			(s) => s.template === template && (orderId === undefined || s.data["orderId"] === orderId),
		).length;
	}

	reset(): void {
		this.sends.length = 0;
		this.#failures = 0;
	}
}
