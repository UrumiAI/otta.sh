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
 * `IN_PROCESS_EGRESS_URLS.emailApiUrl`. Same headers, same rendering (moved
 * verbatim to `@otta-sh/domain`, where its suite still pins every template).
 *
 * THE BODY IS RESEND'S `POST /emails`, EXACTLY (2026-10-02; DEPLOYMENT.md
 * "Email provider"). Bearer auth, `Idempotency-Key`, a string `to`, `from`,
 * `subject`, `text`, `html` — all as Resend defines them. The ONE change from
 * the service-era body: the template name used to ride as a top-level
 * `template` string, and Resend defines `template` as an OBJECT (`{ id,
 * variables }`, a provider-hosted template) that cannot be combined with
 * `html`/`text` — so every send would have been refused. The name now travels as a Resend
 * tag, `{ name: "template", value }`, which keeps it visible in the provider's
 * dashboard and logs without changing what is sent. Every `EmailTemplate` name
 * fits the tag charset (ASCII letters, digits, `_`, `-`); the suite pins that
 * exhaustively. Another provider needs its own adapter behind the
 * `EmailSender` port — this file does not pretend to be generic.
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
 * for a message the provider refused. The error names WHY — see
 * {@link describeProviderError}.
 */
import {
	EmailSendTimeoutError,
	renderEmail,
	type EmailSender,
	type SendEmailInput,
} from "@otta-sh/domain";
import { EMAIL_API_KEY_KEY, readWriteOnlySecret } from "../payment-secrets.js";
import { resolveLoginLinkUrl } from "../storefront/login-link.js";
import { STOREFRONT_LOCALE } from "../storefront/route-input.js";
import type { PluginContext } from "../types.js";
import {
	orderPageUrl,
	STORE_DISPLAY_NAME_KEY,
	storefrontEmailMoney,
	storefrontOriginOf,
	storeNameFrom,
} from "./email-render-context.js";
import { fromDisplayName, isDeliverableFromAddress } from "./from-address.js";

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
	/** The store's name ("Store display name"), for the sign-in email. */
	storeName?: string | undefined;
	/** The storefront's public origin (`storefrontOriginOf`), for the order page
	 *  link in order emails. Absent ⇒ order emails carry no link. */
	storefrontOrigin?: string | undefined;
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
	readonly #storeName: string | undefined;
	readonly #storefrontOrigin: string | undefined;

	constructor(options: CtxHttpEmailSenderOptions) {
		this.#fetch = options.fetch;
		this.#apiUrl = options.apiUrl;
		this.#from = options.from;
		this.#apiKey = options.apiKey;
		this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
		this.#storeName = options.storeName;
		this.#storefrontOrigin = options.storefrontOrigin;
	}

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
				// NOT a top-level `template`: Resend reads that as a hosted-template
				// object and refuses it beside `html`. See this module's head comment.
				tags: [{ name: "template", value: input.template }],
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
			const detail = await describeProviderError(res, input.to);
			throw new Error(
				`email transport failed with status ${res.status}${detail === undefined ? "" : `: ${detail}`}`,
			);
		}
	}
}

/** The ceiling on how much of a provider's error message reaches a log line. */
const PROVIDER_ERROR_MAX_CHARS = 200;

/** The error body is parsed from at most its first this-many characters.
 *  Resend's error object is well under 1 KiB; anything past this is not one,
 *  and the error path must not parse megabytes an intermediary chose to send.
 *  (The body is still read whole — `ctx.http.fetch` offers no bounded read —
 *  and the request's abort signal bounds how long that read can take.) */
const PROVIDER_ERROR_MAX_BODY_CHARS = 4096;

/** C0 and C1 controls, DEL, and the Unicode line/paragraph separators — what a
 *  provider message must not smuggle into a log line (a CR/LF, NEL or U+2028
 *  there forges a second, fake log entry in a viewer that breaks on it). */
// oxlint-disable-next-line no-control-regex -- matching control characters IS the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/**
 * WHY the provider refused, as `name: message`, or `undefined` when the body
 * does not say in a shape we trust.
 *
 * A BARE STATUS IS UNDIAGNOSABLE. The reasons a real provider refuses are
 * specific and operator-fixable — an unverified sending domain, a revoked key,
 * a sandbox account sending to someone other than its owner — and Resend says
 * which in `{ statusCode, name, message }`. The login route logs this error's
 * message; without the detail its log says only "403".
 *
 * WHAT IS NEVER IN IT: anything of the REQUEST. The body carries the sign-in
 * link (a live token) and the headers carry the API key, and neither is read
 * here. Only the provider's own `name` and `message` strings are used, and:
 *  - the body is parsed from at most its first
 *    {@link PROVIDER_ERROR_MAX_BODY_CHARS} characters — a longer body fails to
 *    parse and contributes nothing;
 *  - control characters become spaces BEFORE truncation, so the message cannot
 *    forge a log line;
 *  - the recipient is redacted case-insensitively, in case the provider quotes
 *    it back in any case;
 *  - the result is bounded to {@link PROVIDER_ERROR_MAX_CHARS}.
 * Not redacted: an address that is not the recipient. Resend's testing-mode
 * refusal quotes the ACCOUNT OWNER's address, which can therefore appear in the
 * login route's log — the operator's own address, not a customer's.
 *
 * A non-JSON body — an HTML gateway page, an empty body — contributes NOTHING:
 * there is no telling what an intermediary's page echoes. Never throws: a body
 * that cannot be read is the same as one that says nothing.
 */
async function describeProviderError(
	res: Response,
	recipient: string,
): Promise<string | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse((await res.text()).slice(0, PROVIDER_ERROR_MAX_BODY_CHARS));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { name, message } = parsed as { name?: unknown; message?: unknown };
	const parts = [name, message].filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	if (parts.length === 0) return undefined;
	const joined = parts.join(": ").replace(CONTROL_CHARS, " ");
	const detail =
		recipient.length > 0
			? joined.replace(new RegExp(escapeRegExp(recipient), "giu"), "<recipient>")
			: joined;
	return detail.length > PROVIDER_ERROR_MAX_CHARS
		? `${detail.slice(0, PROVIDER_ERROR_MAX_CHARS)}…`
		: detail;
}

/** `value` as a literal inside a RegExp — an address's `.` and `+` are
 *  metacharacters. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
 * Every kv read is fail-soft (`readWriteOnlySecret` and `resolveLoginLinkUrl`
 * already swallow a rejection to `undefined`): a kv outage must degrade to an
 * unauthenticated send against the documented default from-address — with no
 * store name and no order link — never take down the tick that was about to
 * drain the outbox.
 */
export async function makeEmailSender(
	ctx: PluginContext,
	egress: EmailSenderEgress,
	options: { requestTimeoutMs?: number | (() => number) } = {},
): Promise<EmailSender | undefined> {
	const apiUrl = egress.apiUrl;
	if (apiUrl === undefined || !emailSenderConfigured(egress)) return undefined;
	const [apiKey, from, storeName, signInPageUrl] = await Promise.all([
		readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY),
		readEmailFrom(ctx),
		ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY).then(storeNameFrom, () => undefined),
		// Already fail-soft: unset, invalid or unreadable ⇒ undefined ⇒ no link.
		resolveLoginLinkUrl(ctx),
	]);
	return new CtxHttpEmailSender({
		fetch: ctx.http.fetch,
		apiUrl,
		from,
		// "Store display name", else the From address's own display name (QA2
		// U-3): an unset field left the sign-in email nameless though its From
		// line named the store.
		storeName: storeName ?? fromDisplayName(from),
		storefrontOrigin: storefrontOriginOf(signInPageUrl),
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

/**
 * The configured from-address, or the documented default — never a throw and
 * never an empty string a provider would reject as a malformed sender.
 *
 * A STORED UNDELIVERABLE ADDRESS IS USED, AND LOGGED — NEVER SILENTLY REPLACED.
 * One saved before the Settings save refused reserved domains (or written to kv
 * by anything but the form) would have every send refused by a real provider.
 * Swapping in the default would not help — it is undeliverable too — and would
 * hide which setting is wrong; so the value goes out as stored and the isolate
 * logs, once, which setting to fix. The message names the key, never the value.
 */
async function readEmailFrom(ctx: PluginContext): Promise<string> {
	let value: unknown;
	try {
		value = await ctx.kv.get<string>(EMAIL_FROM_KEY);
	} catch {
		return DEFAULT_EMAIL_FROM;
	}
	if (typeof value !== "string" || value.length === 0) return DEFAULT_EMAIL_FROM;
	if (!isDeliverableFromAddress(value)) {
		warnOnce(
			"email-from-undeliverable",
			"[otta] settings:emailFrom is not a deliverable address; sends will be refused",
		);
	}
	return value;
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

function warnOnce(key: string, message: string): void {
	if (loggedOnce.has(key)) return;
	loggedOnce.add(key);
	console.warn(message);
}
