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
 *    equality check in `settleOrder` and (b) the tx-hash dedupe (one settlement
 *    consumes one on-chain payment, so a receipt cannot be replayed onto a
 *    second same-priced order). Both checks are therefore LOAD-BEARING: weaken
 *    either and a single payment could settle an arbitrary same-priced order.
 *  - The adapter MUST additionally verify the attested **recipient equals this
 *    gateway's `payTo`** once the real client exposes it — otherwise a payment
 *    to the attacker's own wallet would satisfy the amount check.
 */
export interface X402Facilitator {
	verifyReceipt(proof: X402Proof): Promise<{ valid: boolean }>;
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
		const { valid } = await this.#facilitator.verifyReceipt(proof);
		if (!valid) return { ok: false, reason: "INVALID_SIGNATURE" };
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
}

/**
 * An {@link X402Facilitator} that asks a real facilitator over HTTP (INC-C5) —
 * the production counterpart to {@link createTestFacilitator}'s offline HMAC.
 *
 * FAIL-CLOSED IN EVERY DIRECTION, and never throwing. This sits directly in front
 * of `settleOrder`: a rejection here would surface as a 500 on a settlement the
 * buyer has already paid for, and an optimistic default would settle an
 * unverified receipt. So a transport error, a non-2xx, an unparseable body, or
 * any body that does not say `valid: true` all resolve to `{ valid: false }`, and
 * the caller retries or refuses on its own terms.
 *
 * ⚠ The PRODUCTION SWAP-IN REQUIREMENTS on {@link X402Facilitator} are NOT
 * discharged by a 200 from this endpoint. The facilitator must cryptographically
 * attest the settlement's amount, asset and recipient — which is why the whole
 * receipt is forwarded rather than just the tx hash — and the recipient must be
 * checked against this gateway's `payTo` once a facilitator exposes it. Until
 * then the domain's `amount == order total` equality and the tx-hash dedupe are
 * still what bind a receipt to an order.
 */
export function createHttpFacilitator(options: HttpFacilitatorOptions): X402Facilitator {
	const doFetch = options.fetch;
	return {
		async verifyReceipt(proof: X402Proof): Promise<{ valid: boolean }> {
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
				});
				if (!res.ok) return { valid: false };
				const body: unknown = await res.json();
				// EXPLICIT `true`, not truthiness: a facilitator answering `"true"`, or
				// an error envelope that happens to carry a `valid` key, must not settle
				// an order.
				const valid =
					typeof body === "object" &&
					body !== null &&
					!Array.isArray(body) &&
					(body as { valid?: unknown }).valid === true;
				return { valid };
			} catch {
				// Includes the allowedHosts refusal a misconfigured descriptor produces:
				// "not verified", never a 500 on the settle path.
				return { valid: false };
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
