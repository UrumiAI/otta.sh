import type { EmailSender, SendEmailInput } from "@urumi/domain";
import { renderEmail } from "./render.js";

/**
 * Concrete `EmailSender` adapters (Phase 5 §6/§7). The service sends email
 * directly (the §6 draft ADR — not EmDash's `email:send`), so these live here,
 * service-side. Both render via `renderEmail`; the transport differs.
 *
 * `FakeEmailSender` (in `@urumi/domain/testing`) remains the CI gate for the
 * outbox contract (exactly-once enqueue + claim, at-least-once delivery —
 * effectively-once only once a provider's `Idempotency-Key` dedupes it); these
 * are the real transports a deployment picks.
 */

/** Logs the rendered message — the dev/default transport, observable without any
 *  external service (an SMTP sink / provider adapter swaps in behind the port). */
export class ConsoleEmailSender implements EmailSender {
	#log: (line: string) => void;

	constructor(log: (line: string) => void = console.log) {
		this.#log = log;
	}

	async send(input: SendEmailInput): Promise<void> {
		const rendered = renderEmail(input.template, input.data);
		this.#log(
			`[email] to=${input.to} template=${input.template} key=${input.idempotencyKey} subject=${JSON.stringify(rendered.subject)}`,
		);
	}
}

export interface HttpEmailSenderOptions {
	/** Transactional-email API endpoint that accepts a POST of the rendered mail. */
	apiUrl: string;
	/** Bearer token for the provider API, if any. */
	apiKey?: string;
	from: string;
}

/**
 * Posts the rendered email to a transactional-email HTTP API. Uses the global
 * `fetch` (the service is a normal Node process — this is not the sandboxed
 * plugin). `idempotencyKey` is forwarded so the provider can dedupe too (§6).
 */
export class HttpEmailSender implements EmailSender {
	#opts: HttpEmailSenderOptions;

	constructor(opts: HttpEmailSenderOptions) {
		this.#opts = opts;
	}

	async send(input: SendEmailInput): Promise<void> {
		const rendered = renderEmail(input.template, input.data);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			"Idempotency-Key": input.idempotencyKey,
		};
		if (this.#opts.apiKey !== undefined) headers["authorization"] = `Bearer ${this.#opts.apiKey}`;
		const res = await fetch(this.#opts.apiUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				from: this.#opts.from,
				to: input.to,
				subject: rendered.subject,
				text: rendered.text,
				html: rendered.html,
				template: input.template,
			}),
		});
		if (!res.ok) {
			throw new Error(`email transport failed with status ${res.status}`);
		}
	}
}
