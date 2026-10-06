import {
	cents,
	currency,
	type Money,
	type X402DecodedPayment,
	type X402Offer,
	type X402Rail,
} from "@otta-sh/domain";
import { createX402Rail, type X402RailOptions } from "../../src/index.js";
import { createFakeFacilitator, type FakeFacilitator } from "./fake-facilitator.js";
import { BASE_SEPOLIA, SPEC_PAY_TO } from "./fixtures.js";

export const RESOURCE_URL = "https://shop.example/x402/products/ebook";

export const ONE_CENT: Money = { amount: cents(1), currency: currency("USD") };

/** An adapter over a fresh fake facilitator, typed as the PORT: every test
 *  drives `X402Rail`, not the implementation. Defaults: the spec example's
 *  `payTo`, Base Sepolia only, no key. */
export function makeRail(options: Partial<X402RailOptions> = {}): {
	rail: X402Rail;
	facilitator: FakeFacilitator;
} {
	const facilitator = createFakeFacilitator();
	const rail: X402Rail = createX402Rail({
		facilitatorUrl: facilitator.baseUrl,
		payTo: SPEC_PAY_TO,
		networks: [BASE_SEPOLIA],
		fetch: facilitator.fetch,
		...options,
	});
	return { rail, facilitator };
}

export function offerOrThrow(rail: X402Rail, price: Money = ONE_CENT): X402Offer {
	const result = rail.offer(price, RESOURCE_URL);
	if (!result.ok) throw new Error(`expected an offer, got NOT_OFFERED (${result.detail})`);
	return result.offer;
}

export function decodeOrThrow(rail: X402Rail, header: string): X402DecodedPayment {
	const result = rail.decode(header);
	if (!result.ok) throw new Error(`expected a decoded payment, got MALFORMED (${result.detail})`);
	return result.payment;
}

/**
 * Steps 1, 2, 5 and 8 of ADR-0028 Decision 5, in the domain's order: decode,
 * match, then `/verify` and `/settle`. The domain's own steps (lookup, amount,
 * window, order) are not the adapter's and are skipped. Returns the first
 * refusal, or both IO answers.
 */
export async function payAsTheDomainWould(rail: X402Rail, header: string, offer: X402Offer) {
	const decoded = rail.decode(header);
	if (!decoded.ok) return { refused: decoded } as const;
	const match = rail.matchOffer(decoded.payment, offer);
	if (!match.ok) return { refused: match } as const;
	const verify = await rail.verify(decoded.payment, offer);
	if (verify.outcome !== "valid") return { verify } as const;
	const settle = await rail.settle(decoded.payment, offer);
	return { verify, settle } as const;
}
