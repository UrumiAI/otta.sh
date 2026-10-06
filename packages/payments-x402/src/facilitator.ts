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

export type FacilitatorFetch = (url: string, init: RequestInit) => Promise<Response>;

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

/** `undefined` for "too large", otherwise the bytes read. */
async function readBounded(response: Response): Promise<Uint8Array | undefined> {
	const declared = response.headers.get("content-length");
	if (declared !== null && /^[0-9]+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
		void response.body?.cancel().catch(() => {});
		return undefined;
	}
	if (response.body === null) return new Uint8Array(0);
	const reader = response.body.getReader();
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
 * race of its own as well as an abort signal, so a `fetch` that ignores its
 * signal still cannot hold the caller past the bound.
 *
 * A final response whose `url` is not the URL requested was redirected. The
 * platform's fetch follows redirects itself (EmDash's `ctx.http` re-checks each
 * hop against `allowedHosts`; the test sandbox's does not), so a redirected
 * answer is never trusted as a verdict. `redirect: "manual"` is asked for as
 * well; where it is honoured, a 3xx comes back and is unavailable by status.
 */
export async function postToFacilitator(
	fetchFn: FacilitatorFetch,
	url: string,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number,
): Promise<Exchange> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Exchange>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve({ ok: false, cause: "timeout" });
		}, timeoutMs);
	});

	const work = (async (): Promise<Exchange> => {
		let response: Response;
		try {
			response = await fetchFn(url, {
				method: "POST",
				headers,
				body,
				redirect: "manual",
				signal: controller.signal,
			});
		} catch {
			return { ok: false, cause: controller.signal.aborted ? "timeout" : "transport" };
		}
		if (response.url !== url) {
			void response.body?.cancel().catch(() => {});
			return { ok: false, cause: "redirect" };
		}
		if (isUnavailableStatus(response.status)) {
			void response.body?.cancel().catch(() => {});
			return { ok: false, cause: "status" };
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await readBounded(response);
		} catch {
			return { ok: false, cause: controller.signal.aborted ? "timeout" : "transport" };
		}
		if (bytes === undefined) return { ok: false, cause: "oversize" };
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
