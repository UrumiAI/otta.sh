import type {
	Money,
	X402DecodedPayment,
	X402MatchResult,
	X402Offer,
	X402OfferResult,
	X402PaymentRequirements,
	X402Rail,
	X402SettleResult,
	X402VerifyResult,
} from "@otta-sh/domain";
import { projectPayTo, sameAddress } from "./address.js";
import { centsToAtomic } from "./amount.js";
import { usdcAssetFor } from "./assets.js";
import { decodePaymentHeader, parsedPaymentOf, wirePaymentPayload } from "./decode.js";
import {
	classifySettle,
	classifyVerify,
	postToFacilitator,
	SETTLE_TIMEOUT_MS,
	VERIFY_TIMEOUT_MS,
	type FacilitatorFetch,
} from "./facilitator.js";

/** Decision 5, step 4: the window the domain enforces is `now + 45 s <
 *  validBefore ≤ now + maxTimeoutSeconds + 30 s`. */
const MAX_TIMEOUT_SECONDS = 180;

export interface X402RailOptions {
	/**
	 * The facilitator's BASE URL (the build-time `X402_FACILITATOR_URL`); the
	 * adapter appends `/verify` and `/settle`, as the reference client does. An
	 * absolute `https:` URL with no query, fragment or userinfo; anything else —
	 * plain `http:` included, because the bearer key and the payment travel in
	 * it — leaves the rail unconfigured (nothing offered, nothing sent).
	 */
	facilitatorUrl: string;
	/**
	 * A static API key, sent as `Authorization: Bearer <key>`; absent or `""`
	 * sends no `Authorization` header (Decision 8). A key that cannot be a
	 * header value leaves the rail unconfigured rather than letting the platform
	 * throw an error that quotes it.
	 */
	facilitatorApiKey?: string | undefined;
	/** `settings:x402PayTo` exactly as stored: a bare address or CAIP-10. */
	payTo: string;
	/** `settings:x402Accepts`: CAIP-2 networks, each of which must be in the
	 *  asset table. */
	networks: readonly string[];
	/** The ONLY egress: the plugin passes `ctx.http.fetch`. */
	fetch: FacilitatorFetch;
}

/** Visible ASCII, no spaces: what a bearer token can be without the header
 *  value being rewritten or refused. */
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/u;

function parseBaseUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
		return undefined;
	}
	if (raw.includes("?") || raw.includes("#")) return undefined;
	return url.href.replace(/\/+$/u, "");
}

function isAbsoluteHttpUrl(value: unknown): boolean {
	if (typeof value !== "string" || value === "") return false;
	try {
		const { protocol } = new URL(value);
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}

function refuse(detail: Extract<X402OfferResult, { ok: false }>["detail"]): X402OfferResult {
	return { ok: false, reason: "NOT_OFFERED", detail };
}

function mismatch(field: Extract<X402MatchResult, { ok: false }>["field"]): X402MatchResult {
	return { ok: false, reason: "PAYMENT_MISMATCH", field };
}

/**
 * The structural match (Decision 5, step 2): what is the same for every payment
 * to us. Never the amount or the window. Pure: it needs no rail state, because
 * the offer carries everything ours.
 */
function matchOffer(payment: X402DecodedPayment, against: X402Offer): X402MatchResult {
	const parsed = parsedPaymentOf(payment);
	// Read the payment only from what was decoded, never from the decoded
	// struct's public fields, which the caller could have rebuilt.
	if (parsed === undefined) return mismatch("payload");
	const { accepted, authorization } = parsed;
	if (accepted.scheme !== "exact") return mismatch("scheme");
	const requirements = against.paymentRequired.accepts.find(
		(entry) => entry.network === accepted.network,
	);
	if (requirements === undefined) return mismatch("network");
	if (!sameAddress(accepted.asset, requirements.asset)) return mismatch("asset");
	if (!sameAddress(accepted.payTo, requirements.payTo)) return mismatch("payTo");
	if (!sameAddress(authorization.to, requirements.payTo)) return mismatch("to");
	const extra = accepted.extra;
	if (
		extra === undefined ||
		extra.name !== requirements.extra.name ||
		extra.version !== requirements.extra.version
	) {
		return mismatch("extra");
	}
	if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009") {
		return mismatch("transfer_method");
	}
	return { ok: true, requirements };
}

/**
 * The `X402Rail` adapter (ADR-0028 Decisions 2, 3, 4 and 8).
 *
 * WHAT IT TRUSTS. Its own settings and the domain's price build the offer; the
 * payment is checked against that offer before any call; the requirements sent
 * to `/verify` and `/settle` are always the offer's, never the payload's echoed
 * `accepted`. So the recipient and the amount the facilitator checks the
 * signature against are inputs we supply — the recipient gap #282 recorded
 * closes by construction rather than by a facilitator attesting it.
 *
 * The one amount check it does make is in `verify` and `settle`: the signed
 * `authorization.value` must equal the offer's amount exactly, or nothing is
 * sent (`offer_mismatch`). The facilitator is not relied on for that.
 *
 * WHAT IT DOES NOT DO. It does not check the amount against an order, or the
 * time window against a clock (the domain does, Decision 5 step 4), and it
 * holds no state between calls beyond which offers and payments it minted.
 *
 * ONE INSTANCE PER REQUEST'S FLOW. `offer`, `verify` and `settle` must be called
 * on the same rail, with the very objects `offer` and `decode` returned: an
 * offer is recognised by identity in this instance, a payment by identity in
 * this module. A copy, or an offer from another instance, is refused with no
 * call (`offer_mismatch`).
 */
export function createX402Rail(options: X402RailOptions): X402Rail {
	const baseUrl = parseBaseUrl(options.facilitatorUrl);
	const rawKey = options.facilitatorApiKey;
	const credential = rawKey === undefined || rawKey === "" ? undefined : rawKey;
	const configured =
		baseUrl !== undefined && (credential === undefined || HEADER_SAFE_KEY.test(credential));
	const { payTo, fetch: fetchFn } = options;
	const networks = [...new Set(options.networks)];
	/** Offers this rail built. Only these are ever sent as requirements. */
	const minted = new WeakSet<X402Offer>();

	/** Per-path headers: the seam the reference client exposes
	 *  (`createAuthHeaders(path)`), so another auth scheme can be added later
	 *  without touching the flow. Today both paths get the same bearer. */
	function headersFor(_path: "/verify" | "/settle"): Record<string, string> {
		return credential === undefined
			? { "Content-Type": "application/json" }
			: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` };
	}

	function offer(price: Money, resourceUrl: string): X402OfferResult {
		if (!configured) return refuse("facilitator");
		if (!isAbsoluteHttpUrl(resourceUrl)) return refuse("resource");
		if (price.currency !== "USD") return refuse("currency");
		if (!Number.isSafeInteger(price.amount) || price.amount <= 0) return refuse("amount");
		if (networks.length === 0) return refuse("network");
		const rows = networks.map((network) => ({ network, row: usdcAssetFor(network) }));
		if (rows.some(({ row }) => row === undefined)) return refuse("network");

		const amount = centsToAtomic(price.amount);
		const accepts: X402PaymentRequirements[] = [];
		for (const { network, row } of rows) {
			const projected = projectPayTo(payTo, network);
			if (row === undefined || projected === undefined) continue;
			accepts.push(
				Object.freeze({
					scheme: "exact",
					network,
					amount,
					asset: row.asset,
					payTo: projected,
					maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
					extra: Object.freeze({
						name: row.name,
						version: row.version,
						assetTransferMethod: "eip3009",
					}),
				}),
			);
		}
		if (accepts.length === 0) return refuse("pay_to");

		const built: X402Offer = Object.freeze({
			price: Object.freeze({ amount: price.amount, currency: price.currency }),
			paymentRequired: Object.freeze({
				x402Version: 2,
				resource: Object.freeze({ url: resourceUrl }),
				accepts: Object.freeze(accepts),
			}),
		});
		minted.add(built);
		return { ok: true, offer: built };
	}

	/** The parsed payment and OUR requirements for it, or why there are none. */
	function prepare(payment: X402DecodedPayment, against: X402Offer) {
		if (!configured || baseUrl === undefined) return { ok: false, cause: "unconfigured" } as const;
		// Identity first: an offer this rail did not build is never read at all.
		if (!minted.has(against)) return { ok: false, cause: "offer_mismatch" } as const;
		const parsed = parsedPaymentOf(payment);
		const match = matchOffer(payment, against);
		if (parsed === undefined || !match.ok) {
			return { ok: false, cause: "offer_mismatch" } as const;
		}
		// The signed value must be exactly our amount, checked HERE rather than
		// left to the facilitator (#405 item 1). The spec has the facilitator
		// compare them, but one that accepted `value >= amount` would settle an
		// overpayment the order then refuses: money moved, no paid order. The
		// domain compares the amount too (Decision 5, step 4); this makes "never
		// send a payment for another amount" the adapter's own guarantee, as the
		// recipient already is. A string comparison is exact because both sides
		// are canonical base 10: `centsToAtomic` prints BigInt's, and the decoder
		// accepts no other form (no sign, no leading zero, no exponent).
		if (parsed.authorization.value !== match.requirements.amount) {
			return { ok: false, cause: "offer_mismatch" } as const;
		}
		const body = JSON.stringify({
			x402Version: 2,
			paymentPayload: wirePaymentPayload(parsed),
			paymentRequirements: match.requirements,
		});
		return { ok: true, parsed, requirements: match.requirements, body, baseUrl } as const;
	}

	async function verify(
		payment: X402DecodedPayment,
		against: X402Offer,
	): Promise<X402VerifyResult> {
		try {
			return await verifyOnce(payment, against);
		} catch {
			// Never reached by design; the port promises verify never throws.
			return { outcome: "unavailable", cause: "transport" };
		}
	}

	async function verifyOnce(
		payment: X402DecodedPayment,
		against: X402Offer,
	): Promise<X402VerifyResult> {
		const prepared = prepare(payment, against);
		if (!prepared.ok) return { outcome: "unavailable", cause: prepared.cause };
		const exchange = await postToFacilitator(
			fetchFn,
			`${prepared.baseUrl}/verify`,
			headersFor("/verify"),
			prepared.body,
			VERIFY_TIMEOUT_MS,
		);
		return classifyVerify(exchange, prepared.parsed, credential);
	}

	async function settle(
		payment: X402DecodedPayment,
		against: X402Offer,
	): Promise<X402SettleResult> {
		try {
			return await settleOnce(payment, against);
		} catch {
			// Never reached by design. If it were, money may have moved, so the
			// answer is the conservative one: unconfirmed, flagged for a check.
			return { outcome: "unconfirmed", cause: "transport" };
		}
	}

	async function settleOnce(
		payment: X402DecodedPayment,
		against: X402Offer,
	): Promise<X402SettleResult> {
		const prepared = prepare(payment, against);
		if (!prepared.ok) return { outcome: "unconfirmed", cause: prepared.cause };
		const exchange = await postToFacilitator(
			fetchFn,
			`${prepared.baseUrl}/settle`,
			headersFor("/settle"),
			prepared.body,
			SETTLE_TIMEOUT_MS,
		);
		return classifySettle(exchange, prepared.parsed, prepared.requirements, credential);
	}

	return { offer, decode: decodePaymentHeader, matchOffer, verify, settle };
}
