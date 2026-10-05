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
 * exhaustively. Another provider gets its own sender on the shared
 * `HttpEmailSender` base (`http-email-sender.ts`) — SMTP2GO's is
 * `smtp2go-email-sender.ts` — and `makeEmailSender` below picks one from the
 * store's "Email provider" setting (`email-provider.ts`).
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
 * {@link CtxHttpEmailSender.checkResponse}.
 */
import type { EmailSender } from "@otta-sh/domain";
import { EMAIL_API_KEY_KEY, readWriteOnlySecret, SMTP2GO_API_KEY_KEY } from "../payment-secrets.js";
import { resolveLoginLinkUrl } from "../storefront/login-link.js";
import type { PluginContext } from "../types.js";
import {
	STORE_DISPLAY_NAME_KEY,
	storefrontOriginOf,
	storeNameFrom,
} from "./email-render-context.js";
import { readEmailProvider, readSmtp2goRegion, type Smtp2goRegion } from "./email-provider.js";
import { fromDisplayName, isDeliverableFromAddress } from "./from-address.js";
import {
	HttpEmailSender,
	type HttpEmailSenderOptions,
	type OutboundEmail,
	type ProviderRequest,
	readProviderJson,
	sanitizeProviderDetail,
	statusFailure,
	warnOnce,
} from "./http-email-sender.js";
import { Smtp2goEmailSender } from "./smtp2go-email-sender.js";

export { DEFAULT_EMAIL_TIMEOUT_MS, resetEmailWarningsForTesting } from "./http-email-sender.js";

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

export interface CtxHttpEmailSenderOptions extends HttpEmailSenderOptions {
	/** Transactional-email API endpoint that accepts a POST of the rendered mail
	 *  — the in-process equivalent of `EMAIL_API_URL`. */
	apiUrl: string;
}

/** Posts the rendered email, in Resend's `POST /emails` shape, to the build's
 *  `EMAIL_API_URL` over `ctx.http`. Rendering, the timeout and error
 *  sanitizing are {@link HttpEmailSender}'s. */
export class CtxHttpEmailSender extends HttpEmailSender {
	readonly #apiUrl: string;

	constructor(options: CtxHttpEmailSenderOptions) {
		super(options);
		this.#apiUrl = options.apiUrl;
	}

	protected buildRequest(message: OutboundEmail): ProviderRequest {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			// The outbox row id. See this module's head comment — removing this line
			// is a silent duplicate-email bug, not a cleanup.
			"Idempotency-Key": message.ottaId,
		};
		if (this.apiKey !== undefined) headers["authorization"] = `Bearer ${this.apiKey}`;
		return {
			url: this.#apiUrl,
			headers,
			body: JSON.stringify({
				from: message.from,
				to: message.to,
				subject: message.subject,
				text: message.text,
				html: message.html,
				// NOT a top-level `template`: Resend reads that as a hosted-template
				// object and refuses it beside `html`. See this module's head comment.
				tags: [{ name: "template", value: message.template }],
			}),
		};
	}

	/**
	 * A non-2xx THROWS, naming WHY.
	 *
	 * A BARE STATUS IS UNDIAGNOSABLE. The reasons a real provider refuses are
	 * specific and operator-fixable — an unverified sending domain, a revoked key,
	 * a sandbox account sending to someone other than its owner — and Resend says
	 * which in `{ statusCode, name, message }`. The login route logs this error's
	 * message; without the detail its log says only "403". Only the provider's
	 * own `name` and `message` strings are used, sanitized by
	 * `sanitizeProviderDetail`; a non-JSON body — an HTML gateway page, an empty
	 * body — contributes NOTHING, since there is no telling what an
	 * intermediary's page echoes. A 2xx body is not read.
	 */
	protected async checkResponse(res: Response, message: OutboundEmail): Promise<void> {
		if (res.ok) return;
		const parsed = await readProviderJson(res);
		const { name, message: text } =
			typeof parsed === "object" && parsed !== null
				? (parsed as { name?: unknown; message?: unknown })
				: {};
		throw statusFailure(res.status, sanitizeProviderDetail([name, text], this.redactions(message)));
	}
}

/** The deployment-supplied half of the wiring — the build-time email URL, the
 *  same value `ALLOWED_HOSTS` derived the granted host from. Passed in rather
 *  than read here so the whole thing stays testable without a bundler. */
export interface EmailSenderEgress {
	apiUrl?: string | undefined;
}

/**
 * The provider a store sends through, resolved ONCE and handed on: which one,
 * and what that provider needs to be usable. `undefined` ⇒ this store cannot
 * send, and nothing should be claimed.
 *  - `resend`: the build's email URL (the key stays optional, as it always was:
 *    a keyless relay or local mail catcher still works).
 *  - `smtp2go`: SMTP2GO's OWN key slot must hold a key; the region is read only
 *    here, only for SMTP2GO.
 * Unset provider ⇒ Resend. A provider read that FAILS, or an unknown stored
 * value, ⇒ `undefined`: never a guess that would hand the wrong provider a key.
 * Cost: one kv read for Resend, three for SMTP2GO
 * ({@link EMAIL_TRANSPORT_RESOLVE_READS}).
 */
export type EmailTransport =
	| { provider: "resend"; apiUrl: string }
	| { provider: "smtp2go"; apiKey: string; region: Smtp2goRegion };

/** The most kv reads {@link resolveEmailTransport} makes. */
export const EMAIL_TRANSPORT_RESOLVE_READS = 3;

export async function resolveEmailTransport(
	ctx: PluginContext,
	egress: EmailSenderEgress,
): Promise<EmailTransport | undefined> {
	const provider = await readEmailProvider(ctx);
	if (provider === undefined) return undefined;
	if (provider === "resend") {
		return egress.apiUrl !== undefined && emailSenderConfigured(egress)
			? { provider, apiUrl: egress.apiUrl }
			: undefined;
	}
	const [apiKey, region] = await Promise.all([
		readWriteOnlySecret(ctx, SMTP2GO_API_KEY_KEY),
		readSmtp2goRegion(ctx),
	]);
	return apiKey === undefined ? undefined : { provider, apiKey, region };
}

/** The most kv reads {@link makeEmailSender} makes when handed a resolved
 *  transport: Resend's key, the from-address, the store name and the sign-in
 *  page (SMTP2GO's key came with the transport, so it makes one fewer). */
export const EMAIL_SENDER_BUILD_READS = 4;

/**
 * Build the sender for a context, or `undefined` when there is none to build.
 *
 * THE PROVIDER SETTING PICKS IT ({@link resolveEmailTransport}): `smtp2go`
 * builds an {@link Smtp2goEmailSender} with SMTP2GO's own key on the saved
 * region; `resend` — the default, so a store that never chose keeps today's
 * behaviour — builds the {@link CtxHttpEmailSender} on the build's email URL
 * with Resend's key. Each reads ONLY its own key slot, so no provider is ever
 * sent another's key. A caller that has already resolved the transport (the
 * cron leg, the inline send) passes it, so the choice is not read twice.
 *
 * FAIL-CLOSED, and `undefined` rather than a console-logging stand-in: the
 * service could fall back to `ConsoleEmailSender` because a Node process has a
 * console an operator reads. In the plugin the honest report is "no sender",
 * which is what makes the cron sweep's `order-emails` leg report `skipped`
 * instead of draining the outbox into nowhere.
 *
 * The other kv reads are fail-soft (`readWriteOnlySecret` and
 * `resolveLoginLinkUrl` swallow a rejection): a Resend store whose key read
 * fails sends unauthenticated against the documented default from-address, with
 * no store name and no order link, rather than take down the tick.
 */
export async function makeEmailSender(
	ctx: PluginContext,
	egress: EmailSenderEgress,
	options: { requestTimeoutMs?: number | (() => number); transport?: EmailTransport } = {},
): Promise<EmailSender | undefined> {
	const transport = options.transport ?? (await resolveEmailTransport(ctx, egress));
	if (transport === undefined) return undefined;
	const [resendKey, from, storeName, signInPageUrl] = await Promise.all([
		transport.provider === "resend"
			? readWriteOnlySecret(ctx, EMAIL_API_KEY_KEY)
			: Promise.resolve(undefined),
		readEmailFrom(ctx),
		ctx.kv.get<string>(STORE_DISPLAY_NAME_KEY).then(storeNameFrom, () => undefined),
		// Already fail-soft: unset, invalid or unreadable ⇒ undefined ⇒ no link.
		resolveLoginLinkUrl(ctx),
	]);
	const common: HttpEmailSenderOptions = {
		fetch: ctx.http.fetch,
		from,
		// "Store display name", else the From address's own display name (QA2
		// U-3): an unset field left the sign-in email nameless though its From
		// line named the store.
		storeName: storeName ?? fromDisplayName(from),
		storefrontOrigin: storefrontOriginOf(signInPageUrl),
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
	};
	if (transport.provider === "smtp2go") {
		return new Smtp2goEmailSender({
			...common,
			apiKey: transport.apiKey,
			region: transport.region,
		});
	}
	return new CtxHttpEmailSender({
		...common,
		apiUrl: transport.apiUrl,
		...(resendKey !== undefined ? { apiKey: resendKey } : {}),
	});
}

/**
 * Whether this bundle has a build-time email URL — the Resend-shaped sender's
 * precondition, with no kv read. NOT the whole answer to "can this store send":
 * callers deciding whether to claim outbox rows use
 * {@link resolveEmailTransport} / {@link emailSendingConfigured}.
 */
export function emailSenderConfigured(egress: EmailSenderEgress): boolean {
	return egress.apiUrl !== undefined && egress.apiUrl.length > 0;
}

/** Whether {@link makeEmailSender} would build a sender for this context. */
export async function emailSendingConfigured(
	ctx: PluginContext,
	egress: EmailSenderEgress,
): Promise<boolean> {
	return (await resolveEmailTransport(ctx, egress)) !== undefined;
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
 * never an empty string a provider would reject as a malformed sender. The
 * default is never used silently: the isolate logs once that no from-address is
 * saved. (A kv read that FAILS falls back quietly: that is an outage, not a
 * setting to fix, and the send's own failure says more.)
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
	if (typeof value !== "string" || value.length === 0) {
		// Nothing saved: the default goes out, and a real provider refuses it — say
		// so once, rather than fall back silently (issue #364).
		warnOnce(
			"email-from-default",
			`[otta] settings:emailFrom is not set; sending from ${DEFAULT_EMAIL_FROM}, which real email providers refuse — set a from-address in the plugin's Settings`,
		);
		return DEFAULT_EMAIL_FROM;
	}
	if (!isDeliverableFromAddress(value)) {
		warnOnce(
			"email-from-undeliverable",
			"[otta] settings:emailFrom is not a deliverable address; sends will be refused",
		);
	}
	return value;
}
