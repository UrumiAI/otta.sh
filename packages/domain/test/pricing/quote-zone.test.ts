import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import type { ShippingRulesStore } from "../../src/ports/shipping-rules-store.js";
import { computeQuote, type QuoteCommand, type QuoteDeps } from "../../src/pricing/quote.js";
import { quoteShippingOptions } from "../../src/pricing/shipping-options.js";
import { CountingIdGen, FixedClock } from "../../src/testing/deterministic.js";
import { InMemoryCouponStore } from "../../src/testing/in-memory-coupon-store.js";
import { InMemoryShippingRulesStore } from "../../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../../src/testing/in-memory-tax-rules-store.js";

/**
 * ADR-0021 at the quote: the zone comes from the destination, tax follows the
 * matched zone, and a chosen method must belong to it. Every cart is ONE line
 * of 2 × 1500 = 3000 unless stated.
 */
const USD = currency("USD");
const ONE_LINE = [{ unitPriceCents: cents(1500), qty: 2, taxClassId: "standard" }];

let shippingRules: InMemoryShippingRulesStore;
let taxRules: InMemoryTaxRulesStore;
let couponStore: InMemoryCouponStore;
let deps: QuoteDeps;

beforeEach(() => {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	shippingRules = new InMemoryShippingRulesStore();
	taxRules = new InMemoryTaxRulesStore();
	couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
	deps = { shippingRules, taxRules, couponStore, clock };
});

async function seedZone(spec: {
	id: string;
	regions: string[];
	taxBps?: number;
	methods?: Array<{
		id: string;
		amount: number | null;
		type?: "flat_rate" | "free_shipping";
		min?: number;
	}>;
}): Promise<void> {
	await shippingRules.createZone({ id: spec.id, name: spec.id, regions: spec.regions });
	for (const m of spec.methods ?? []) {
		await shippingRules.createMethod({
			id: m.id,
			zoneId: spec.id,
			name: `${m.id} name`,
			type: m.type ?? "flat_rate",
		});
		if (m.amount !== null) {
			await shippingRules.createRate({
				methodId: m.id,
				currency: USD,
				amountCents: cents(m.amount),
				minSubtotalCents: m.min === undefined ? null : cents(m.min),
			});
		}
	}
	if (spec.taxBps !== undefined) {
		await taxRules.createRate({
			id: `${spec.id}-std`,
			taxClassId: "standard",
			zoneId: spec.id,
			rateBps: spec.taxBps,
			appliesToShipping: false,
		});
	}
}

const quote = (over: Partial<QuoteCommand> = {}) =>
	computeQuote(deps, { currency: USD, lines: ONE_LINE, requiresShipping: true, ...over });

describe("computeQuote derives the zone from the destination", () => {
	test("tax follows the MATCHED zone: US 10% → 300, DE 19% → 570", async () => {
		await seedZone({ id: "z-us", regions: ["US"], taxBps: 1000 });
		await seedZone({ id: "z-de", regions: ["DE"], taxBps: 1900 });
		const us = await quote({ destination: { country: "US", region: "NY" } });
		const de = await quote({ destination: { country: "de" } });
		expect(us).toMatchObject({ ok: true, breakdown: { taxCents: 300 } });
		expect(de).toMatchObject({ ok: true, breakdown: { taxCents: 570 } });
		expect(us.ok && us.destination).toEqual({
			status: "matched",
			zoneId: "z-us",
			matchedRegion: "US",
			ambiguousWith: [],
		});
	});

	test("the US-CA happy path: 3000 + 599 + 7.25% (217.5 → 218, half-up) = 3817", async () => {
		await seedZone({ id: "z-us", regions: ["US"], taxBps: 0 });
		await seedZone({
			id: "z-us-ca",
			regions: ["US-CA"],
			taxBps: 725,
			methods: [{ id: "m-ca", amount: 599 }],
		});
		const result = await quote({
			destination: { country: "US", region: "US-CA" },
			methodId: "m-ca",
		});
		expect(result).toMatchObject({
			ok: true,
			breakdown: { subtotalCents: 3000, shippingCents: 599, taxCents: 218, totalCents: 3817 },
			destination: { status: "matched", zoneId: "z-us-ca", matchedRegion: "US-CA" },
		});
	});

	test("a method from ANOTHER zone → SHIPPING_METHOD_NOT_IN_ZONE (the cross-pairing bug)", async () => {
		await seedZone({
			id: "z-us",
			regions: ["US"],
			taxBps: 0,
			methods: [{ id: "m-us", amount: 100 }],
		});
		await seedZone({
			id: "z-de",
			regions: ["DE"],
			taxBps: 1900,
			methods: [{ id: "m-de", amount: 900 }],
		});
		expect(await quote({ destination: { country: "DE" }, methodId: "m-us" })).toEqual({
			ok: false,
			reason: "SHIPPING_METHOD_NOT_IN_ZONE",
		});
	});

	test("a method with no destination (physical cart, zones exist) → MISSING_SHIPPING_ADDRESS", async () => {
		await seedZone({ id: "z-us", regions: ["US"], methods: [{ id: "m-us", amount: 100 }] });
		expect(await quote({ methodId: "m-us" })).toEqual({
			ok: false,
			reason: "MISSING_SHIPPING_ADDRESS",
		});
	});

	test("no destination and no method → ok, address_needed, nothing computed", async () => {
		await seedZone({ id: "z-us", regions: ["US"], taxBps: 1000 });
		const result = await quote();
		expect(result).toMatchObject({
			ok: true,
			breakdown: { shippingCents: 0, taxCents: 0 },
			destination: { status: "address_needed" },
		});
	});

	describe("a digital-only cart", () => {
		test("with a method → SHIPPING_METHOD_NOT_APPLICABLE", async () => {
			await seedZone({ id: "z-us", regions: ["US"], methods: [{ id: "m-us", amount: 100 }] });
			expect(await quote({ requiresShipping: false, methodId: "m-us" })).toEqual({
				ok: false,
				reason: "SHIPPING_METHOD_NOT_APPLICABLE",
			});
		});

		test("its destination is ignored entirely — even ZZ — and it is untaxed", async () => {
			await seedZone({ id: "z-us", regions: ["US"], taxBps: 1000 });
			const result = await quote({
				requiresShipping: false,
				destination: { country: "ZZ", region: "Nowhere" },
			});
			expect(result).toMatchObject({
				ok: true,
				breakdown: { taxCents: 0, totalCents: 3000 },
				destination: { status: "not_required" },
			});
		});
	});

	describe("destination refusals", () => {
		beforeEach(async () => {
			await seedZone({ id: "z-us", regions: ["US"] });
			await seedZone({ id: "z-us-ca", regions: ["US-CA"] });
			await seedZone({ id: "z-de", regions: ["DE"] });
		});

		test.each([
			[{ country: "DE", region: "Bavaria" }, "SHIPPING_REGION_CODE_REQUIRED"],
			[{ country: "US", region: "XX" }, "SHIPPING_REGION_CODE_REQUIRED"],
			[{ country: "US", region: null }, "SHIPPING_REGION_CODE_REQUIRED"],
			[{ country: "US" }, "SHIPPING_REGION_CODE_REQUIRED"],
			[{ country: "ZZ" }, "INVALID_SHIPPING_ADDRESS"],
			[{ country: "United States" }, "INVALID_SHIPPING_ADDRESS"],
			[{ country: "FR" }, "SHIPPING_ZONE_NOT_MATCHED"],
		])("%j → %s", async (destination, reason) => {
			expect(await quote({ destination })).toEqual({ ok: false, reason });
		});
	});

	describe("a store with NO zones", () => {
		test("a destination prices 0 shipping / 0 tax", async () => {
			expect(await quote({ destination: { country: "US", region: "CA" } })).toMatchObject({
				ok: true,
				breakdown: { shippingCents: 0, taxCents: 0, totalCents: 3000 },
				destination: { status: "no_zones" },
			});
		});

		test("an unknown method → SHIPPING_METHOD_NOT_FOUND", async () => {
			expect(await quote({ methodId: "m-nope" })).toEqual({
				ok: false,
				reason: "SHIPPING_METHOD_NOT_FOUND",
			});
		});

		test("an ORPHAN method (its zone is gone) is never priced → SHIPPING_METHOD_NOT_IN_ZONE", async () => {
			await shippingRules.createMethod({
				id: "m-orphan",
				zoneId: "z-gone",
				name: "x",
				type: "flat_rate",
			});
			await shippingRules.createRate({
				methodId: "m-orphan",
				currency: USD,
				amountCents: cents(100),
				minSubtotalCents: null,
			});
			expect(await quote({ methodId: "m-orphan" })).toEqual({
				ok: false,
				reason: "SHIPPING_METHOD_NOT_IN_ZONE",
			});
		});
	});

	test("precedence: destination → zone → method → rate → coupon", async () => {
		await seedZone({ id: "z-us", regions: ["US"], methods: [{ id: "m-norate", amount: null }] });
		await seedZone({ id: "z-de", regions: ["DE"], methods: [{ id: "m-de", amount: 1 }] });
		const bad = { couponCode: "NOPE" };
		expect(await quote({ ...bad, methodId: "m-nope", destination: { country: "ZZ" } })).toEqual({
			ok: false,
			reason: "INVALID_SHIPPING_ADDRESS",
		});
		expect(await quote({ ...bad, methodId: "m-nope", destination: { country: "FR" } })).toEqual({
			ok: false,
			reason: "SHIPPING_ZONE_NOT_MATCHED",
		});
		expect(await quote({ ...bad, methodId: "m-nope", destination: { country: "US" } })).toEqual({
			ok: false,
			reason: "SHIPPING_METHOD_NOT_FOUND",
		});
		expect(await quote({ ...bad, methodId: "m-de", destination: { country: "US" } })).toEqual({
			ok: false,
			reason: "SHIPPING_METHOD_NOT_IN_ZONE",
		});
		expect(await quote({ ...bad, methodId: "m-norate", destination: { country: "US" } })).toEqual({
			ok: false,
			reason: "SHIPPING_RATE_NOT_FOUND",
		});
		expect(await quote({ ...bad, destination: { country: "US" } })).toEqual({
			ok: false,
			reason: "COUPON_NOT_FOUND",
		});
	});

	test("a mixed cart: the zone's rate applies to EVERY line — 1500 + 1000 at DE 19% → 285 + 190 = 475", async () => {
		await seedZone({ id: "z-de", regions: ["DE"], taxBps: 1900 });
		const result = await quote({
			lines: [
				{ unitPriceCents: cents(1500), qty: 1, taxClassId: "standard" },
				{ unitPriceCents: cents(1000), qty: 1, taxClassId: "standard" },
			],
			destination: { country: "DE" },
		});
		expect(result).toMatchObject({ ok: true, breakdown: { taxCents: 475 } });
	});
});

describe("quoteShippingOptions", () => {
	test("prices each of the zone's methods against the DISCOUNTED subtotal; no rate → null", async () => {
		await seedZone({
			id: "z-us",
			regions: ["US"],
			methods: [
				{ id: "m-flat", amount: 599 },
				{ id: "m-free", amount: 599, type: "free_shipping", min: 2500 },
				{ id: "m-norate", amount: null },
			],
		});
		await seedZone({ id: "z-de", regions: ["DE"], methods: [{ id: "m-de", amount: 1 }] });
		const below = await quoteShippingOptions(
			{ shippingRules },
			{ zoneId: "z-us", currency: USD, discountedSubtotal: cents(2499) },
		);
		expect(below).toEqual([
			{ methodId: "m-flat", name: "m-flat name", type: "flat_rate", amountCents: 599 },
			{ methodId: "m-free", name: "m-free name", type: "free_shipping", amountCents: 599 },
			{ methodId: "m-norate", name: "m-norate name", type: "flat_rate", amountCents: null },
		]);
		const at = await quoteShippingOptions(
			{ shippingRules },
			{ zoneId: "z-us", currency: USD, discountedSubtotal: cents(2500) },
		);
		expect(at.find((o) => o.methodId === "m-free")?.amountCents).toBe(0);
	});

	test("reads exactly 1 listMethods + N getRate (D12)", async () => {
		await seedZone({
			id: "z-us",
			regions: ["US"],
			methods: [
				{ id: "m-1", amount: 1 },
				{ id: "m-2", amount: 2 },
				{ id: "m-3", amount: null },
			],
		});
		const calls: string[] = [];
		const counting = new Proxy(shippingRules, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver) as unknown;
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls.push(String(property));
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		}) as ShippingRulesStore;
		await quoteShippingOptions(
			{ shippingRules: counting },
			{ zoneId: "z-us", currency: USD, discountedSubtotal: cents(100) },
		);
		expect(calls).toEqual(["listMethods", "getRate", "getRate", "getRate"]);
	});

	test("an unknown zone → []", async () => {
		expect(
			await quoteShippingOptions(
				{ shippingRules },
				{ zoneId: "z-none", currency: USD, discountedSubtotal: cents(0) },
			),
		).toEqual([]);
	});
});
