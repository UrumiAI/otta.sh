import type {
	X402PaymentRequirements,
	X402SettleResult,
	X402UnavailableCause,
	X402VerifyResult,
} from "@otta-sh/domain";
import { sameAddress } from "./address.js";
import type { ParsedPayment } from "./decode.js";

/**
 * The facilitator client and its answer classification (ADR-0028 Decision 8).
 *
 * ONE RULE ABOVE THE OTHERS: "could not ask" is never reported as "the answer
 * was no". A transport error, a timeout, a redirect, an auth or rate-limit
 * status, a 5xx, an oversize or unparseable body — each is `unavailable` for
 * `/verify` and `unconfirmed` for `/settle`, never `invalid` or `rejected`. Only
 * an exact, well-formed answer is a verdict, and only a well-formed success that
 * passes every check is `settled`.
 *
 * NOTHING IS LOGGED, AND NOTHING FROM OUTSIDE IS PASSED ON VERBATIM. No line here
 * writes to the console. An error thrown by `fetch` is swallowed whole — its
 * message may quote the request, `Authorization` header included. The only
 * facilitator-supplied strings a result carries are a reason that is a plain
 * token and does not contain the credential, and a transaction hash that matched
 * the 32-byte hex grammar.
 */

/** `/verify` checks a signature and a balance (Decision 8). */
export const VERIFY_TIMEOUT_MS = 10_000;
/** `/settle` waits for inclusion on-chain (Decision 8). */
export const SETTLE_TIMEOUT_MS = 30_000;
/** Response bodies are read up to 16 KiB (Decision 8). */
export const MAX_RESPONSE_BYTES = 16 * 1024;

const TRANSACTION = /^0x[0-9a-fA-F]{64}$/u;
/** What a facilitator reason may look like to be passed on: the spec's and the
 *  reference's codes are all of this form. */
const REASON_TOKEN = /^[A-Za-z0-9_]{1,128}$/u;

/**
 * ADR-0028 Decision 5, step 8: the `errorReason`s that prove nothing was
 * broadcast, in both the spec's spelling (v2 §9) and the reference facilitator's
 * (`mechanisms/evm/src/exact/facilitator/errors.ts`). The reference facilitator
 * produces each of these either from the re-verify it runs BEFORE broadcasting,
 * or from its `catch`, which maps a post-broadcast error only to
 * `*_transaction_failed` — never to a reason listed here. A facilitator that
 * spells its reasons some other way simply gets more manual checks, which is the
 * safe direction.
 *
 * THE RESIDUAL ASSUMPTION, stated plainly. The catch-path reasons on this list
 * (`*_insufficient_balance`, `*_signature`, `*_valid_after`, `*_valid_before`)
 * come from `parseEip3009TransferError` matching a contract revert message. With
 * the reference signer (viem's `writeContract`), such a revert surfaces while the
 * transaction is being simulated and gas estimated — BEFORE it is broadcast —
 * because a reverted transaction is never sent. A facilitator with a custom
 * signer that broadcasts without estimating, and then maps a mined revert's
 * message to one of these reasons with `transaction: ""`, would break that. We
 * accept it: a mined revert moved no money either, and the reference
 * facilitator reports a mined failure with its hash (`eip3009.ts:306-313`).
 */
export const PRE_BROADCAST_REASONS: ReadonlySet<string> = new Set([
	// Not enough funds
	"insufficient_funds",
	"invalid_exact_evm_insufficient_balance",
	// Bad signature
	"invalid_exact_evm_payload_signature",
	"invalid_exact_evm_signature",
	// Not yet valid / expired (one spelling, shared)
	"invalid_exact_evm_payload_authorization_valid_after",
	"invalid_exact_evm_payload_authorization_valid_before",
	// Wrong amount
	"invalid_exact_evm_payload_authorization_value_mismatch",
	"invalid_exact_evm_authorization_value",
	// Wrong recipient
	"invalid_exact_evm_payload_recipient_mismatch",
	"invalid_exact_evm_recipient_mismatch",
	// Wrong network
	"invalid_network",
	"invalid_exact_evm_network_mismatch",
	// Wrong scheme
	"invalid_scheme",
	"unsupported_scheme",
	"invalid_exact_evm_scheme",
	// Bad payload or requirements
	"invalid_payload",
	"invalid_payment_requirements",
	"invalid_x402_version",
	"invalid_exact_evm_missing_eip712_domain",
	"invalid_exact_evm_token_name_mismatch",
	"invalid_exact_evm_token_version_mismatch",
	"invalid_exact_evm_eip3009_not_supported",
]);

/**
 * What the adapter needs from a fetch response — no more, because the platforms
 * differ. On EmDash 1.0.1 both host paths hand back a real `Response` rebuilt
 * from a buffered wire form (`emdash` `src/plugins/http-wire.ts`,
 * `pluginHttpResponseFromWire`): `status`, `statusText`, `headers`, a `body`
 * over bytes the host already read in full (capped at 8 MiB), and `url` /
 * `redirected` set to the final hop. That holds in-process
 * (`src/plugins/context.ts` `createHttpAccess`) and over the Cloudflare Worker
 * Loader bridge (`@emdash-cms/cloudflare@1.0.1` `src/sandbox/wrapper.ts`
 * `http.fetch`, host side `src/sandbox/bridge-http.ts` `sandboxHttpFetch`). The
 * host honours `redirect: "manual"`, and when it follows a redirect it re-checks
 * `allowedHosts` and strips `Authorization` on every cross-origin hop. EmDash
 * 0.38's bridge returned a plain `{status, ok, headers, text(), json()}` with NO
 * `url` and NO `body`, which is why both stay optional here.
 */
export interface FacilitatorResponse {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	/** The final URL, where the platform reports one. */
	readonly url?: string;
	readonly body?: ReadableStream<Uint8Array> | null;
	text(): Promise<string>;
}

/**
 * The injected egress — the plugin passes `ctx.http.fetch`. Called with a plain
 * `init` (method, headers as a plain object, a string body, `redirect`) and
 * deliberately NO `signal`: the Worker Loader bridge sends `init` to the host
 * over RPC (`bridge.httpFetch(url, init)`). On EmDash 0.38 an `AbortSignal`
 * could not be structured-cloned there, so passing one failed every call with
 * `DataCloneError`; on 1.0.1 the wrapper forwards only method, redirect,
 * headers and body (`@emdash-cms/cloudflare@1.0.1` `src/sandbox/wrapper.ts`
 * `http.fetch`), so a signal is silently dropped and the abort never reaches
 * the host fetch. Either way the adapter's own timeout race is the only bound
 * on the wait, on every platform.
 */
export type FacilitatorFetch = (url: string, init: RequestInit) => Promise<FacilitatorResponse>;

type Exchange =
	| { readonly ok: true; readonly status: number; readonly json: unknown }
	| { readonly ok: false; readonly cause: X402UnavailableCause };

/** Statuses that are never a verdict, whatever the body says: an auth or rate
 *  limit problem is ours or the facilitator's, not the payment's; a 5xx is a
 *  failure to answer (x402.org answers a malformed payload with 500 `isValid:
 *  false`); a 3xx is a redirect that was not followed. */
function isUnavailableStatus(status: number): boolean {
	return (
		status === 401 ||
		status === 403 ||
		status === 408 ||
		status === 429 ||
		status < 200 ||
		(status >= 300 && status < 400) ||
		status >= 500
	);
}

function is2xx(status: number): boolean {
	return status >= 200 && status < 300;
}

function cancelBody(response: FacilitatorResponse): void {
	const { body } = response;
	if (body !== undefined && body !== null) void body.cancel().catch(() => {});
}

/**
 * The body as text, at most {@link MAX_RESPONSE_BYTES} of UTF-8, or `"oversize"`.
 *
 * With a stream (a real `Response`) the read stops at the bound. Without one
 * (the Worker Loader bridge) `text()` is all there is: the host has already
 * buffered the whole body, so the bound on what the HOST reads is the
 * platform's, and the adapter enforces 16 KiB on what it accepts.
 */
async function readBoundedText(
	response: FacilitatorResponse,
	onReader: (cancel: () => void) => void,
): Promise<string | "oversize" | "not_utf8"> {
	const declared = response.headers.get("content-length");
	if (declared !== null && /^[0-9]+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
		cancelBody(response);
		return "oversize";
	}
	const { body } = response;
	if (body === undefined || body === null || typeof body.getReader !== "function") {
		const text = await response.text();
		if (typeof text !== "string") throw new TypeError("response text is not a string");
		if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) return "oversize";
		return text;
	}
	const bytes = await readBoundedStream(body, onReader);
	if (bytes === undefined) return "oversize";
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return "not_utf8";
	}
}

/** `undefined` for "too large", otherwise the bytes read. */
async function readBoundedStream(
	stream: ReadableStream<Uint8Array>,
	onReader: (cancel: () => void) => void,
): Promise<Uint8Array | undefined> {
	const reader = stream.getReader();
	onReader(() => void reader.cancel().catch(() => {}));
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			void reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * One POST to the facilitator, bounded in time and size.
 *
 * The timeout covers the whole exchange — the request AND the body — and is a
 * race of its own, so it holds whatever the platform does with the request (no
 * `signal` is passed: see {@link FacilitatorFetch}). Once the race is lost
 * nothing more is read: a body being read has its reader cancelled, and an
 * answer that arrives later is discarded with its body cancelled unread.
 *
 * A final response whose `url` is a non-empty string other than the URL
 * requested was redirected, and is never trusted as a verdict. Where the
 * platform reports no `url` (EmDash 0.38's Worker Loader bridge), the redirect
 * rule is the platform's own: it follows at most five hops, each re-checked
 * against `allowedHosts`, with `Authorization` stripped on a cross-origin hop.
 * A redirect can then only land on another allowlisted host (Stripe, the email
 * API), whose answer is not a well-formed verdict and so classifies as
 * unavailable. `redirect: "manual"` is asked for as well; where it is honoured
 * (EmDash 1.0.1, on both host paths), a 3xx comes back and is unavailable by
 * status.
 *
 * Nothing in here throws: any failure of the injected fetch or of the response
 * object it returns (even a fetch that resolves to `null`) is `transport`.
 */
export async function postToFacilitator(
	fetchFn: FacilitatorFetch,
	url: string,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number,
): Promise<Exchange> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	let cancelReading: (() => void) | undefined;
	const timeout = new Promise<Exchange>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			cancelReading?.();
			resolve({ ok: false, cause: "timeout" });
		}, timeoutMs);
	});

	const work = (async (): Promise<Exchange> => {
		let response: FacilitatorResponse;
		try {
			response = await fetchFn(url, { method: "POST", headers, body, redirect: "manual" });
			if (typeof response !== "object" || response === null)
				return { ok: false, cause: "transport" };
			if (timedOut) {
				// A late answer: the caller already has its timeout. Read nothing.
				cancelBody(response);
				return { ok: false, cause: "timeout" };
			}
			if (typeof response.url === "string" && response.url !== "" && response.url !== url) {
				cancelBody(response);
				return { ok: false, cause: "redirect" };
			}
			if (typeof response.status !== "number" || isUnavailableStatus(response.status)) {
				cancelBody(response);
				return { ok: false, cause: "status" };
			}
		} catch {
			return { ok: false, cause: "transport" };
		}
		let text: string;
		try {
			const read = await readBoundedText(response, (cancel) => {
				cancelReading = cancel;
			});
			if (read === "oversize") return { ok: false, cause: "oversize" };
			if (read === "not_utf8") return { ok: false, cause: "body" };
			text = read;
		} catch {
			return { ok: false, cause: "transport" };
		}
		try {
			return { ok: true, status: response.status, json: JSON.parse(text) as unknown };
		} catch {
			return { ok: false, cause: "body" };
		}
	})();
	// The loser of the race must not surface as an unhandled rejection.
	work.catch(() => {});

	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An optional field: absent (or JSON `null`) is fine; present must be a string. */
function optionalString(value: unknown): string | undefined | false {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" ? value : false;
}

/** A facilitator reason worth passing on, or `undefined`. */
function passableReason(reason: string | undefined, credential: string | undefined) {
	if (reason === undefined || !REASON_TOKEN.test(reason)) return undefined;
	if (credential !== undefined && reason.includes(credential)) return undefined;
	return reason;
}

/**
 * `/verify` (Decision 8): `valid` is exactly the v2 §5.4 shape with `isValid:
 * true` — a JSON boolean, nothing merely truthy — on a 2xx. A well-formed
 * `isValid: false` is a verdict on any status not in the unavailable set:
 * facilitators differ on the status of a rejection (the reference client also
 * reads a non-2xx body carrying `isValid` as a verdict). Unknown extra fields
 * are ignored; known ones must have their spec types.
 */
export function classifyVerify(
	exchange: Exchange,
	parsed: ParsedPayment,
	credential: string | undefined,
): X402VerifyResult {
	if (!exchange.ok) return { outcome: "unavailable", cause: exchange.cause };
	const { status, json } = exchange;
	if (!isRecord(json) || typeof json.isValid !== "boolean") {
		return { outcome: "unavailable", cause: "body" };
	}
	const invalidReason = optionalString(json.invalidReason);
	const payer = optionalString(json.payer);
	if (invalidReason === false || payer === false) return { outcome: "unavailable", cause: "body" };

	if (json.isValid) {
		// A "yes" on an error status, or about another payer, is not a "yes".
		if (!is2xx(status)) return { outcome: "unavailable", cause: "body" };
		if (payer !== undefined && !sameAddress(payer, parsed.authorization.from)) {
			return { outcome: "unavailable", cause: "body" };
		}
		return { outcome: "valid", payer: parsed.authorization.from.toLowerCase() };
	}
	return { outcome: "invalid", reason: passableReason(invalidReason, credential) };
}

/**
 * `/settle` (Decision 8 and Decision 5, step 8).
 *
 * - `settled`: a well-formed `success: true` on a 2xx, with a 32-byte
 *   `transaction`, `network` equal to ours, and `payer` and `amount`, when
 *   present, equal to `authorization.from` (20 bytes) and to our amount.
 * - `rejected`: a well-formed `success: false` whose `errorReason` is on the
 *   pre-broadcast allowlist AND whose `transaction` is `""`. Nothing else proves
 *   that nothing was broadcast — the reference facilitator answers a failed
 *   receipt wait with `invalid_exact_evm_transaction_failed` and `""` even
 *   though the transfer may still land.
 * - `unconfirmed`: everything else.
 */
export function classifySettle(
	exchange: Exchange,
	parsed: ParsedPayment,
	requirements: X402PaymentRequirements,
	credential: string | undefined,
): X402SettleResult {
	if (!exchange.ok) return { outcome: "unconfirmed", cause: exchange.cause };
	const { status, json } = exchange;
	if (
		!isRecord(json) ||
		typeof json.success !== "boolean" ||
		typeof json.transaction !== "string" ||
		typeof json.network !== "string"
	) {
		return { outcome: "unconfirmed", cause: "body" };
	}
	const errorReason = optionalString(json.errorReason);
	const payer = optionalString(json.payer);
	const amount = optionalString(json.amount);
	if (errorReason === false || payer === false || amount === false) {
		return { outcome: "unconfirmed", cause: "body" };
	}
	const transaction = TRANSACTION.test(json.transaction) ? json.transaction : undefined;

	if (json.success) {
		if (!is2xx(status)) return { outcome: "unconfirmed", cause: "body" };
		const passes =
			transaction !== undefined &&
			json.network === requirements.network &&
			(payer === undefined || sameAddress(payer, parsed.authorization.from)) &&
			(amount === undefined || amount === requirements.amount);
		if (!passes) {
			return {
				outcome: "unconfirmed",
				cause: "failed_check",
				...(transaction === undefined ? {} : { transaction }),
			};
		}
		return {
			outcome: "settled",
			transaction,
			network: requirements.network,
			payer: parsed.authorization.from.toLowerCase(),
		};
	}

	if (
		json.transaction === "" &&
		errorReason !== undefined &&
		PRE_BROADCAST_REASONS.has(errorReason)
	) {
		return { outcome: "rejected", reason: errorReason };
	}
	const reason = passableReason(errorReason, credential);
	return {
		outcome: "unconfirmed",
		cause: "unproven_rejection",
		...(reason === undefined ? {} : { reason }),
		...(transaction === undefined ? {} : { transaction }),
	};
}
