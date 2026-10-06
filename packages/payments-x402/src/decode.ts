import {
	currency,
	type X402DecodeResult,
	type X402DecodedPayment,
	type X402MalformedDetail,
	type X402OpaquePayload,
} from "@otta-sh/domain";
import { EVM_ADDRESS } from "./address.js";
import { atomicToCents } from "./amount.js";

/**
 * The strict `PAYMENT-SIGNATURE` decoder (ADR-0028 Decision 5, step 1).
 *
 * Cheapest check first, and every refusal is `MALFORMED` with a detail naming
 * the rule — never any of the header's text, which is attacker-controlled and
 * carries a signature that must not reach a log line.
 *
 * WHAT IS ACCEPTED: x402 v2 (`x402Version === 2`), `exact` on an EVM network,
 * with an EIP-3009 `authorization`. Permit2 and ERC-7710 payloads (exact-EVM §2,
 * §3) are refused here, before the structural match: USDC supports EIP-3009,
 * which the scheme recommends, and a second transfer method would be a second
 * set of money rules to get right.
 */

/** 16 KiB of base64 (Decision 5, step 1). */
export const MAX_HEADER_LENGTH = 16 * 1024;

/** Standard base64 (the reference client's `btoa`), padding optional. The
 *  base64url alphabet is refused rather than guessed at. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const NONCE = /^0x[0-9a-fA-F]{64}$/u;
/** Decimal digits only, at most uint256's 78 (the value is bounded below). */
const UNIX_SECONDS = /^[0-9]{1,78}$/u;
/** EIP-3009's `validAfter` / `validBefore` are uint256. */
const UINT256_MAX = 2n ** 256n - 1n;
/** A CAIP-2 `eip155` network; the chain id becomes part of the payment key. */
const EIP155_NETWORK = /^eip155:([1-9][0-9]{0,31})$/u;
/**
 * Even-length hex, at least 65 bytes (an ECDSA signature), at most 6 KiB. The
 * upper bound leaves room for ERC-1271 smart-wallet and ERC-6492 wrapped
 * signatures, which carry deployment data; in practice the 16 KiB header bound
 * is reached first.
 */
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){65,6144}$/u;

/** Payload keys that belong to the other exact-EVM transfer methods. */
const FOREIGN_TRANSFER_KEYS = [
	"permit2Authorization",
	"delegationManager",
	"permissionContext",
	"delegator",
] as const;

/** The validated wire payment, kept by the adapter behind the opaque token. */
export interface ParsedPayment {
	readonly accepted: {
		readonly scheme: string;
		readonly network: string;
		readonly amount: string;
		readonly asset: string;
		readonly payTo: string;
		readonly maxTimeoutSeconds: number;
		/** `undefined` when the payload carried no `extra`. Its members are
		 *  unchecked here: the structural match compares them to our offer. */
		readonly extra: Readonly<Record<string, unknown>> | undefined;
	};
	readonly signature: string;
	readonly authorization: {
		readonly from: string;
		readonly to: string;
		readonly value: string;
		readonly validAfter: string;
		readonly validBefore: string;
		readonly nonce: string;
	};
}

/**
 * The decoded payments this module minted, keyed by the FROZEN PAYMENT OBJECT
 * `decode` returned — not by its payload token. A spread copy keeps the token
 * but is a different object, so a copy whose public fields were edited (another
 * network, another amount) is not a key here and is refused before any call. The
 * domain can neither read the payload nor build a payment `verify` or `settle`
 * would send.
 */
const parsedByPayment = new WeakMap<X402DecodedPayment, ParsedPayment>();

export function parsedPaymentOf(payment: X402DecodedPayment): ParsedPayment | undefined {
	if (typeof payment !== "object" || payment === null) return undefined;
	return parsedByPayment.get(payment);
}

const USD = currency("USD");

function malformed(detail: X402MalformedDetail): X402DecodeResult {
	return { ok: false, reason: "MALFORMED", detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base64 → UTF-8 text, or `undefined` on any decoding failure. */
function base64ToText(header: string): string | undefined {
	if (!BASE64.test(header)) return undefined;
	try {
		const binary = atob(header);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		// `ignoreBOM: true` keeps a leading BOM in the text, where JSON.parse then
		// refuses it, rather than silently dropping bytes the client sent.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

export function decodePaymentHeader(header: string): X402DecodeResult {
	if (header.length > MAX_HEADER_LENGTH) return malformed("too_large");
	const text = base64ToText(header);
	if (text === undefined) return malformed("encoding");

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return malformed("json");
	}
	if (!isRecord(json)) return malformed("shape");
	// v1 (`X-PAYMENT`, `x402Version: 1`) lands here too: v1 is not spoken.
	if (json.x402Version !== 2) return malformed("version");

	const { accepted, payload } = json;
	if (!isRecord(accepted) || !isRecord(payload)) return malformed("shape");

	// EIP-3009 only, decided before the authorization's shape so a Permit2 or
	// ERC-7710 payload is named for what it is rather than as "no authorization".
	if (FOREIGN_TRANSFER_KEYS.some((key) => Object.hasOwn(payload, key))) {
		return malformed("transfer_method");
	}
	const { extra } = accepted;
	if (extra !== undefined && !isRecord(extra)) return malformed("shape");
	if (extra !== undefined && extra.assetTransferMethod !== undefined) {
		if (extra.assetTransferMethod !== "eip3009") return malformed("transfer_method");
	}

	const { scheme, network, amount, asset, payTo, maxTimeoutSeconds } = accepted;
	if (typeof scheme !== "string" || typeof network !== "string" || typeof amount !== "string") {
		return malformed("shape");
	}
	if (
		typeof maxTimeoutSeconds !== "number" ||
		!Number.isSafeInteger(maxTimeoutSeconds) ||
		maxTimeoutSeconds <= 0
	) {
		return malformed("shape");
	}
	const chain = EIP155_NETWORK.exec(network);
	if (chain === null) return malformed("network");
	const chainId = chain[1] ?? "";

	const { authorization, signature } = payload;
	if (!isRecord(authorization)) return malformed("shape");
	const { from, to, value, validAfter, validBefore, nonce } = authorization;
	if (!isAddress(asset) || !isAddress(payTo) || !isAddress(from) || !isAddress(to)) {
		return malformed("address");
	}
	if (typeof nonce !== "string" || !NONCE.test(nonce)) return malformed("nonce");
	if (!isUint256(validAfter)) return malformed("valid_after");
	if (!isUint256(validBefore)) return malformed("valid_before");
	// Decision 3's grammar, divisibility and safe-integer bound in one place. The
	// signed `value` is what settles; an `accepted.amount` that says otherwise
	// makes the payment's amount ambiguous, so it is refused too.
	const cents = atomicToCents(value);
	if (cents === undefined || typeof value !== "string" || amount !== value) {
		return malformed("value");
	}
	if (typeof signature !== "string" || !SIGNATURE.test(signature)) return malformed("signature");

	const parsed: ParsedPayment = {
		accepted: {
			scheme,
			network,
			amount,
			asset,
			payTo,
			maxTimeoutSeconds,
			extra: extra === undefined ? undefined : Object.freeze({ ...extra }),
		},
		signature,
		authorization: { from, to, value, validAfter, validBefore, nonce },
	};
	// The opaque token carries nothing: the port requires a payload field the
	// domain cannot read, and an empty frozen object is exactly that. What the
	// adapter reads back is keyed by the payment object itself.
	const token = Object.freeze({}) as X402OpaquePayload;
	const payment: X402DecodedPayment = Object.freeze({
		paymentKey: `eip3009:${chainId}:${asset}:${from}:${nonce}`.toLowerCase(),
		network,
		payer: from.toLowerCase(),
		nonce: nonce.toLowerCase(),
		amount: cents,
		currency: USD,
		validAfter: BigInt(validAfter),
		validBefore: BigInt(validBefore),
		payload: token,
	});
	parsedByPayment.set(payment, parsed);
	return { ok: true, payment };
}

function isUint256(value: unknown): value is string {
	return typeof value === "string" && UNIX_SECONDS.test(value) && BigInt(value) <= UINT256_MAX;
}

/**
 * An x402 header value (`PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`): JSON, UTF-8,
 * then standard base64 with padding — the reference client's `safeBase64Encode`
 * (`typescript/packages/core/src/utils/index.ts:148`), and the exact inverse of
 * what {@link decodePaymentHeader} accepts.
 */
export function encodeX402Header(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function isAddress(value: unknown): value is string {
	return typeof value === "string" && EVM_ADDRESS.test(value);
}

/**
 * The `paymentPayload` sent to the facilitator: rebuilt from the validated
 * fields only, so nothing the decoder did not check — `resource`, `extensions`,
 * or any extra key a client added — is forwarded. The signed values travel
 * byte for byte as the client sent them.
 */
export function wirePaymentPayload(parsed: ParsedPayment): Record<string, unknown> {
	const { accepted } = parsed;
	const extra = accepted.extra;
	return {
		x402Version: 2,
		accepted: {
			scheme: accepted.scheme,
			network: accepted.network,
			amount: accepted.amount,
			asset: accepted.asset,
			payTo: accepted.payTo,
			maxTimeoutSeconds: accepted.maxTimeoutSeconds,
			...(extra === undefined
				? {}
				: {
						extra: Object.fromEntries(
							(["name", "version", "assetTransferMethod"] as const)
								.filter((key) => typeof extra[key] === "string")
								.map((key) => [key, extra[key]]),
						),
					}),
		},
		payload: {
			signature: parsed.signature,
			authorization: { ...parsed.authorization },
		},
	};
}
