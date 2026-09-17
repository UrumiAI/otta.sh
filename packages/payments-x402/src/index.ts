import {
	type ClientAction,
	type ConfirmationResult,
	type CreateIntentInput,
	type PaymentGateway,
	type PaymentIntentHandle,
	type RawConfirmation,
	type RefundInput,
	type RefundResult,
	type X402Proof,
} from "@otta-sh/domain";

/**
 * Server-side facilitator verification of an x402 settlement receipt (§9 Risk 2).
 * The x402 adapter NEVER trusts the plugin's assertion that payment happened — it
 * asks a facilitator to re-verify the receipt. In production this is an HTTP call
 * to the x402 facilitator (`@x402/core`'s `HTTPFacilitatorClient`, which the
 * `@emdash-cms/x402` Astro integration uses); in tests it is the offline HMAC
 * facilitator below (no network).
 *
 * ⚠️ PRODUCTION SWAP-IN REQUIREMENTS (load-bearing — read before wiring a real
 * facilitator client here):
 *  - The facilitator MUST cryptographically attest the settlement's **amount,
 *    asset/currency, and recipient** for `proof.transaction` on `proof.network`
 *    — "the tx exists" is NOT sufficient. `proof.orderId` is NEVER
 *    on-chain-attestable (it exists only in our DB), so the ONLY things binding
 *    a receipt to an order are (a) the domain's `amount == order_totals.total`
 *    equality check in `settleOrder` and (b) the tx-hash dedupe — one settlement
 *    consumes one on-chain payment. Both checks are LOAD-BEARING and BOTH ARE
 *    IMPLEMENTED: (a) at `settleOrder` step 3, and (b) at step 2b, which reads
 *    the recorded dedupe row's order back (`PaymentEventStore.orderForDedupeKey`)
 *    and TERMINALLY refuses a `transaction` already bound to a different order.
 *    (Until review round 2 the second was asserted here and discarded there,
 *    which is exactly the "single payment settles an arbitrary same-priced
 *    order" hole this paragraph warns about.)
 *  - STILL OUTSTANDING, and the reason this block is a warning and not a
 *    description: the adapter does NOT verify the attested **recipient equals
 *    this gateway's `payTo`**, because no facilitator client here exposes it yet.
 *    A genuine on-chain payment of the right amount to the ATTACKER'S OWN wallet
 *    would therefore satisfy (a) and (b). What contains that today is deployment
 *    shape, not code: the plugin's settle route additionally requires the named
 *    order to have `paymentMethod: "x402"`, and storefront checkout originates no
 *    x402 order at all. Wiring a real facilitator client MUST add the recipient
 *    check before x402 origination is enabled.
 */
/**
 * What a facilitator said about a receipt.
 *
 * `valid: false` alone means THE FACILITATOR ANSWERED AND THE ANSWER WAS NO.
 * `unavailable: true` means IT COULD NOT BE ASKED — a transport failure, a
 * timeout, a 5xx/429, a rejected credential, a body that did not parse. The
 * distinction is not cosmetic: for a buyer whose money already moved on-chain,
 * reporting a transient outage as "invalid signature" is a PERMANENT refusal of
 * a settlement that was actually fine, and the caller has no way to tell the two
 * apart after the fact. `payments-stripe` draws the same line with its
 * `retryable | ambiguous | terminal` classification.
 */
export interface X402VerifyResult {
	valid: boolean;
	/** Set only on the "could not ask" arm. Never set alongside `valid: true`. */
	unavailable?: boolean;
}

export interface X402Facilitator {
	verifyReceipt(proof: X402Proof): Promise<X402VerifyResult>;
}

/**
 * The facilitator could not be reached or could not answer — thrown by
 * {@link X402PaymentGateway.verifyConfirmation}, never by the facilitator
 * adapter itself.
 *
 * WHY A THROW AND NOT A REASON. The port's `ConfirmationResult` offers exactly
 * three failure reasons (`INVALID_SIGNATURE`, `UNKNOWN_EVENT`, `MALFORMED`) and
 * every one of them is a TERMINAL statement about the confirmation. There is no
 * honest way to say "ask me again" in that union, and widening a domain port
 * from an adapter is not this increment's business. So the gateway does what
 * `payments-stripe` already does for an ambiguous Stripe failure: it throws a
 * CLASSIFIED error (`PaymentIntentError({retryable})` there, this here), which
 * a caller surfaces as a retryable 5xx rather than as a terminal 400.
 *
 * **No credential, and no part of the proof, may ever reach `message` or any
 * enumerable field** — this is logged verbatim, exactly as `PaymentIntentError`
 * documents for itself.
 */
export class X402FacilitatorUnavailableError extends Error {
	readonly gateway = "x402" as const;
	readonly retryable = true;

	constructor() {
		super("x402 facilitator could not verify the receipt (unavailable — retryable)");
		this.name = "X402FacilitatorUnavailableError";
	}
}

export interface X402PaymentGatewayOptions {
	facilitator: X402Facilitator;
	/** Destination wallet (the x402 challenge `payTo`). */
	payTo: string;
	/** CAIP-2 networks the challenge accepts (e.g. `["eip155:8453"]`). */
	accepts: string[];
}

/**
 * x402 `PaymentGateway` adapter (§5/§6, step 4.7). `createIntent` returns the
 * `x402_challenge` descriptor the page layer serves as a 402. `verifyConfirmation`
 * takes the page-gate proof (the facilitator **SettleResponse**: on-chain
 * `transaction` + `network` + `payer` — see `@emdash-cms/x402`), re-verifies it
 * server-side via the injected facilitator, and normalizes it to the shared
 * `ConfirmationResult` — landing on the identical `settleOrder` path as Stripe,
 * granting an entitlement. `transaction` (unique per settlement) is the dedupe key.
 */
export class X402PaymentGateway implements PaymentGateway {
	readonly id = "x402" as const;
	/**
	 * x402 CANNOT refund (ADR-0008). On-chain USDC settlement is irreversible and
	 * this adapter holds no signing wallet — it only VERIFIES inbound receipts via
	 * a facilitator. `refundable:false` is honest by construction; the domain
	 * records an x402 refund as a `manual`, out-of-band entry instead of ever
	 * pretending money moved.
	 */
	readonly refundable = false;
	readonly #facilitator: X402Facilitator;
	readonly #payTo: string;
	readonly #accepts: string[];

	constructor(options: X402PaymentGatewayOptions) {
		this.#facilitator = options.facilitator;
		this.#payTo = options.payTo;
		this.#accepts = options.accepts;
	}

	async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		const clientAction: ClientAction = {
			kind: "x402_challenge",
			accepts: this.#accepts,
			price: input.amount,
			payTo: this.#payTo,
		};
		return { gateway: this.id, intentId: `x402_${input.orderId}`, clientAction };
	}

	async verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult> {
		if (raw.kind !== "page_gate") return { ok: false, reason: "MALFORMED" };
		const proof = raw.proof;
		if (typeof proof.transaction !== "string" || proof.transaction.length === 0) {
			return { ok: false, reason: "MALFORMED" };
		}
		// The settlement network must be one this gateway's challenge accepts — a
		// receipt from a foreign network is rejected as unverified (a facilitator
		// attestation for a network we never offered proves nothing about our
		// requirements).
		if (!this.#accepts.includes(proof.network)) {
			return { ok: false, reason: "INVALID_SIGNATURE" };
		}
		// Facilitator-verified server-side — never trust the plugin's word.
		const verdict = await this.#facilitator.verifyReceipt(proof);
		// "COULD NOT ASK" IS NOT "THE ANSWER WAS NO". A facilitator outage must not
		// permanently refuse a settlement whose money already moved; the caller gets
		// a retryable throw instead of a terminal reason it cannot distinguish. See
		// {@link X402FacilitatorUnavailableError} for why this is a throw.
		if (verdict.unavailable === true) throw new X402FacilitatorUnavailableError();
		if (!verdict.valid) return { ok: false, reason: "INVALID_SIGNATURE" };
		return {
			ok: true,
			outcome: "succeeded",
			orderId: proof.orderId,
			providerRef: proof.transaction,
			amount: proof.amount,
			currency: proof.currency,
			dedupeKey: proof.transaction,
			gateway: "x402",
		};
	}

	/**
	 * x402 has no outbound-payment capability (ADR-0008): an on-chain settlement
	 * cannot be reversed and the service holds no signing wallet. Return the
	 * capability statement `UNSUPPORTED` — NOT a thrown runtime error — so the
	 * domain records a `manual` refund (the admin sends USDC back to the captured
	 * `payer` out of band) rather than treating a failed "x402 refund" as
	 * retryable. The declared `refundable:false` means the domain never even calls
	 * this on the happy path; it is here only to satisfy the port completely.
	 */
	async refund(_input: RefundInput): Promise<RefundResult> {
		return { ok: false, reason: "UNSUPPORTED" };
	}
}

// -- HTTP facilitator (production; the ONE network call this package makes) --

/** The transport an {@link createHttpFacilitator} is handed. Property-style, and
 *  injected rather than ambient, for two reasons that are really one: the plugin
 *  passes `ctx.http.fetch` so the call is gated by `allowedHosts`, and neither
 *  this package nor that plugin may reach a bare global `fetch` (the sandbox-clean
 *  rule, pinned by both packages' guard suites). */
export interface HttpFacilitatorOptions {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	/** The facilitator's verification endpoint. */
	url: string;
	/** Bearer credential for the facilitator API, when it requires one. */
	apiKey?: string | undefined;
	/** Per-request timeout, via `AbortSignal.timeout`. Defaults to
	 *  {@link DEFAULT_FACILITATOR_TIMEOUT_MS}. */
	requestTimeoutMs?: number | undefined;
}

/**
 * A hung facilitator must never hang a Worker settlement — the same rule, and
 * the same default, as `payments-stripe`'s `DEFAULT_REQUEST_TIMEOUT_MS` ("a hung
 * Stripe must never hang a Worker checkout"). Without it `verifyReceipt` awaits
 * forever inside `settleOrder`, holding the isolate.
 */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 30_000;

/** Statuses that say nothing about the RECEIPT: the facilitator is down, rate
 *  limiting us, or refusing OUR credential. None of those is a verdict on the
 *  buyer's proof, so none may become a terminal `INVALID_SIGNATURE`. Every other
 *  non-2xx (400/404/422 …) means the facilitator read the receipt and rejected
 *  it — that IS a verdict, and stays terminal. Mirrors the `>= 500 || 429`
 *  retryable split `payments-stripe` uses on a READ, plus the two auth codes,
 *  which for a verification call are a misconfiguration on our side. */
function isUnavailableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429 || status === 401 || status === 403;
}

/** Whether a facilitator that ECHOED an identifier echoed the one we asked
 *  about. A facilitator is not required to echo — the real clients differ — but
 *  one that answers about a DIFFERENT transaction or order has attested
 *  something else, and that answer must not settle this one. An absent field is
 *  not a mismatch; a present, non-matching field is. */
function echoesRequest(body: Record<string, unknown>, proof: X402Proof): boolean {
	for (const [key, asked] of [
		["transaction", proof.transaction],
		["orderId", proof.orderId],
	] as const) {
		const answered = body[key];
		if (answered !== undefined && answered !== asked) return false;
	}
	return true;
}

/**
 * An {@link X402Facilitator} that asks a real facilitator over HTTP (INC-C5) —
 * the production counterpart to {@link createTestFacilitator}'s offline HMAC.
 *
 * FAIL-CLOSED IN EVERY DIRECTION, and never throwing: nothing short of an
 * explicit `valid: true` from the facilitator, about THIS receipt, is valid.
 *
 * BUT "NOT VALID" IS TWO DIFFERENT FACTS, and the first cut of this adapter
 * folded them together. "The facilitator answered and the answer was no" is a
 * verdict on the buyer's proof; "the facilitator could not be asked" (transport
 * failure, timeout, 5xx/429, rejected credential, unparseable body) is a fact
 * about US. Reported identically, a five-second facilitator blip became a
 * permanent `INVALID_SIGNATURE` refusal for a buyer whose USDC had already
 * moved. So the second arm carries `unavailable: true`, and
 * {@link X402PaymentGateway.verifyConfirmation} turns that into a RETRYABLE
 * throw — the caller now has something to decide on, which the old
 * "retries or refuses on its own terms" claimed without providing.
 *
 * BOUND TO THE QUESTION. A facilitator that echoes a `transaction` or `orderId`
 * must echo the one we asked about; an answer about a different receipt is no
 * answer at all, and is reported as `unavailable` rather than as a verdict —
 * a facilitator attesting someone else's transaction is a fault at ITS end, and
 * the buyer whose money moved must keep the retry. (Echoing is optional — the
 * real clients differ — so an absent field is not a mismatch.)
 *
 * TIMED OUT. `AbortSignal.timeout` bounds the call
 * ({@link DEFAULT_FACILITATOR_TIMEOUT_MS}): a hung facilitator would otherwise
 * hang `settleOrder` inside the isolate with no ceiling at all.
 *
 * ⚠ The PRODUCTION SWAP-IN REQUIREMENTS on {@link X402Facilitator} are NOT
 * discharged by a 200 from this endpoint. The facilitator must cryptographically
 * attest the settlement's amount, asset and recipient — which is why the whole
 * receipt is forwarded rather than just the tx hash — and the recipient must be
 * checked against this gateway's `payTo` once a facilitator exposes it. Until
 * then the domain's `amount == order total` equality and its `RECEIPT_REBOUND`
 * tx-hash binding are what tie a receipt to an order, and neither of them can see
 * where the money actually went.
 */
export function createHttpFacilitator(options: HttpFacilitatorOptions): X402Facilitator {
	const doFetch = options.fetch;
	const timeoutMs = options.requestTimeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS;
	return {
		async verifyReceipt(proof: X402Proof): Promise<X402VerifyResult> {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (options.apiKey !== undefined && options.apiKey.length > 0) {
				headers["authorization"] = `Bearer ${options.apiKey}`;
			}
			try {
				const res = await doFetch(options.url, {
					method: "POST",
					headers,
					// `amount` is already integer minor units (branded `Cents`) and is
					// serialized as that integer — the facilitator is asked to attest THAT
					// number, which is the one the domain then equality-checks.
					body: JSON.stringify({
						orderId: proof.orderId,
						transaction: proof.transaction,
						network: proof.network,
						payer: proof.payer,
						amount: proof.amount,
						currency: proof.currency,
						signature: proof.signature,
					}),
					// A hung facilitator must never hang a Worker settlement.
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!res.ok) {
					return isUnavailableStatus(res.status)
						? { valid: false, unavailable: true }
						: { valid: false };
				}
				let body: unknown;
				try {
					body = await res.json();
				} catch {
					// A 200 carrying something that is not JSON is a BROKEN answer, not a
					// verdict — an HTML error page from a proxy in front of the facilitator
					// reads exactly like this.
					return { valid: false, unavailable: true };
				}
				if (typeof body !== "object" || body === null || Array.isArray(body)) {
					return { valid: false, unavailable: true };
				}
				const answer = body as Record<string, unknown>;
				// EXPLICIT `true`, not truthiness: a facilitator answering `"true"`, or
				// an error envelope that happens to carry a `valid` key, must not settle
				// an order. And the answer must be about the receipt we asked about.
				if (answer["valid"] !== true) return { valid: false };
				// AN ANSWER ABOUT SOMETHING ELSE IS NOT AN ANSWER. Classified
				// `unavailable`, not terminal (review round 2, A4): a facilitator
				// attesting a DIFFERENT transaction or order is a fact about the
				// FACILITATOR — the same category as an unparseable body or a
				// non-object 200, both of which already route here — not a verdict on
				// the buyer's proof. Calling it `INVALID_SIGNATURE` would permanently
				// refuse a settlement whose money moved, over a bug at the other end.
				if (!echoesRequest(answer, proof)) return { valid: false, unavailable: true };
				return { valid: true };
			} catch {
				// A transport rejection, an abort on the timeout above, or the
				// allowedHosts refusal a misconfigured descriptor produces. All of them
				// are "could not ask" — still never a throw from here, but no longer
				// indistinguishable from a forged receipt.
				return { valid: false, unavailable: true };
			}
		},
	};
}

// -- offline HMAC facilitator (test/dev; NO network) -------------------------

/** Canonical bytes the offline facilitator signs/verifies a receipt over. */
function canonical(proof: Omit<X402Proof, "signature">): string {
	return [
		proof.orderId,
		proof.transaction,
		proof.network,
		proof.payer,
		String(proof.amount),
		proof.currency,
	].join("|");
}

/**
 * An offline facilitator that treats `proof.signature` as an HMAC over the
 * receipt's canonical bytes with a shared secret — a deterministic stand-in for
 * the real facilitator's cryptographic verification (NO network). A real
 * deployment swaps this for an `HTTPFacilitatorClient`-backed impl.
 */
export function createTestFacilitator(secret: string): X402Facilitator {
	return {
		async verifyReceipt(proof: X402Proof): Promise<{ valid: boolean }> {
			// `crypto.subtle.verify` rather than sign-then-compare: the keyed HMAC
			// verify primitive is constant-time BY CONSTRUCTION, so the timing
			// side-channel this `safeEqualHex` existed to close cannot reopen. A
			// malformed-hex signature can never be a valid tag — reject without
			// calling verify, exactly as the old truncate-then-length-mismatch path
			// resolved to `false`.
			const signature = fromHex(proof.signature);
			if (signature === undefined) return { valid: false };
			const key = await importHmacKey(secret, "verify");
			const payload = new TextEncoder().encode(canonical(proof));
			return { valid: await crypto.subtle.verify("HMAC", key, signature, payload) };
		},
	};
}

/**
 * Mint a valid page-gate proof signed for {@link createTestFacilitator}.
 *
 * **Async** since the WebCrypto port: `crypto.subtle.sign` returns a Promise
 * where `node:crypto`'s `createHmac().digest()` was synchronous. The signature
 * bytes are identical — only the call shape changed.
 */
export async function signX402Proof(
	proof: Omit<X402Proof, "signature">,
	secret: string,
): Promise<X402Proof> {
	const key = await importHmacKey(secret, "sign");
	const payload = new TextEncoder().encode(canonical(proof));
	const signature = toHex(await crypto.subtle.sign("HMAC", key, payload));
	return { ...proof, signature };
}

// -- WebCrypto HMAC primitives (sandbox-clean: no `node:crypto`) -------------
//
// `crypto.subtle` is an ambient global in BOTH modern Node (≥19) and workerd, so
// these run unchanged in the Node test suites and inside the plugin's sandbox —
// which is why this package no longer imports `node:crypto` (CLAUDE.md: the
// plugin is sandbox-clean, `node:` imports are banned).

/** The offline facilitator's HMAC-SHA256 — the one algorithm here. */
const HMAC_SHA256 = { name: "HMAC", hash: "SHA-256" } as const;

/** Import the shared facilitator secret as a raw HMAC-SHA256 key. Non-extractable,
 *  and scoped to the single usage the caller needs. */
async function importHmacKey(secret: string, usage: "sign" | "verify") {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), HMAC_SHA256, false, [
		usage,
	]);
}

/** Lowercase hex, matching `createHmac(...).digest("hex")` byte for byte. */
function toHex(bytes: ArrayBuffer): string {
	let out = "";
	for (const byte of new Uint8Array(bytes)) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Decode a hex signature, or `undefined` when it is not well-formed hex. Strict
 *  where `Buffer.from(s, "hex")` truncated silently; the observable result is the
 *  same, because a truncated buffer then failed `timingSafeEqual`'s length check.
 *  Upper-case is accepted, as `Buffer.from` accepted it. */
// The `<ArrayBuffer>` argument is load-bearing, not decoration: bare `Uint8Array`
// widens to `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.verify`'s
// `BufferSource` rejects in any program whose lib narrows `ArrayBufferView` to
// `ArrayBuffer` — as the plugin's does, now that it depends on this package and
// therefore typechecks this source.
function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) return undefined;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
