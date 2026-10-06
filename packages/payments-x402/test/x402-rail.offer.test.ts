import { cents, currency, type Money } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { X402_USDC_ASSETS } from "../src/index.js";
import {
	BASE,
	BASE_SEPOLIA,
	SPEC_PAY_TO,
	USDC_BASE,
	USDC_BASE_SEPOLIA,
} from "./support/fixtures.js";
import { makeRail, offerOrThrow, ONE_CENT, RESOURCE_URL } from "./support/harness.js";

const usd = (n: number): Money => ({ amount: cents(n), currency: currency("USD") });

/**
 * ADR-0028 Decision 12, adapter, "The offer" — with Decisions 3 (amount and
 * asset) and 4 (the `payTo` projection) as the rules under test.
 */
describe("X402Rail.offer", () => {
	test("is the v2 PaymentRequired: projected payTo, the table's asset, extra with eip3009, 180 s, the exact atomic amount", () => {
		const { rail } = makeRail({ networks: [BASE, BASE_SEPOLIA] });
		const offer = offerOrThrow(rail, usd(499));

		expect(offer.price).toEqual(usd(499));
		expect(offer.paymentRequired).toEqual({
			x402Version: 2,
			resource: { url: RESOURCE_URL },
			accepts: [
				{
					scheme: "exact",
					network: BASE,
					amount: "4990000",
					asset: USDC_BASE,
					payTo: SPEC_PAY_TO,
					maxTimeoutSeconds: 180,
					extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
				},
				{
					scheme: "exact",
					network: BASE_SEPOLIA,
					amount: "4990000",
					asset: USDC_BASE_SEPOLIA,
					payTo: SPEC_PAY_TO,
					maxTimeoutSeconds: 180,
					extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
				},
			],
		});
	});

	test("the asset table is ADR-0028 Decision 3's, taken from the reference DEFAULT_STABLECOINS", () => {
		expect(X402_USDC_ASSETS).toEqual({
			[BASE]: { asset: USDC_BASE, name: "USD Coin", version: "2", decimals: 6 },
			[BASE_SEPOLIA]: { asset: USDC_BASE_SEPOLIA, name: "USDC", version: "2", decimals: 6 },
		});
	});

	describe("the amount: BigInt(cents) * 10_000n, a base-10 string, no floats", () => {
		test.each([
			["1¢", 1, "10000"],
			["1 USD", 100, "1000000"],
			// 2^53 - 1 cents: `cents * 10_000` as a float would round this.
			["a price past 2^53 once scaled", Number.MAX_SAFE_INTEGER, "90071992547409910000"],
		])("%s", (_label, amount, atomic) => {
			const { rail } = makeRail();
			expect(offerOrThrow(rail, usd(amount)).paymentRequired.accepts[0]?.amount).toBe(atomic);
		});

		test("the float product would be wrong for the 2^53 case (the test above is not vacuous)", () => {
			expect(String(Number.MAX_SAFE_INTEGER * 10_000)).not.toBe("90071992547409910000");
		});
	});

	test("a non-USD price is not offered: no FX", () => {
		const { rail } = makeRail();
		expect(rail.offer({ amount: cents(100), currency: currency("INR") }, RESOURCE_URL)).toEqual({
			ok: false,
			reason: "NOT_OFFERED",
			detail: "currency",
		});
	});

	test("a zero price is not offered: a free download is not a payment", () => {
		const { rail } = makeRail();
		expect(rail.offer(usd(0), RESOURCE_URL)).toEqual({
			ok: false,
			reason: "NOT_OFFERED",
			detail: "amount",
		});
	});

	describe("the payTo projection (Decision 4)", () => {
		test("a bare address is used as-is on every offered network", () => {
			const { rail } = makeRail({ networks: [BASE, BASE_SEPOLIA] });
			const accepts = offerOrThrow(rail).paymentRequired.accepts;
			expect(accepts.map((a) => a.payTo)).toEqual([SPEC_PAY_TO, SPEC_PAY_TO]);
		});

		test("a CAIP-10 account projects to its bare address on the matching network only", () => {
			const { rail } = makeRail({
				payTo: `${BASE_SEPOLIA}:${SPEC_PAY_TO}`,
				networks: [BASE, BASE_SEPOLIA],
			});
			expect(offerOrThrow(rail).paymentRequired.accepts).toEqual([
				expect.objectContaining({ network: BASE_SEPOLIA, payTo: SPEC_PAY_TO }),
			]);
		});

		test("a CAIP-10 account on another chain leaves no network, so nothing is offered", () => {
			const { rail } = makeRail({ payTo: `eip155:1:${SPEC_PAY_TO}`, networks: [BASE] });
			expect(rail.offer(ONE_CENT, RESOURCE_URL)).toEqual({
				ok: false,
				reason: "NOT_OFFERED",
				detail: "pay_to",
			});
		});

		test("the chain reference is compared as an exact string: eip155:08453 is not Base", () => {
			const { rail } = makeRail({ payTo: `eip155:08453:${SPEC_PAY_TO}`, networks: [BASE] });
			expect(rail.offer(ONE_CENT, RESOURCE_URL)).toMatchObject({ ok: false, detail: "pay_to" });
		});

		test.each([
			["the zero address", "0x0000000000000000000000000000000000000000"],
			["the zero address as CAIP-10", `${BASE_SEPOLIA}:0x0000000000000000000000000000000000000000`],
			["not an address", "treasury"],
			["39 hex digits", "0x209693Bc6afc0C5328bA36FaF03C514EF312287"],
			["surrounding whitespace", ` ${SPEC_PAY_TO}`],
			["an empty string", ""],
		])("a payTo that cannot be an address is not offered (%s)", (_label, payTo) => {
			const { rail } = makeRail({ payTo });
			expect(rail.offer(ONE_CENT, RESOURCE_URL)).toMatchObject({ ok: false, detail: "pay_to" });
		});

		test("the stored setting is never rewritten: the checksummed case survives byte for byte", () => {
			const options = {
				payTo: `${BASE_SEPOLIA}:${SPEC_PAY_TO}`,
				networks: [BASE_SEPOLIA],
			};
			const { rail } = makeRail(options);
			const offer = offerOrThrow(rail);
			expect(offer.paymentRequired.accepts[0]?.payTo).toBe(SPEC_PAY_TO);
			expect(options.payTo).toBe(`${BASE_SEPOLIA}:${SPEC_PAY_TO}`);
		});
	});

	describe("networks (Decision 3)", () => {
		test("a configured network outside the table disables x402 rather than offering one nobody can pay", () => {
			const { rail } = makeRail({ networks: [BASE, "eip155:1"] });
			expect(rail.offer(ONE_CENT, RESOURCE_URL)).toEqual({
				ok: false,
				reason: "NOT_OFFERED",
				detail: "network",
			});
		});

		test("no configured network is not offered", () => {
			const { rail } = makeRail({ networks: [] });
			expect(rail.offer(ONE_CENT, RESOURCE_URL)).toMatchObject({ ok: false, detail: "network" });
		});

		test("a network listed twice is offered once", () => {
			const { rail } = makeRail({ networks: [BASE_SEPOLIA, BASE_SEPOLIA] });
			expect(offerOrThrow(rail).paymentRequired.accepts).toHaveLength(1);
		});
	});

	test.each([
		["not a URL", "facilitator"],
		["not http(s)", "ftp://facilitator.test/x402"],
		[
			"plain http: the key and the payment would travel in the clear",
			"http://facilitator.test/x402",
		],
		["carrying a query", "https://facilitator.test/x402?route=1"],
		["carrying credentials", "https://user:pass@facilitator.test/x402"],
	])("an unusable facilitator URL (%s) is not offered", (_label, facilitatorUrl) => {
		const { rail } = makeRail({ facilitatorUrl });
		expect(rail.offer(ONE_CENT, RESOURCE_URL)).toEqual({
			ok: false,
			reason: "NOT_OFFERED",
			detail: "facilitator",
		});
	});

	test.each([
		["empty", ""],
		["relative", "/x402/products/ebook"],
		["not http(s)", "javascript:alert(1)"],
	])("a resource URL that is not absolute http(s) (%s) is not offered", (_label, resourceUrl) => {
		const { rail } = makeRail();
		expect(rail.offer(ONE_CENT, resourceUrl)).toEqual({
			ok: false,
			reason: "NOT_OFFERED",
			detail: "resource",
		});
	});

	test("building an offer makes no network call", () => {
		const { rail, facilitator } = makeRail();
		offerOrThrow(rail);
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
	});
});
