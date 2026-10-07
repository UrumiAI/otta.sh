import type { Cents, Currency, Money } from "../money/cents.js";

/**
 * The `X402Rail` port (ADR-0028 Decision 2): everything protocol-specific about
 * an x402 content-gate payment, so the domain use case that decides about the
 * money (`payForGatedProduct`, increment 7) never sees a header, a base64 string,
 * an atomic token amount or a facilitator response.
 *
 * WHY A SEPARATE PORT, NOT MORE `PaymentGateway` METHODS. Stripe has no analogue
 * for any of these, and ADR-0008 already rejected a gateway interface that
 * pretends a method can do something it cannot. The IO outcomes also have three
 * arms each (valid / invalid / unavailable, and settled / rejected / unconfirmed),
 * where `ConfirmationResult`'s failure union is closed and terminal-only.
 *
 * Types only. `@otta-sh/payments-x402` implements it (`createX402Rail`), and every
 * rule that needs the wire format — the USDC asset table, the `payTo` projection,
 * the cents ↔ atomic mapping, the strict decoder, the facilitator client and the
 * answer classification — lives there (ADR-0028 Decisions 3, 4 and 8).
 *
 * `offer`, `decode` and `matchOffer` are pure: no network call, no write, and no
 * throw. `verify` and `settle` do IO through the adapter's injected fetch and
 * never throw either: "could not ask" is an outcome (`unavailable` /
 * `unconfirmed`), never an exception and never "the answer was no".
 *
 * ONE RAIL, THE SAME OBJECTS. A request uses ONE rail instance for `offer`,
 * `verify` and `settle`, and passes back the exact objects it returned: the
 * `X402Offer` from `offer` and the `X402DecodedPayment` from `decode`. A copy
 * (a spread, a rebuilt object, an offer from another instance) is refused with
 * no facilitator call — `PAYMENT_MISMATCH` (`payload`) from `matchOffer`,
 * `offer_mismatch` from `verify` / `settle` — so nothing outside the adapter can
 * change what is sent.
 */
export interface X402Rail {
	/**
	 * Our offer for `price`: the v2 `PaymentRequired` object and its
	 * per-network requirements, built only from our own settings and price.
	 * `NOT_OFFERED` when x402 cannot take this price on any network (Decisions
	 * 1, 3 and 4) — the gate then answers 404.
	 */
	offer(price: Money, resourceUrl: string): X402OfferResult;
	/** Strictly decodes a `PAYMENT-SIGNATURE` header value (Decision 5, step 1). */
	decode(header: string): X402DecodeResult;
	/**
	 * Structural match of a decoded payment against our offer (Decision 5, step
	 * 2): scheme, network, asset, `payTo`, `authorization.to`, `extra` and the
	 * transfer method. NEVER the amount or the time window — the domain checks
	 * those against the order or the clock.
	 */
	matchOffer(payment: X402DecodedPayment, offer: X402Offer): X402MatchResult;
	/** `POST /verify` with OUR requirements for the payment's network. */
	verify(payment: X402DecodedPayment, offer: X402Offer): Promise<X402VerifyResult>;
	/** `POST /settle` with OUR requirements for the payment's network. */
	settle(payment: X402DecodedPayment, offer: X402Offer): Promise<X402SettleResult>;
}

/** One entry of `accepts[]` (v2 §5.1.2) as WE build it: `exact` on an EVM
 *  network, USDC, EIP-3009 only. `amount` is the base-10 atomic-unit string. */
export interface X402PaymentRequirements {
	readonly scheme: "exact";
	/** CAIP-2, e.g. `eip155:8453`. */
	readonly network: string;
	readonly amount: string;
	/** The USDC contract on `network`, from the adapter's fixed table. */
	readonly asset: string;
	/** The bare `0x…` address `settings:x402PayTo` projects to on `network`. */
	readonly payTo: string;
	readonly maxTimeoutSeconds: number;
	readonly extra: {
		/** EIP-712 domain name of the token. */
		readonly name: string;
		/** EIP-712 domain version of the token. */
		readonly version: string;
		readonly assetTransferMethod: "eip3009";
	};
}

/** The v2 `PaymentRequired` object (v2 §5.1). The site adds `error` when it
 *  answers a refused payment. */
export interface X402PaymentRequired {
	readonly x402Version: 2;
	/** Why payment is required (v2 §5.1.2, optional), e.g. the field a refused
	 *  payment got wrong. `offer` never sets it. */
	readonly error?: string;
	readonly resource: { readonly url: string };
	readonly accepts: readonly X402PaymentRequirements[];
}

export interface X402Offer {
	/** The price the offer was built from — the domain's own number. */
	readonly price: Money;
	readonly paymentRequired: X402PaymentRequired;
}

/** Why no offer: a non-USD price, a zero price, a `payTo` that projects onto
 *  no offered network, a configured network outside the asset table (or none
 *  configured), an unusable facilitator configuration, or a resource URL that
 *  is not an absolute http(s) URL. */
export type X402NotOfferedDetail =
	| "currency"
	| "amount"
	| "pay_to"
	| "network"
	| "facilitator"
	| "resource";

export type X402OfferResult =
	| { readonly ok: true; readonly offer: X402Offer }
	| { readonly ok: false; readonly reason: "NOT_OFFERED"; readonly detail: X402NotOfferedDetail };

declare const X402PayloadBrand: unique symbol;

/**
 * The decoded payment's wire payload, opaque to the domain: only the adapter
 * that decoded it can read it back, so nothing outside the adapter can put a
 * hand-built payload in front of the facilitator.
 */
export interface X402OpaquePayload {
	readonly [X402PayloadBrand]: true;
}

/** What the domain decides on, out of a decoded `PAYMENT-SIGNATURE`. */
export interface X402DecodedPayment {
	/**
	 * `eip3009:{chainId}:{asset}:{from}:{nonce}`, lowercased. Names exactly one
	 * EIP-3009 authorization (the token contract tracks nonce use per authorizer,
	 * v2 §10.1), so it is the dedupe key and the order idempotency seed.
	 */
	readonly paymentKey: string;
	/** `accepted.network` (CAIP-2). */
	readonly network: string;
	/** `authorization.from`, lowercased. */
	readonly payer: string;
	/** `authorization.nonce`, lowercased. Flags name it, never the signature. */
	readonly nonce: string;
	/** `authorization.value` converted EXACTLY back to US cents (Decision 3). */
	readonly amount: Cents;
	/** Always `USD`: the only currency the rail prices in. */
	readonly currency: Currency;
	/** Unix seconds, exact (`bigint`: the wire allows uint256). */
	readonly validAfter: bigint;
	readonly validBefore: bigint;
	readonly payload: X402OpaquePayload;
}

/** Which rule a refused header broke. Never carries any of the header's text. */
export type X402MalformedDetail =
	| "too_large"
	| "encoding"
	| "json"
	| "version"
	| "shape"
	| "transfer_method"
	| "network"
	| "address"
	| "nonce"
	| "valid_after"
	| "valid_before"
	| "value"
	| "signature";

export type X402DecodeResult =
	| { readonly ok: true; readonly payment: X402DecodedPayment }
	| { readonly ok: false; readonly reason: "MALFORMED"; readonly detail: X402MalformedDetail };

/** The field a `PAYMENT_MISMATCH` names. `to` is `authorization.to`;
 *  `transfer_method` is `extra.assetTransferMethod`; `payload` means the payment
 *  was not decoded by this rail (a programming error, never a client's). */
export type X402MismatchField =
	| "payload"
	| "scheme"
	| "network"
	| "asset"
	| "payTo"
	| "to"
	| "extra"
	| "transfer_method";

export type X402MatchResult =
	| { readonly ok: true; readonly requirements: X402PaymentRequirements }
	| { readonly ok: false; readonly reason: "PAYMENT_MISMATCH"; readonly field: X402MismatchField };

/**
 * Why the facilitator could not be asked, or its answer was not a verdict.
 *
 * `unconfigured` and `offer_mismatch` mean NO CALL WAS MADE. In correct code
 * neither can happen after a successful `offer` and `matchOffer` on the same
 * rail with the same objects, so the domain must treat them as programming
 * errors (log loudly), not as facilitator weather. They stay inside the
 * `unavailable` / `unconfirmed` arms on purpose: those arms already mean "no
 * verdict", and their conservative handling (503, or a flag for a manual check)
 * is safe for a case that should never occur — a separate arm would add a branch
 * every caller must get right for no money-safety gain.
 */
export type X402UnavailableCause =
	| "unconfigured"
	| "offer_mismatch"
	| "transport"
	| "timeout"
	| "status"
	| "redirect"
	| "oversize"
	| "body";

export type X402VerifyResult =
	| { readonly outcome: "valid"; readonly payer: string }
	| {
			readonly outcome: "invalid";
			/** The facilitator's `invalidReason` when it is a plain token
			 *  (`[A-Za-z0-9_]`), otherwise `undefined`. */
			readonly reason: string | undefined;
	  }
	| { readonly outcome: "unavailable"; readonly cause: X402UnavailableCause };

export type X402SettleResult =
	| {
			readonly outcome: "settled";
			/** `0x` + 32 bytes. Not unique per order: one transaction may batch
			 *  several authorizations, so the `paymentKey` is the dedupe key. */
			readonly transaction: string;
			readonly network: string;
			/** `authorization.from`, lowercased. */
			readonly payer: string;
	  }
	| {
			/**
			 * PROVEN PRE-BROADCAST: a well-formed `success: false` whose
			 * `errorReason` is on ADR-0028's allowlist AND whose `transaction` is
			 * `""`. Nothing was sent to the chain.
			 */
			readonly outcome: "rejected";
			readonly reason: string;
	  }
	| {
			/**
			 * Money may or may not have moved: could not ask, a `success: true` that
			 * fails a check, or a `success: false` not proven pre-broadcast. The
			 * domain flags the order for a manual chain check.
			 */
			readonly outcome: "unconfirmed";
			readonly cause: X402UnconfirmedCause;
			/** The facilitator's `errorReason`, when it is a plain token. */
			readonly reason?: string;
			/** The facilitator's `transaction`, when it is a well-formed hash. */
			readonly transaction?: string;
	  };

export type X402UnconfirmedCause =
	| X402UnavailableCause
	/** A `success: false` that is not proven pre-broadcast. */
	| "unproven_rejection"
	/** A `success: true` that fails a check (network, payer, amount, hash). */
	| "failed_check";
