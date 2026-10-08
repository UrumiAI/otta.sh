/**
 * The plugin's one `EmailSender`: render the template, hand the message to the
 * EmDash host's `ctx.email` (ADR-0031).
 *
 * EmDash owns email providers. The host runs the `email:beforeSend` hooks, then
 * the ONE `email:deliver` provider the site selected (Cloudflare Email, a
 * site's own provider plugin, the dev console). Otta ships no provider, holds
 * no email credential and grants no email host: from-address, SPF and DKIM are
 * the provider's.
 *
 * NO PROVIDER IS FAIL-CLOSED, two ways, because the host reports it two ways:
 *  - trusted mode: `ctx.email` is absent. {@link makeEmailSender} returns
 *    `undefined`, so the cron leg reports `skipped` and the inline send reports
 *    `configured: false` — nothing is claimed.
 *  - sandboxed: `ctx.email` is always there once the capability is declared, and
 *    `send` rejects ("Email is not configured…"). That becomes
 *    `EmailTransportUnavailableError`, which the outbox dispatcher answers by
 *    releasing the row uncounted, backed off.
 *
 * AT-LEAST-ONCE, BOUNDED. `ctx.email` takes no idempotency key, so a retried
 * send cannot be deduped by the provider. A timeout may have been delivered, so
 * every caller wraps its sender OUTERMOST in {@link countTimeoutsAsAttempts}:
 * duplicates stop at the row's `maxAttempts`.
 *
 * SILENT CANCELLATION. An `email:beforeSend` hook may cancel a send; the host
 * then resolves as if it went. The row is marked sent — the site chose that.
 */
import {
	EmailSendTimeoutError,
	EmailTransportUnavailableError,
	isEmailSendTimeoutError,
	renderEmail,
	TRANSPORT_UNAVAILABLE_RETRY_MS,
	type EmailSender,
	type SendEmailInput,
} from "@otta-sh/domain";
import { resolveLoginLinkUrl } from "../storefront/login-link.js";
import { STOREFRONT_LOCALE } from "../storefront/route-input.js";
import type { EmailAccess, PluginContext } from "../types.js";
import {
	orderPageUrl,
	STORE_DISPLAY_NAME_KEY,
	storefrontEmailMoney,
	storefrontOriginOf,
	storeNameFrom,
} from "./email-render-context.js";

/** The fallback ceiling on one send, for a caller that sets none. The cron
 *  sweep and the inline paths pass their own, far shorter ones. */
export const DEFAULT_EMAIL_TIMEOUT_MS = 30_000;

/**
 * The ceiling on the LOGIN email's send (issue #306 review). It is awaited
 * inline on the login-request route, and a THROTTLED request skips the send, so
 * a slow provider must not make a sent request much slower than a throttled one
 * (ADR-0004's 2026-09-29 amendment). A timeout is logged and the request still
 * answers the same generic success.
 */
export const LOGIN_EMAIL_TIMEOUT_MS = 3_000;

/** The kv reads {@link makeEmailSender} makes: the store name and the sign-in
 *  page (for the storefront origin). The cron's query budget counts them. */
export const EMAIL_SENDER_BUILD_READS = 2;

/** The kv write the FIRST delivered send of a sender adds after the host call:
 *  the "last sent" record ({@link markEmailSent}). The cron's query budget counts
 *  it, like {@link EMAIL_SENDER_BUILD_READS}. */
export const EMAIL_SENT_RECORD_WRITES = 1;

export interface CtxEmailSenderOptions {
	/** The host's email access — `ctx.email`. */
	email: EmailAccess;
	/** Per-send ceiling. A FUNCTION is asked at each send, so the sweep can cap a
	 *  send at what is left of its tick. Default {@link DEFAULT_EMAIL_TIMEOUT_MS}. */
	requestTimeoutMs?: number | (() => number) | undefined;
	/** The store's name ("Store display name"), for the sign-in email. */
	storeName?: string | undefined;
	/** The storefront's public origin, for the order page link. Absent ⇒ order
	 *  emails carry no link. */
	storefrontOrigin?: string | undefined;
	/** Told when the host answered "no email provider" — {@link makeEmailSender}
	 *  records it ({@link markEmailTransportUnavailable}). */
	onUnavailable?: (() => Promise<void>) | undefined;
	/** Told when the host ACCEPTED a send — {@link makeEmailSender} records it
	 *  ({@link markEmailSent}). Started, not awaited. */
	onSent?: (() => Promise<void>) | undefined;
}

/** Renders with the storefront's money, the store name and the order link, and
 *  sends through `ctx.email`. */
export class CtxEmailSender implements EmailSender {
	readonly #email: EmailAccess;
	readonly #timeoutMs: number | (() => number);
	readonly #storeName: string | undefined;
	readonly #storefrontOrigin: string | undefined;
	readonly #onUnavailable: (() => Promise<void>) | undefined;
	readonly #onSent: (() => Promise<void>) | undefined;
	#sentRecorded = false;

	constructor(options: CtxEmailSenderOptions) {
		this.#onUnavailable = options.onUnavailable;
		this.#onSent = options.onSent;
		this.#email = options.email;
		this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
		this.#storeName = options.storeName;
		this.#storefrontOrigin = options.storefrontOrigin;
	}

	async send(input: SendEmailInput): Promise<void> {
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
		const timeoutMs = typeof this.#timeoutMs === "function" ? this.#timeoutMs() : this.#timeoutMs;
		// `ctx.email.send` takes no abort signal, so the send is RACED: a hung
		// provider must never hold a cron tick or a request open. The loser keeps
		// running unobserved; its rejection is swallowed here.
		const sending = this.#email.send({
			to: input.to,
			subject: rendered.subject,
			text: rendered.text,
			html: rendered.html,
		});
		sending.catch(() => undefined);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new EmailSendTimeoutError(timeoutMs)), timeoutMs);
		});
		try {
			await Promise.race([sending, timeout]);
		} catch (err) {
			if (isEmailSendTimeoutError(err)) throw err;
			if (isEmailNotConfiguredError(err)) {
				await this.#onUnavailable?.();
				throw new EmailTransportUnavailableError();
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
		// Only a send the host answered in time: proof a provider is working. NOT
		// awaited: the email has gone, so a slow or hung kv write must never turn it
		// into a timeout (a counted attempt, a duplicate). Started here, so a query
		// budget counts it with this send; fail-soft, so nothing is left to reject.
		// Once per sender (one per tick or request): a timestamp, not a log.
		if (!this.#sentRecorded) {
			this.#sentRecorded = true;
			void this.#onSent?.().catch(() => undefined);
		}
	}
}

/** EmDash's sandbox bridge's refusal when no provider is wired (emdash 0.38
 *  `@emdash-cms/cloudflare` `bridge.ts` `emailSend`; unchanged in 1.0.1). Pinned
 *  against EmDash's REAL bridge, over the real RPC, by
 *  `emdash-sandbox-rpc.sandbox.test.ts`. */
export const EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE =
	"Email is not configured. No email provider is available.";

/** EmDash's pipeline `EmailNotConfiguredError` message (emdash 0.38
 *  `src/plugins/email.ts`; unchanged in 1.0.1). Pinned against the installed
 *  package's source by `ctx-email-sender.test.ts`. */
export const EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE =
	"No email provider is configured. Install and activate an email provider plugin, then select it in Settings > Email.";

/**
 * Whether `ctx.email.send` rejected because the HOST has no provider selected.
 *
 * EXACT, never a substring (security review F1): a provider's own error is free
 * to quote the recipient, and a buyer chooses the recipient, so any loose match
 * would let a buyer-chosen address ("email is not configured@…") switch off a
 * store's email. Only the host's own error counts: the pipeline's error name, or
 * a message EQUAL to one of EmDash's two exact texts. A bridge rebuilds a plain
 * `Error`, so the message is what crosses; both texts are pinned against EmDash
 * itself (see the constants above).
 */
export function isEmailNotConfiguredError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const { name, message } = err as { name?: unknown; message?: unknown };
	if (name === "EmailNotConfiguredError") return true;
	return (
		message === EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE ||
		message === EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE
	);
}

/** Whether this context can send at all — the trusted-mode answer. A sandboxed
 *  context says yes and learns otherwise from a send ({@link emailSendingAvailable}). */
export function emailSendingConfigured(ctx: PluginContext): boolean {
	return ctx.email !== undefined;
}

/**
 * When the host last answered "no email provider" (readable kv, an ISO time).
 *
 * A sandboxed host always hands over `ctx.email`, so the only way to learn there
 * is no provider is a send. Recording the answer lets every caller stop BEFORE it
 * claims an outbox row or mints a sign-in challenge, for
 * {@link TRANSPORT_UNAVAILABLE_RETRY_MS}; after that one send tries again. Not a
 * secret, and not a setting: plain kv, written fail-soft.
 */
export const EMAIL_TRANSPORT_UNAVAILABLE_KEY = "state:emailTransportUnavailableAt";

/** Record that the host has no email provider, now. Never throws. */
export async function markEmailTransportUnavailable(
	ctx: PluginContext,
	nowMs: number = Date.now(),
): Promise<void> {
	try {
		await ctx.kv.set(EMAIL_TRANSPORT_UNAVAILABLE_KEY, new Date(nowMs).toISOString());
	} catch {
		// Fail-soft: the next send learns it again.
	}
}

/**
 * Whether a send should be TRIED: the host hands over `ctx.email`, and has not
 * said "no email provider" in the last {@link TRANSPORT_UNAVAILABLE_RETRY_MS}. One
 * kv read when `ctx.email` is there; none when it is not. Fail-soft: an unreadable
 * record reads as "try".
 */
export async function emailSendingAvailable(
	ctx: PluginContext,
	nowMs: number = Date.now(),
): Promise<boolean> {
	if (!emailSendingConfigured(ctx)) return false;
	let at: unknown;
	try {
		at = await ctx.kv.get<unknown>(EMAIL_TRANSPORT_UNAVAILABLE_KEY);
	} catch {
		return true;
	}
	if (typeof at !== "string") return true;
	const atMs = Date.parse(at);
	return !(Number.isFinite(atMs) && nowMs - atMs < TRANSPORT_UNAVAILABLE_RETRY_MS && atMs <= nowMs);
}

/** The kv reads {@link emailSendingAvailable} makes when `ctx.email` is there. */
export const EMAIL_AVAILABILITY_READS = 1;

/**
 * When the host last ACCEPTED a send (readable kv, an ISO time) — PR #418 review.
 *
 * A sandboxed host always hands over `ctx.email`, and the "no provider" record
 * ({@link EMAIL_TRANSPORT_UNAVAILABLE_KEY}) lapses after 5 minutes, so neither
 * says a provider WORKS. This does: the Settings line only says "sent via
 * EmDash's email provider" once it is newer than any "no provider" answer, and
 * the legacy-credential purge waits for it. Plain kv, written fail-soft by the
 * first delivered send of each sender — once per tick or request
 * ({@link EMAIL_SENT_RECORD_WRITES}).
 */
export const EMAIL_LAST_SENT_KEY = "state:emailLastSentAt";

/** Record that the host accepted a send, now. Never throws. */
export async function markEmailSent(ctx: PluginContext, nowMs: number = Date.now()): Promise<void> {
	try {
		await ctx.kv.set(EMAIL_LAST_SENT_KEY, new Date(nowMs).toISOString());
	} catch {
		// Fail-soft: the email went; only the confirmation waits for the next send.
	}
}

/**
 * What is known about the host's email provider:
 *  - `unavailable` — none: `ctx.email` is absent, or the host said "no provider"
 *    in the last {@link TRANSPORT_UNAVAILABLE_RETRY_MS};
 *  - `unconfirmed` — `ctx.email` is there, but no send has gone through it since
 *    the last "no provider" answer (or ever). A sandboxed host with no provider
 *    looks exactly like this until a send is refused;
 *  - `confirmed` — the host accepted a send, more recently than any "no provider".
 *
 * Two kv reads when `ctx.email` is there, none when it is not. Fail-soft: an
 * unreadable record reads as absent, so the answer errs toward `unconfirmed`.
 */
export type EmailSendingStatus = "unavailable" | "unconfirmed" | "confirmed";

export async function emailSendingStatus(
	ctx: PluginContext,
	nowMs: number = Date.now(),
): Promise<EmailSendingStatus> {
	if (!emailSendingConfigured(ctx)) return "unavailable";
	const [unavailableAt, lastSentAt] = await Promise.all([
		readIsoMs(ctx, EMAIL_TRANSPORT_UNAVAILABLE_KEY),
		readIsoMs(ctx, EMAIL_LAST_SENT_KEY),
	]);
	if (
		unavailableAt !== undefined &&
		unavailableAt <= nowMs &&
		nowMs - unavailableAt < TRANSPORT_UNAVAILABLE_RETRY_MS
	) {
		return "unavailable";
	}
	if (lastSentAt === undefined) return "unconfirmed";
	return unavailableAt === undefined || lastSentAt >= unavailableAt ? "confirmed" : "unconfirmed";
}

/** A kv ISO time as epoch ms; `undefined` when missing, malformed or unreadable. */
async function readIsoMs(ctx: PluginContext, key: string): Promise<number | undefined> {
	let at: unknown;
	try {
		at = await ctx.kv.get<unknown>(key);
	} catch {
		return undefined;
	}
	if (typeof at !== "string") return undefined;
	const ms = Date.parse(at);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Build the sender for a context, or `undefined` when the host has no email
 * provider (`ctx.email` absent). Reads the store name (falling back to the
 * EmDash site name) and the sign-in page (fail-soft: unreadable ⇒ no name, no
 * order link).
 */
export async function makeEmailSender(
	ctx: PluginContext,
	options: { requestTimeoutMs?: number | (() => number) } = {},
): Promise<EmailSender | undefined> {
	const email = ctx.email;
	if (email === undefined) return undefined;
	const [storeName, signInPageUrl] = await Promise.all([
		ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY).then(storeNameFrom, () => undefined),
		resolveLoginLinkUrl(ctx),
	]);
	return new CtxEmailSender({
		email,
		// "Store display name", else the EmDash site's own name — the fallback the
		// From line's display name used to give (QA2 U-3).
		storeName: storeName ?? storeNameFrom(ctx.site?.name),
		storefrontOrigin: storefrontOriginOf(signInPageUrl),
		onUnavailable: () => markEmailTransportUnavailable(ctx),
		onSent: () => markEmailSent(ctx),
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
	});
}

/** {@link makeEmailSender} with the login ceiling — and `undefined` while the
 *  host is known to have no provider ({@link emailSendingAvailable}), so a sign-in
 *  request then mints no challenge and spends no throttle slot. (No outbox row
 *  behind it, so nothing to count: a failed or timed-out sign-in email is logged.) */
export async function makeLoginEmailSender(ctx: PluginContext): Promise<EmailSender | undefined> {
	if (!(await emailSendingAvailable(ctx))) return undefined;
	return makeEmailSender(ctx, { requestTimeoutMs: LOGIN_EMAIL_TIMEOUT_MS });
}

/**
 * A TIMEOUT becomes a COUNTED failure.
 *
 * The dispatcher hands a timed-out row back uncounted on the premise that a
 * retry is deduped by the provider. `ctx.email` has no idempotency key, so that
 * premise is false: a provider that is slow but accepting would be sent the
 * same email on every retry, without bound. Re-thrown as a plain error, the
 * timeout is counted and rescheduled like any failure, so duplicates stop at
 * the row's `maxAttempts`. Wrap OUTERMOST, around any wrapper that makes its
 * own timeouts (the sweep's timer).
 */
export function countTimeoutsAsAttempts(sender: EmailSender): EmailSender {
	return {
		async send(input) {
			try {
				await sender.send(input);
			} catch (err) {
				if (!isEmailSendTimeoutError(err)) throw err;
				throw new Error(
					`email send timed out${err.timeoutMs === undefined ? "" : ` after ${String(err.timeoutMs)} ms`}; counted as an attempt (the email may have been delivered)`,
					{ cause: err },
				);
			}
		},
	};
}
