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
	isCutShortEmailTimeout,
	isEmailSendTimeoutError,
	recordedEmailTaxTotalsDisplay,
	renderEmail,
	taxTotalsDisplayOf,
	TRANSPORT_UNAVAILABLE_RETRY_MS,
	type EmailSender,
	type SendEmailInput,
	type TaxTotalsDisplay,
} from "@urumi.ai/otta-domain";
import { EmdashSettingsStore, systemClock } from "@urumi.ai/otta-store-emdash";
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

/** The reads an ORDER-email sender makes at most: the store name and the sign-in
 *  page (for the storefront origin) from kv when {@link makeEmailSender} builds
 *  it, and the tax options' "Display tax totals" from the settings document
 *  (issue #422) — read lazily, on the first send of an order that recorded no
 *  display of its own (#494, #502), and then at most once per sender. The
 *  sign-in sender never makes the last. The cron's query budget counts all
 *  three, as a ceiling. */
export const EMAIL_SENDER_BUILD_READS = 3;

/** The kv write a delivered send adds after the host call when it is the
 *  sender's first, or the first since a recorded failure: the "last sent" record
 *  ({@link markEmailSent}). A failed ORDER-email send writes the "last failure"
 *  record instead ({@link markEmailSendFailed}) on the same terms, so one send
 *  writes at most one of the two. The cron's query budget counts it,
 *  like {@link EMAIL_SENDER_BUILD_READS}. */
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
	/** The store's "Display tax totals" (issue #422): `itemized` lists an order's
	 *  tax rows. Absent ⇒ the single Tax row. An order's own recorded display
	 *  (#478) wins over it. */
	taxTotalsDisplay?: TaxTotalsDisplay | undefined;
	/** Reads the store's "Display tax totals" when {@link taxTotalsDisplay} is not
	 *  given — only for an email whose order recorded no display (#502), and at
	 *  most once per sender. Must not reject (fail-soft). */
	readTaxTotalsDisplay?: (() => Promise<TaxTotalsDisplay | undefined>) | undefined;
	/** Asked once the email is rendered — after any lazy settings read — just
	 *  before `ctx.email.send`. `false` ⇒ the send is NOT started: a CUT-SHORT
	 *  timeout, which {@link countTimeoutsAsAttempts} lets through uncounted (the
	 *  inline path's `MIN_INLINE_SEND_MS` floor, r3 S2 / #502). */
	canStart?: (() => boolean) | undefined;
	/** Told when the host answered "no email provider" — {@link makeEmailSender}
	 *  records it ({@link markEmailTransportUnavailable}). */
	onUnavailable?: (() => Promise<void>) | undefined;
	/** Told when the host ACCEPTED a send — {@link makeEmailSender} records it
	 *  ({@link markEmailSent}). Started, not awaited. */
	onSent?: (() => Promise<void>) | undefined;
	/** Told when the host's provider FAILED a send — it threw, or did not answer
	 *  in time (issue #677). Not for "no provider" or a cut-short send, which
	 *  spend no attempt. Gets a short reason with no recipient address
	 *  ({@link sendFailureReason}). {@link makeEmailSender} records it
	 *  ({@link markEmailSendFailed}). Started, not awaited; once per change of
	 *  outcome. */
	onFailed?: ((reason: string) => Promise<void>) | undefined;
}

/** Renders with the storefront's money, the store name and the order link, and
 *  sends through `ctx.email`. */
export class CtxEmailSender implements EmailSender {
	readonly #email: EmailAccess;
	readonly #timeoutMs: number | (() => number);
	readonly #storeName: string | undefined;
	readonly #storefrontOrigin: string | undefined;
	readonly #taxTotalsDisplay: TaxTotalsDisplay | undefined;
	readonly #readTaxTotalsDisplay: (() => Promise<TaxTotalsDisplay | undefined>) | undefined;
	#liveTaxTotalsDisplay: Promise<TaxTotalsDisplay | undefined> | undefined;
	readonly #canStart: (() => boolean) | undefined;
	readonly #onUnavailable: (() => Promise<void>) | undefined;
	readonly #onSent: (() => Promise<void>) | undefined;
	readonly #onFailed: ((reason: string) => Promise<void>) | undefined;
	/** The outcome this sender last recorded, so a provider costs one kv write
	 *  per CHANGE of outcome, never one per email (issue #677). */
	#recorded: "sent" | "failed" | undefined;

	constructor(options: CtxEmailSenderOptions) {
		this.#onUnavailable = options.onUnavailable;
		this.#onSent = options.onSent;
		this.#onFailed = options.onFailed;
		this.#email = options.email;
		this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
		this.#storeName = options.storeName;
		this.#storefrontOrigin = options.storefrontOrigin;
		this.#taxTotalsDisplay = options.taxTotalsDisplay;
		this.#readTaxTotalsDisplay = options.readTaxTotalsDisplay;
		this.#canStart = options.canStart;
	}

	/** The live option for this email: needed only when its order recorded no
	 *  display (#494) — then read once per sender, shared by every send. */
	async #taxTotalsDisplayFor(input: SendEmailInput): Promise<TaxTotalsDisplay | undefined> {
		if (this.#taxTotalsDisplay !== undefined || this.#readTaxTotalsDisplay === undefined) {
			return this.#taxTotalsDisplay;
		}
		if (
			input.template === "customer-login-link" ||
			recordedEmailTaxTotalsDisplay(input.data) !== undefined
		) {
			return undefined;
		}
		// Fail-soft even if a reader rejects: the single Tax row, never a failed
		// send, and never a rejected promise shared by every later send.
		this.#liveTaxTotalsDisplay ??= this.#readTaxTotalsDisplay().catch(() => undefined);
		return this.#liveTaxTotalsDisplay;
	}

	async send(input: SendEmailInput): Promise<void> {
		const orderId = input.data["orderId"];
		const rendered = renderEmail(input.template, input.data, {
			formatMoney: storefrontEmailMoney,
			locale: STOREFRONT_LOCALE,
			storeName: this.#storeName,
			taxTotalsDisplay: await this.#taxTotalsDisplayFor(input),
			orderPageUrl:
				input.template !== "customer-login-link" &&
				typeof orderId === "string" &&
				orderId.length > 0 &&
				this.#storefrontOrigin !== undefined
					? orderPageUrl(this.#storefrontOrigin, orderId)
					: undefined,
		});
		// Nothing has been handed to the host yet: too little time left to start
		// is the caller's own limit, handed back uncounted.
		if (this.#canStart !== undefined && !this.#canStart()) {
			throw new EmailSendTimeoutError(0, { cutShort: true });
		}
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
			if (isEmailNotConfiguredError(err)) {
				await this.#onUnavailable?.();
				throw new EmailTransportUnavailableError();
			}
			this.#recordFailure(err, input.to);
			throw err;
		} finally {
			clearTimeout(timer);
		}
		// Only a send the host answered in time: proof a provider is working. NOT
		// awaited: the email has gone, so a slow or hung kv write must never turn it
		// into a timeout (a counted attempt, a duplicate). Started here, so a query
		// budget counts it with this send; fail-soft, so nothing is left to reject.
		// A timestamp, not a log: once per change of outcome. After a recorded
		// failure a delivery is recorded again, so Settings stops showing the
		// failure (issue #677).
		if (this.#recorded !== "sent") {
			this.#recorded = "sent";
			void this.#onSent?.().catch(() => undefined);
		}
	}

	/** A provider failure, for the Settings line (issue #677). Like the "last
	 *  sent" record: not awaited, fail-soft, and once per change of outcome, so a
	 *  failing provider costs one kv write per tick or request, not one per
	 *  email, and a failure after a delivery in the same tick is still seen. One
	 *  send writes at most one record, so {@link EMAIL_SENT_RECORD_WRITES} holds. */
	#recordFailure(err: unknown, to: string): void {
		if (this.#onFailed === undefined || this.#recorded === "failed") return;
		// Nothing here may replace the send's own error, which the caller
		// rethrows next: an error whose `message` getter throws, or a record that
		// fails, is dropped.
		try {
			const pending = this.#onFailed(sendFailureReason(err, to));
			// Only once it was handed over: a reporter that throws at once leaves
			// the next failure free to try again.
			this.#recorded = "failed";
			void pending.catch(() => undefined);
		} catch {
			// Fail-soft: the next failed send records it.
		}
	}
}

/** The longest reason {@link sendFailureReason} returns, so the Settings line
 *  stays inside its 200-character budget. */
export const SEND_FAILURE_REASON_MAX = 80;

/** How much of a provider's message {@link sendFailureReason} looks at. Cut
 *  BEFORE any pattern runs, so a long minified, base64 or HTML body costs a
 *  bounded amount of synchronous work (#677 review). */
const SEND_FAILURE_INPUT_MAX = 1024;

/** A timeout: the provider may well have delivered it (the race only stops
 *  waiting), and the ceiling may be the tick's own remaining time, so the words
 *  blame nobody. */
export const SEND_TIMEOUT_REASON = "timed out (may have been delivered)";

/** The value after a credential-like word: `key=…`, `Authorization: …`. */
const SECRET_AFTER_NAME =
	/\b((?:[a-z_-]{0,20}(?:key|token|secret|signature|password|passwd|pwd))|auth[a-z_-]{0,20})(\s{0,3}[:=]\s{0,3})["']?[^\s"',;&]{1,256}/gi;
/** The credential after an HTTP auth scheme: `Bearer …`, `Basic …`. */
const SECRET_AFTER_SCHEME = /\b(bearer|basic)\s{1,3}[^\s"',;&]{1,256}/gi;
/** A URL with a scheme. */
const URL_WITH_SCHEME = /\b[a-z][a-z0-9+.-]{0,31}:\/\/\S{0,2048}/gi;
/** A URL without one: `host.tld/path?query`. */
const URL_WITHOUT_SCHEME = /\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8}\/\S{0,2048}/gi;
/** An address with a quoted local part: `"Jane Doe"@example.com`. */
const QUOTED_ADDRESS = /"[^"\r\n]{1,64}"@[^\s"'<>()[\],;:@]{1,255}/g;
/** Anything address-shaped. */
const ADDRESS = /[^\s"'<>()[\],;:@]{1,64}@[^\s"'<>()[\],;:@]{1,255}/g;
/** A run that may be a token: 16+ characters of the base64/identifier set. */
const TOKEN_RUN = /[A-Za-z0-9_\-+/=]{16,}/g;
/** A provider's error code: words joined by `_`, `.` or `-`, no digits. */
const ERROR_CODE = /^[A-Za-z]+(?:[_.-][A-Za-z]+)+$/;

/** Whether a {@link TOKEN_RUN} match is redacted: any run mixing letters and
 *  digits (a key, a hex request id), any run of digits, and a digit-free run of
 *  32+ that is not an error code (`E_SENDER_DOMAIN_NOT_VERIFIED` stays). */
function isSecretRun(run: string): boolean {
	const digits = /[0-9]/.test(run);
	if (digits) return true;
	if (ERROR_CODE.test(run)) return false;
	return run.length >= 32;
}

/** One RFC 2047 encoded word, matched whole (`=?utf-8?q?…?=`): its text is kept,
 *  its wrapper dropped. A lone `?=` (a URL's query) is left alone. */
const ENCODED_WORD = /=\?[^?\s]{1,40}\?[qb]\?([^?\s]{0,200})\?=/gi;
/** `%40` / `=40` between an address's local part and a domain. */
const ENCODED_AT = /(?<=[A-Za-z0-9._%+-])(?:%40|=40)(?=[A-Za-z0-9-]{1,63}\.[A-Za-z])/gi;
/** `(at)`, `[at]`, `{at}` between an address's local part and a domain. */
const SPELLED_AT =
	/(?<=[A-Za-z0-9._%+-])\s{0,3}[([{]\s{0,3}at\s{0,3}[)\]}]\s{0,3}(?=[A-Za-z0-9-]{1,63}\.[A-Za-z])/gi;

/** Every common spelling of `@` a provider or mail header may use. The ones
 *  that are also ordinary text (`=40`, `%40`, `(at)`) only between address-like
 *  text, so "limit=400" and "failed (at) 10:00" stay as they are. */
function normalizeAt(text: string): string {
	return text
		.replace(ENCODED_WORD, " $1 ")
		.replace(/&#0*64;|&#x0*40;|&commat;|[\uFF20\uFE6B]/gi, "@")
		.replace(ENCODED_AT, "@")
		.replace(SPELLED_AT, "@");
}

/** Characters that may sit inside an address's local part. */
const LOCAL_PART_CHAR = "A-Za-z0-9._%+-";

/** The recipient's local part as a whole token, when it looks like an
 *  identifier rather than a word (a `.`, `_`, `+`, `-` or digit, or 6+
 *  characters): `jane.doe` is redacted, but `not`, `info` or `user` never turn
 *  "domain not verified" into nonsense (#677 review). */
function redactLocalPart(text: string, local: string): string {
	if (!/[._+\-0-9]/.test(local) && local.length < 6) return text;
	const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(
		new RegExp(`(?<![${LOCAL_PART_CHAR}])${escaped}(?![${LOCAL_PART_CHAR}])`, "gi"),
		"[address]",
	);
}

/** `needle` replaced in `text` regardless of case, as a literal. */
function replaceLiteral(text: string, needle: string, replacement: string): string {
	if (needle === "") return text;
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(escaped, "gi"), replacement);
}

/** The error's message, or "" — never throws, and never more than is needed. */
function messageOf(err: unknown): string {
	try {
		if (typeof err === "string") return err.slice(0, SEND_FAILURE_INPUT_MAX * 2);
		if (typeof err === "object" && err !== null) {
			const message = (err as { message?: unknown }).message;
			if (typeof message === "string") return message.slice(0, SEND_FAILURE_INPUT_MAX * 2);
		}
	} catch {
		// A throwing getter: no reason.
	}
	return "";
}

/**
 * A short reason for a failed send, safe to store and show to the merchant
 * (issue #677). A provider's error may quote the recipient, a URL or a key, so
 * only its first {@link SEND_FAILURE_INPUT_MAX} characters are read (cut back to
 * a space), and then:
 *  - every spelling of `@` (`&#64;`, `&commat;`, fullwidth; and `%40`, `=40`,
 *    `(at)` between address-like text) becomes `@`, and a whole RFC 2047
 *    encoded word is unwrapped;
 *  - the recipient (any case) becomes `[address]`, and so does its local part
 *    as a whole token when it looks like an identifier; so does anything
 *    address-shaped, a quoted local part included;
 *  - the value after a credential word (`key=`, `Authorization:`, `Bearer`)
 *    becomes `[redacted]`, URLs with or without a scheme become `[url]`, and
 *    token-like runs ({@link isSecretRun}: 16+ with a digit, or 32+ that is not
 *    an error code) become `[redacted]` — so a long hex request id is too;
 *  - control characters and runs of spaces collapse, trailing punctuation goes,
 *    and the result is cut to {@link SEND_FAILURE_REASON_MAX}.
 * Every pattern is bounded, so the work is linear in that capped input. A
 * timeout is {@link SEND_TIMEOUT_REASON}; no message is "no reason given".
 */
export function sendFailureReason(err: unknown, to: string): string {
	if (isEmailSendTimeoutError(err)) return SEND_TIMEOUT_REASON;
	let reason = messageOf(err);
	if (reason.length > SEND_FAILURE_INPUT_MAX) {
		const cut = reason.slice(0, SEND_FAILURE_INPUT_MAX);
		const space = cut.search(/\s\S*$/);
		reason = space > 0 ? cut.slice(0, space) : cut;
	}
	// Control characters (CR/LF included) become spaces.
	reason = Array.from(reason, (c) => {
		const code = c.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f ? " " : c;
	}).join("");
	reason = normalizeAt(reason);
	const recipient = to.slice(0, 320);
	reason = replaceLiteral(reason, recipient, "[address]");
	const at = recipient.lastIndexOf("@");
	const local = at > 0 ? recipient.slice(0, at) : "";
	if (local.length >= 3) reason = redactLocalPart(reason, local);
	reason = reason
		.replace(SECRET_AFTER_SCHEME, "$1 [redacted]")
		.replace(SECRET_AFTER_NAME, "$1$2[redacted]")
		.replace(URL_WITH_SCHEME, "[url]")
		.replace(QUOTED_ADDRESS, "[address]")
		.replace(ADDRESS, "[address]")
		.replace(URL_WITHOUT_SCHEME, "[url]")
		.replace(TOKEN_RUN, (run) => (isSecretRun(run) ? "[redacted]" : run))
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\s.,;:!]+$/, "");
	if (reason === "") return "no reason given";
	return reason.length <= SEND_FAILURE_REASON_MAX
		? reason
		: `${reason
				.slice(0, SEND_FAILURE_REASON_MAX - 1)
				.trimEnd()
				.replace(/[\s.,;:!]+$/, "")}…`;
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
	// An odd error object (a throwing getter) is simply not this one (#677 review):
	// the send's own error must reach the caller unchanged.
	try {
		const { name, message } = err as { name?: unknown; message?: unknown };
		if (name === "EmailNotConfiguredError") return true;
		return (
			message === EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE ||
			message === EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE
		);
	} catch {
		return false;
	}
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
 * EmDash's email provider" once it is newer than any "no provider" answer. Plain kv, written fail-soft by the
 * first delivered send of each sender, and again after one of its recorded
 * failures — at most once per change of outcome ({@link EMAIL_SENT_RECORD_WRITES}).
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
 * The last FAILED send through the host's provider (issue #677): a JSON object
 * `{ at, reason }` — an ISO time and {@link sendFailureReason}'s short reason,
 * never the recipient. A provider that fails after a success (a daily quota, a
 * sender domain gone inactive) would otherwise still read "sent via EmDash's
 * email provider". Plain kv, written fail-soft by an order-email sender's first
 * failed send, and again after one of its recorded deliveries
 * ({@link EMAIL_SENT_RECORD_WRITES}). One small object, overwritten: bounded.
 */
export const EMAIL_LAST_FAILURE_KEY = "state:emailLastFailure";

/** A recorded failed send: when, and why in a few words. */
export interface EmailSendFailure {
	at: string;
	reason: string;
}

/** Record a failed send, now. Never throws. */
export async function markEmailSendFailed(
	ctx: PluginContext,
	reason: string,
	nowMs: number = Date.now(),
): Promise<void> {
	try {
		const failure: EmailSendFailure = { at: new Date(nowMs).toISOString(), reason };
		await ctx.kv.set(EMAIL_LAST_FAILURE_KEY, failure);
	} catch {
		// Fail-soft: the next failed send records it again.
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
	return (await emailSendingReport(ctx, nowMs)).status;
}

/** {@link emailSendingStatus}, and the last failed send when nothing has gone
 *  through the provider since it (issue #677). */
export interface EmailSendingReport {
	status: EmailSendingStatus;
	/** Absent when `unavailable`, when none is recorded, or when a send has
	 *  gone through since. */
	lastFailure?: EmailSendFailure;
}

/**
 * {@link emailSendingStatus} plus the last failed send ({@link EMAIL_LAST_FAILURE_KEY}),
 * kept only while it is the latest word: a send accepted after it hides it.
 * Three kv reads when `ctx.email` is there, none when it is not. Fail-soft: an
 * unreadable or malformed failure record reads as absent.
 */
export async function emailSendingReport(
	ctx: PluginContext,
	nowMs: number = Date.now(),
): Promise<EmailSendingReport> {
	if (!emailSendingConfigured(ctx)) return { status: "unavailable" };
	const [unavailableAt, lastSentAt, lastFailure] = await Promise.all([
		readIsoMs(ctx, EMAIL_TRANSPORT_UNAVAILABLE_KEY),
		readIsoMs(ctx, EMAIL_LAST_SENT_KEY),
		readLastFailure(ctx),
	]);
	if (
		unavailableAt !== undefined &&
		unavailableAt <= nowMs &&
		nowMs - unavailableAt < TRANSPORT_UNAVAILABLE_RETRY_MS
	) {
		return { status: "unavailable" };
	}
	const status: EmailSendingStatus =
		lastSentAt === undefined
			? "unconfirmed"
			: unavailableAt === undefined || lastSentAt >= unavailableAt
				? "confirmed"
				: "unconfirmed";
	const current =
		lastFailure !== undefined &&
		(lastSentAt === undefined || Date.parse(lastFailure.at) > lastSentAt);
	return current ? { status, lastFailure } : { status };
}

/** The failure record, or `undefined` when missing, malformed or unreadable. */
async function readLastFailure(ctx: PluginContext): Promise<EmailSendFailure | undefined> {
	let value: unknown;
	try {
		value = await ctx.kv.get<unknown>(EMAIL_LAST_FAILURE_KEY);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { at, reason } = value as { at?: unknown; reason?: unknown };
	if (typeof at !== "string" || typeof reason !== "string") return undefined;
	const ms = Date.parse(at);
	if (!Number.isFinite(ms)) return undefined;
	return { at: new Date(ms).toISOString(), reason: reason.slice(0, SEND_FAILURE_REASON_MAX) };
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
	options: {
		requestTimeoutMs?: number | (() => number);
		/** Read "Display tax totals" for order emails (default). The sign-in email
		 *  has no totals, so its sender skips the read under its short ceiling. */
		orderTotals?: boolean;
		/** {@link CtxEmailSenderOptions.canStart}. */
		canStart?: () => boolean;
		/** Record a provider failure for Settings (default). Off for the sign-in
		 *  email, whose failures spend no order-email attempt (issue #677). */
		recordFailures?: boolean;
	} = {},
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
		// Lazy (#502): most orders record their own display (#494), so the
		// settings read happens only for an older order that recorded none.
		...(options.orderTotals === false
			? {}
			: { readTaxTotalsDisplay: () => emailTaxTotalsDisplay(ctx) }),
		onUnavailable: () => markEmailTransportUnavailable(ctx),
		onSent: () => markEmailSent(ctx),
		// Issue #677: only a COUNTED failure — an order email's. A sign-in email
		// has no outbox row, and its short ceiling times out a provider that is
		// merely slow; neither may read as a spent order-email attempt.
		...(options.recordFailures === false
			? {}
			: { onFailed: (reason: string) => markEmailSendFailed(ctx, reason) }),
		...(options.requestTimeoutMs !== undefined
			? { requestTimeoutMs: options.requestTimeoutMs }
			: {}),
		...(options.canStart !== undefined ? { canStart: options.canStart } : {}),
	});
}

/**
 * The store's "Display tax totals" for the order emails (issue #422), as the
 * order pages read it (`taxTotalsDisplayOf`). FAIL-SOFT, like the store name: a
 * context without the document store, or a read that fails, keeps the single Tax
 * row — the total is right either way, and an email must not fail over a
 * display preference.
 */
async function emailTaxTotalsDisplay(ctx: PluginContext): Promise<TaxTotalsDisplay> {
	if (ctx.storage === undefined) return "single";
	try {
		const settings = await new EmdashSettingsStore({
			storage: ctx.storage,
			clock: systemClock,
		}).get();
		return taxTotalsDisplayOf(settings.tax);
	} catch {
		return "single";
	}
}

/** {@link makeEmailSender} with the login ceiling — and `undefined` while the
 *  host is known to have no provider ({@link emailSendingAvailable}), so a sign-in
 *  request then mints no challenge and spends no throttle slot. (No outbox row
 *  behind it, so nothing to count: a failed or timed-out sign-in email is logged.) */
export async function makeLoginEmailSender(ctx: PluginContext): Promise<EmailSender | undefined> {
	if (!(await emailSendingAvailable(ctx))) return undefined;
	return makeEmailSender(ctx, {
		requestTimeoutMs: LOGIN_EMAIL_TIMEOUT_MS,
		orderTotals: false,
		recordFailures: false,
	});
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
 *
 * Except a CUT-SHORT timeout ({@link isCutShortEmailTimeout}): only thrown before
 * the host call starts (`canStart`, #502), so nothing can have gone out — it
 * passes through and the dispatcher hands the row back uncounted.
 */
export function countTimeoutsAsAttempts(sender: EmailSender): EmailSender {
	return {
		async send(input) {
			try {
				await sender.send(input);
			} catch (err) {
				// A cut-short timeout was thrown before anything reached the host
				// (`canStart`): nothing can have been delivered, so it stays uncounted.
				if (!isEmailSendTimeoutError(err) || isCutShortEmailTimeout(err)) throw err;
				throw new Error(
					`email send timed out${err.timeoutMs === undefined ? "" : ` after ${String(err.timeoutMs)} ms`}; counted as an attempt (the email may have been delivered)`,
					{ cause: err },
				);
			}
		},
	};
}
