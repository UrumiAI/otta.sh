/**
 * The part of an HTTP `EmailSender` that does not depend on the provider.
 *
 * Every provider Otta sends through takes one HTTPS POST of an already-rendered
 * message. What differs is the request (URL, auth header, body field names) and
 * how a refusal is read back. So a provider sender is two methods —
 * {@link HttpEmailSender.buildRequest} and {@link HttpEmailSender.checkResponse}
 * — on top of what is shared here and must stay the same for every provider:
 *  - rendering (`renderEmail` with the storefront's money, the store's name and,
 *    for an order email, the order page link);
 *  - the per-send timeout, and turning OUR abort into `EmailSendTimeoutError`
 *    so the dispatcher hands the row back uncounted;
 *  - the provider's error text, sanitized and bounded before it reaches a log
 *    line, with the recipient and the sender's own key redacted.
 *
 * This is the seam the multi-provider design grows from (the "provider layer
 * beneath the port" in the provider research): today the two senders are
 * `CtxHttpEmailSender` (Resend's body) and `Smtp2goEmailSender`; a registry of
 * adapters can replace the subclasses without moving any of this.
 *
 * SANDBOX-CLEAN: `fetch` is injected (`ctx.http.fetch`), never ambient.
 */
import {
	EmailSendTimeoutError,
	renderEmail,
	type EmailSender,
	type EmailTemplate,
	type SendEmailInput,
} from "@otta-sh/domain";
import { STOREFRONT_LOCALE } from "../storefront/route-input.js";
import { orderPageUrl, storefrontEmailMoney } from "./email-render-context.js";

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

/** What every HTTP sender is built from, whichever provider it speaks. */
export interface HttpEmailSenderOptions {
	/** The host's gated egress — `ctx.http.fetch`. Injected, never ambient: a bare
	 *  `fetch` here would bypass `allowedHosts` outright (and the sandbox-clean
	 *  guard would fail the build). */
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	from: string;
	apiKey?: string | undefined;
	/** Per-request timeout, via `AbortSignal.timeout`. Defaults to
	 *  {@link DEFAULT_EMAIL_TIMEOUT_MS}. A FUNCTION is asked at each send — the cron
	 *  sweep passes one, so each request is aborted at what is left of the tick when
	 *  that send starts rather than at a figure fixed long before it. */
	requestTimeoutMs?: number | (() => number) | undefined;
	/** The store's name ("Store display name"), for the sign-in email. */
	storeName?: string | undefined;
	/** The storefront's public origin (`storefrontOriginOf`), for the order page
	 *  link in order emails. Absent ⇒ order emails carry no link. */
	storefrontOrigin?: string | undefined;
}

/** One rendered message, in provider-neutral terms. */
export interface OutboundEmail {
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
	template: EmailTemplate;
	/** The outbox row id (`SendEmailInput.idempotencyKey`): a dedupe key where
	 *  the provider honours one, a correlation id where it does not. */
	ottaId: string;
}

/** The request a provider sender wants made. Method is always POST. */
export interface ProviderRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * Why a provider refused, by class — the start of the error taxonomy the
 * multi-provider design needs for retry and failover decisions. Today the
 * outbox treats every class the same (rescheduled, counted); the class is for
 * the log and for whoever reads it.
 *  - `auth`: 401/403 — a missing, wrong or revoked key, or one without send rights.
 *  - `rate_limited`: 429.
 *  - `unavailable`: 5xx.
 *  - `invalid`: any other non-2xx.
 *  - `refused`: the provider answered success-shaped but sent nothing
 *    (SMTP2GO's 200 with `failed > 0`).
 *  - `ambiguous`: a 2xx we cannot read — it may or may not have been sent.
 */
export type EmailProviderErrorKind =
	| "auth"
	| "rate_limited"
	| "unavailable"
	| "invalid"
	| "refused"
	| "ambiguous";

/** A provider's refusal. The message carries the provider's own reason,
 *  sanitized and bounded ({@link sanitizeProviderDetail}); it never carries the
 *  request, the key or the recipient. */
export class EmailProviderError extends Error {
	readonly kind: EmailProviderErrorKind;
	readonly status: number;

	constructor(kind: EmailProviderErrorKind, status: number, message: string) {
		super(message);
		this.name = "EmailProviderError";
		this.kind = kind;
		this.status = status;
	}
}

/** The class of a non-2xx status. */
export function kindOfStatus(status: number): EmailProviderErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "unavailable";
	return "invalid";
}

/** The error a non-2xx becomes: `email transport failed with status N[: detail]`
 *  — the wording the Resend sender has always logged. */
export function statusFailure(status: number, detail: string | undefined): EmailProviderError {
	return new EmailProviderError(
		kindOfStatus(status),
		status,
		`email transport failed with status ${String(status)}${detail === undefined ? "" : `: ${detail}`}`,
	);
}

/** Posts a rendered email to one provider's HTTP API over `ctx.http`. */
export abstract class HttpEmailSender implements EmailSender {
	readonly #fetch: (url: string, init?: RequestInit) => Promise<Response>;
	readonly #from: string;
	readonly #timeoutMs: number | (() => number);
	readonly #storeName: string | undefined;
	readonly #storefrontOrigin: string | undefined;
	/** The key, for the subclass's request and for redaction. Never logged. */
	protected readonly apiKey: string | undefined;

	constructor(options: HttpEmailSenderOptions) {
		this.#fetch = options.fetch;
		this.#from = options.from;
		this.apiKey =
			options.apiKey !== undefined && options.apiKey.length > 0 ? options.apiKey : undefined;
		this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
		this.#storeName = options.storeName;
		this.#storefrontOrigin = options.storefrontOrigin;
	}

	/** The provider's request for one message. */
	protected abstract buildRequest(message: OutboundEmail): ProviderRequest;

	/** Resolve when the provider accepted the message; throw (an
	 *  {@link EmailProviderError}) when it did not, so the dispatcher never marks
	 *  a row sent for a message the provider refused. */
	protected abstract checkResponse(res: Response, message: OutboundEmail): Promise<void>;

	async send(input: SendEmailInput): Promise<void> {
		// Money as the storefront formats it, the store's name, and — for an order
		// email — the order's page (QA U-3). See `email-render-context.ts`.
		const orderId = input.data["orderId"];
		const rendered = renderEmail(input.template, input.data, {
			formatMoney: storefrontEmailMoney,
			locale: STOREFRONT_LOCALE,
			storeName: this.#storeName,
			orderPageUrl:
				input.template !== "customer-login-link" &&
				typeof orderId === "string" &&
				orderId.length > 0 &&
				this.#storefrontOrigin !== undefined
					? orderPageUrl(this.#storefrontOrigin, orderId)
					: undefined,
		});
		const message: OutboundEmail = {
			from: this.#from,
			to: input.to,
			subject: rendered.subject,
			text: rendered.text,
			html: rendered.html,
			template: input.template,
			ottaId: input.idempotencyKey,
		};
		const request = this.buildRequest(message);
		const timeoutMs = typeof this.#timeoutMs === "function" ? this.#timeoutMs() : this.#timeoutMs;
		const signal = AbortSignal.timeout(timeoutMs);
		// Our OWN abort is a TIMEOUT, not a provider failure: the dispatcher hands
		// the row back without counting the attempt (`EmailSendTimeoutError`).
		// Judged by OUR signal having fired, not by the error's name — a transport
		// may reject a timeout-abort as a DOMException "TimeoutError", an
		// "AbortError", or a plain error, and the sweep's own timer fires at the same
		// moment, so whichever wins must read as the same timeout.
		const asTimeout = (err: unknown): never => {
			if (signal.aborted) throw new EmailSendTimeoutError(timeoutMs);
			throw err;
		};
		const res = await this.#fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: request.body,
			// A hung provider must never hold the cron tick open — see
			// {@link DEFAULT_EMAIL_TIMEOUT_MS}.
			signal,
		}).catch(asTimeout);
		// Reading the body is bounded by the same signal (`readProviderJson` turns
		// an unreadable body into "said nothing"). A body cut off by our timeout
		// after a 2xx therefore reads as `ambiguous`, not as a timeout: the
		// provider answered, so the attempt counts.
		await this.checkResponse(res, message);
	}

	/** Values a provider's error text must never carry back into a log line:
	 *  the recipient and this sender's key. */
	protected redactions(message: OutboundEmail): Redaction[] {
		const list: Redaction[] = [{ value: message.to, as: "<recipient>" }];
		if (this.apiKey !== undefined) list.push({ value: this.apiKey, as: "<api key>" });
		return list;
	}
}

/** The ceiling on how much of a provider's error message reaches a log line. */
const PROVIDER_ERROR_MAX_CHARS = 200;

/** The error body is parsed from at most its first this-many characters.
 *  A provider's error object is well under 1 KiB; anything past this is not
 *  one, and the error path must not parse megabytes an intermediary chose to
 *  send. (The body is still read whole — `ctx.http.fetch` offers no bounded
 *  read — and the request's abort signal bounds how long that read can take.) */
const PROVIDER_ERROR_MAX_BODY_CHARS = 4096;

/** C0 and C1 controls, DEL, and the Unicode line/paragraph separators — what a
 *  provider message must not smuggle into a log line (a CR/LF, NEL or U+2028
 *  there forges a second, fake log entry in a viewer that breaks on it). */
// oxlint-disable-next-line no-control-regex -- matching control characters IS the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** A value to strip from provider text, and what to put in its place. */
export interface Redaction {
	value: string;
	as: string;
}

/**
 * A provider's response body as JSON, parsed from at most its first
 * {@link PROVIDER_ERROR_MAX_BODY_CHARS} characters, or `undefined` when it is
 * not JSON (an HTML gateway page, an empty body) or cannot be read at all.
 * Never throws: a body that cannot be read is the same as one that says
 * nothing, and the caller decides what that means for its status.
 */
export async function readProviderJson(res: Response): Promise<unknown> {
	try {
		return JSON.parse((await res.text()).slice(0, PROVIDER_ERROR_MAX_BODY_CHARS)) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * The provider's own words, made safe for a log line, or `undefined` when there
 * are none. Only the provider's STRING fields are used, and:
 *  - control characters become spaces BEFORE truncation, so the message cannot
 *    forge a log line;
 *  - each redaction (the recipient, the key) is replaced case-insensitively, in
 *    case the provider quotes it back in any case;
 *  - the result is bounded to {@link PROVIDER_ERROR_MAX_CHARS}.
 * Not redacted: an address that is not the recipient. Resend's testing-mode
 * refusal quotes the ACCOUNT OWNER's address — the operator's own, not a
 * customer's.
 */
export function sanitizeProviderDetail(
	parts: readonly unknown[],
	redactions: readonly Redaction[],
): string | undefined {
	const strings = parts.filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	if (strings.length === 0) return undefined;
	let detail = strings.join(": ").replace(CONTROL_CHARS, " ");
	for (const { value, as } of redactions) {
		if (value.length > 0) detail = detail.replace(new RegExp(escapeRegExp(value), "giu"), as);
	}
	return detail.length > PROVIDER_ERROR_MAX_CHARS
		? `${detail.slice(0, PROVIDER_ERROR_MAX_CHARS)}…`
		: detail;
}

/** `value` as a literal inside a RegExp — an address's `.` and `+` are
 *  metacharacters. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Logged ONCE per isolate, like `in-process-commerce-client.ts`'s notices: a
 * misconfiguration is a fact about the deployment, and a line per send (every
 * login request, every outbox row) would bury everything else.
 */
const loggedOnce = new Set<string>();

/** Clears the once-per-isolate latch. TESTS ONLY: without it, a case asserting
 *  "no warning" passes vacuously whenever an earlier case already logged. */
export function resetEmailWarningsForTesting(): void {
	loggedOnce.clear();
}

export function warnOnce(key: string, message: string): void {
	if (loggedOnce.has(key)) return;
	loggedOnce.add(key);
	console.warn(message);
}
