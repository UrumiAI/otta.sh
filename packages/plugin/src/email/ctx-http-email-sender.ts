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
import {
	EmailSendTimeoutError,
	renderEmail,
	type EmailSender,
	type SendEmailInput,
} from "@otta-sh/domain";
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
	 *  {@link DEFAULT_EMAIL_TIMEOUT_MS}. A FUNCTION is asked at each send — the cron
	 *  sweep passes one, so each request is aborted at what is left of the tick when
	 *  that send starts rather than at a figure fixed long before it. */
	requestTimeoutMs?: number | (() => number) | undefined;
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
 *
 * THIRTY SECONDS IS NOT THE CRON'S CEILING, though. It is the fallback for a
 * caller that sets none; the cron sweep runs inside a host hook abandoned after
 * 5 s, so it passes its own, far shorter, per-send timeout
 * (`SWEEP_EMAIL_SEND_TIMEOUT_MS` in `cron/sweeps.ts`) — a 30 s send there would
 * outlive the hook, leave its row leased, and be re-sent when the lease lapsed.
 */
export const DEFAULT_EMAIL_TIMEOUT_MS = 30_000;

/** Posts the rendered email to a transactional-email HTTP API over `ctx.http`. */
export class CtxHttpEmailSender implements EmailSender {
	readonly #fetch: (url: string, init?: RequestInit) => Promise<Response>;
	readonly #apiUrl: string;
	readonly #from: string;
	readonly #apiKey: string | undefined;
	readonly #timeoutMs: number | (() => number);

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
		const timeoutMs = typeof this.#timeoutMs === "function" ? this.#timeoutMs() : this.#timeoutMs;
		const signal = AbortSignal.timeout(timeoutMs);
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
			signal,
		}).catch((err: unknown) => {
			// Our OWN abort is a TIMEOUT, not a provider failure: the dispatcher hands
			// the row back without counting the attempt (`EmailSendTimeoutError`).
			// Judged by OUR signal having fired, not by the error's name — a transport
			// may reject a timeout-abort as a DOMException "TimeoutError", an
			// "AbortError", or a plain error, and the sweep's own timer fires at the same
			// moment, so whichever wins must read as the same timeout.
			if (signal.aborted) throw new EmailSendTimeoutError(timeoutMs);
			throw err;
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
	options: { requestTimeoutMs?: number | (() => number) } = {},
): Promise<EmailSender | undefined> {
	const apiUrl = egress.apiUrl;
	if (apiUrl === undefined || !emailSenderConfigured(egress)) return undefined;
	const [apiKey, from] = await Promise.all([
		readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY),
		readEmailFrom(ctx),
	]);
	return new CtxHttpEmailSender({
		fetch: ctx.http.fetch,
		apiUrl,
		from,
		...(apiKey !== undefined ? { apiKey } : {}),
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
	});
}

/**
 * Whether {@link makeEmailSender} would build a sender for this egress — the same
 * predicate, without its kv reads. A caller that only wants to pay for the sender
 * once there is something to send (the settle routes' inline dispatch) asks this
 * first, so "unconfigured" is decided before anything is claimed.
 */
export function emailSenderConfigured(egress: EmailSenderEgress): boolean {
	return egress.apiUrl !== undefined && egress.apiUrl.length > 0;
}

/**
 * The ceiling on the LOGIN email's send (issue #306 review).
 *
 * Neither the login email nor the cron tick's order emails can afford
 * {@link DEFAULT_EMAIL_TIMEOUT_MS}: the tick runs inside a host hook with a 5 s
 * timeout and caps each send itself (`SWEEP_EMAIL_SEND_TIMEOUT_MS` in
 * `cron/sweeps.ts`), and the settle routes' INLINE attempt at a just-paid order's
 * email caps each send at `ORDER_EMAIL_INLINE_TIMEOUT_MS`, defined as this constant
 * (`send-order-emails-now.ts`). The login email cannot for its own reason: it is
 * awaited inline on the login-request route, and a
 * THROTTLED request skips the send altogether. With a 30 s ceiling a slow provider
 * would make a sent request seconds slower than a throttled one — the latency
 * itself would say which it was. Bounding the send keeps that gap small; it does
 * not close it (a healthy provider's round trip is still only paid on the sent
 * arm — see ADR-0004's 2026-09-29 amendment). A send that times out is logged and
 * the request still answers the same generic success.
 */
export const LOGIN_EMAIL_TIMEOUT_MS = 3_000;

/** {@link makeEmailSender} with the login ceiling. */
export function makeLoginEmailSender(
	ctx: PluginContext,
	egress: EmailSenderEgress,
): Promise<EmailSender | undefined> {
	return makeEmailSender(ctx, egress, { requestTimeoutMs: LOGIN_EMAIL_TIMEOUT_MS });
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
