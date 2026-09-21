/**
 * The in-process `EmailSender` (INC-C5).
 *
 * THE PORT IS UNCHANGED AND THAT IS DELIBERATE. `@otta-sh/domain`'s
 * `EmailSender` and the outbox dispatcher (`dispatchOrderEmails`) do not know
 * this file exists; all that changed in the fold-in is which adapter satisfies
 * the port and how it gets its bytes onto the wire. `service/src/email/senders.ts`
 * used the ambient `fetch` because it was a plain Node process; the plugin is
 * sandboxed, so the same request goes through `ctx.http.fetch` and is gated by
 * `allowedHosts` — whose email entry INC-C3 already resolves from
 * `IN_PROCESS_EGRESS_URLS.emailApiUrl`. Same JSON body, same headers, same
 * rendering (moved verbatim to `@otta-sh/domain`, where its suite still pins
 * every template).
 *
 * `ctx.email` IS REJECTED, by the plan (§D5) and not by omission: EmDash's native
 * sender needs an `email:send` capability grant — widening the manifest's
 * deliberately-two-entry capability list — and a host-configured provider no
 * deployment of ours has. Keeping the port costs one small adapter and keeps the
 * outbox contract, the templates and the idempotency semantics exactly where the
 * contract suite can still see them.
 *
 * IDEMPOTENCY IS A HEADER, AND IT IS LOAD-BEARING. `SendEmailInput.idempotencyKey`
 * IS the outbox row id. The outbox guarantees at-least-once delivery — a sweep
 * tick that dies after the provider accepted but before the row was marked will
 * re-send — so "effectively once" is entirely what the provider makes of
 * `Idempotency-Key`. Dropping it in this swap would have turned every retried
 * tick into a duplicate customer email while the outbox still looked healthy.
 *
 * A NON-2XX THROWS, for the same reason: the dispatcher must not mark a row sent
 * for a message the provider refused.
 */
import { renderEmail, type EmailSender, type SendEmailInput } from "@otta-sh/domain";
import { EMAIL_API_KEY_KEY, readWriteOnlySecret } from "../payment-secrets.js";
import type { PluginContext } from "../types.js";

/**
 * The from-address, in READABLE kv — the in-process equivalent of the service's
 * `EMAIL_FROM`. Not a secret and not write-only: `payment-secrets.ts` records
 * exactly this split for the service's non-secret companions, and a value an
 * operator has to be able to read back into a form has no business in the
 * write-only tier.
 */
export const EMAIL_FROM_KEY = "settings:emailFrom";

/** What the service defaulted `EMAIL_FROM` to (`service/src/index.ts`), carried
 *  over unchanged so a deployment that never set it behaves identically. */
export const DEFAULT_EMAIL_FROM = "no-reply@otta.local";

export interface CtxHttpEmailSenderOptions {
	/** The host's gated egress — `ctx.http.fetch`. Injected, never ambient: a bare
	 *  `fetch` here would bypass `allowedHosts` outright (and the sandbox-clean
	 *  guard would fail the build). */
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	/** Transactional-email API endpoint that accepts a POST of the rendered mail
	 *  — the in-process equivalent of `EMAIL_API_URL`. */
	apiUrl: string;
	from: string;
	apiKey?: string | undefined;
	/** Per-request timeout, via `AbortSignal.timeout`. Defaults to
	 *  {@link DEFAULT_EMAIL_TIMEOUT_MS}. */
	requestTimeoutMs?: number | undefined;
}

/**
 * A hung email provider must never hang a cron tick — the same rule, and the
 * same default, as `payments-stripe`'s `DEFAULT_REQUEST_TIMEOUT_MS` ("a hung
 * Stripe must never hang a Worker checkout").
 *
 * WHY IT IS LOAD-BEARING HERE SPECIFICALLY. `dispatchOrderEmails` wraps each
 * outbox row in its own try/catch, which contains a THROWN send — it does
 * nothing about an unbounded await. One unresponsive provider connection would
 * therefore hold the `order-emails` leg open and starve every sweep leg queued
 * behind it. The abort converts the hang into the throw the dispatcher already
 * knows how to handle, and — as with a non-2xx — the row stays unsent.
 */
export const DEFAULT_EMAIL_TIMEOUT_MS = 30_000;

/** Posts the rendered email to a transactional-email HTTP API over `ctx.http`. */
export class CtxHttpEmailSender implements EmailSender {
	readonly #fetch: (url: string, init?: RequestInit) => Promise<Response>;
	readonly #apiUrl: string;
	readonly #from: string;
	readonly #apiKey: string | undefined;
	readonly #timeoutMs: number;

	constructor(options: CtxHttpEmailSenderOptions) {
		this.#fetch = options.fetch;
		this.#apiUrl = options.apiUrl;
		this.#from = options.from;
		this.#apiKey = options.apiKey;
		this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
	}

	async send(input: SendEmailInput): Promise<void> {
		const rendered = renderEmail(input.template, input.data);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			// The outbox row id. See this module's head comment — removing this line
			// is a silent duplicate-email bug, not a cleanup.
			"Idempotency-Key": input.idempotencyKey,
		};
		if (this.#apiKey !== undefined && this.#apiKey.length > 0) {
			headers["authorization"] = `Bearer ${this.#apiKey}`;
		}
		const res = await this.#fetch(this.#apiUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				from: this.#from,
				to: input.to,
				subject: rendered.subject,
				text: rendered.text,
				html: rendered.html,
				template: input.template,
			}),
			// A hung provider must never hold the cron tick open — see
			// {@link DEFAULT_EMAIL_TIMEOUT_MS}.
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!res.ok) {
			throw new Error(`email transport failed with status ${res.status}`);
		}
	}
}

/** The deployment-supplied half of the wiring — the build-time email URL, the
 *  same value `ALLOWED_HOSTS` derived the granted host from. Passed in rather
 *  than read here so the whole thing stays testable without a bundler. */
export interface EmailSenderEgress {
	apiUrl?: string | undefined;
}

/**
 * Build the sender for a context, or `undefined` when this bundle was built with
 * no email API URL.
 *
 * FAIL-CLOSED, and `undefined` rather than a console-logging stand-in: the
 * service could fall back to `ConsoleEmailSender` because a Node process has a
 * console an operator reads. In the plugin the honest report is "no sender",
 * which is what makes the cron sweep's `order-emails` leg report `skipped`
 * instead of draining the outbox into nowhere.
 *
 * Both kv reads are fail-soft (`readWriteOnlySecret` already swallows a rejection
 * to `undefined`): a kv outage must degrade to an
 * unauthenticated send against the documented default from-address, never take
 * down the tick that was about to drain the outbox.
 */
export async function makeEmailSender(
	ctx: PluginContext,
	egress: EmailSenderEgress,
): Promise<EmailSender | undefined> {
	const apiUrl = egress.apiUrl;
	if (apiUrl === undefined || apiUrl.length === 0) return undefined;
	const [apiKey, from] = await Promise.all([
		readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY),
		readEmailFrom(ctx),
	]);
	return new CtxHttpEmailSender({
		fetch: ctx.http.fetch,
		apiUrl,
		from,
		...(apiKey !== undefined ? { apiKey } : {}),
	});
}

/** The configured from-address, or the documented default — never a throw and
 *  never an empty string a provider would reject as a malformed sender. */
async function readEmailFrom(ctx: PluginContext): Promise<string> {
	try {
		const value = await ctx.kv.get<string>(EMAIL_FROM_KEY);
		return typeof value === "string" && value.length > 0 ? value : DEFAULT_EMAIL_FROM;
	} catch {
		return DEFAULT_EMAIL_FROM;
	}
}
