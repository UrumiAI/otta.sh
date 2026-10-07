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
}

/** Renders with the storefront's money, the store name and the order link, and
 *  sends through `ctx.email`. */
export class CtxEmailSender implements EmailSender {
	readonly #email: EmailAccess;
	readonly #timeoutMs: number | (() => number);
	readonly #storeName: string | undefined;
	readonly #storefrontOrigin: string | undefined;

	constructor(options: CtxEmailSenderOptions) {
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
			if (isEmailNotConfiguredError(err)) throw new EmailTransportUnavailableError();
			throw err;
		} finally {
			clearTimeout(timer);
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
 *  context says yes and learns otherwise from the first send. */
export function emailSendingConfigured(ctx: PluginContext): boolean {
	return ctx.email !== undefined;
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
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
	});
}

/** {@link makeEmailSender} with the login ceiling. (No outbox row behind it, so
 *  nothing to count: a failed or timed-out sign-in email is logged.) */
export function makeLoginEmailSender(ctx: PluginContext): Promise<EmailSender | undefined> {
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
