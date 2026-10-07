import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cents, idempotencyKey } from "../../src/index.js";
import { createOrderFromCart } from "../../src/orders/create-order-from-cart.js";
import { readOrderTaxSnapshot } from "../../src/orders/order-tax-snapshot.js";
import type { TaxCalculator, TaxRequest } from "../../src/pricing/tax-calculator.js";
import { makeOrderHarness, type OrderHarness, USD } from "./fake-harness.js";

/**
 * Order creation inherits the calculator through `computeQuote`, which runs
 * BEFORE any coupon redemption, order mint or hold adoption: a calculator that
 * cannot answer refuses the checkout with nothing moved. A good answer is
 * frozen into the order as the typed v1 snapshot, once.
 */
let h: OrderHarness;

beforeEach(async () => {
	h = makeOrderHarness();
	await h.shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
	await h.shippingRules.createMethod({ id: "m", zoneId: "z-us", name: "Flat", type: "flat_rate" });
	await h.shippingRules.createRate({
		methodId: "m",
		currency: USD,
		amountCents: cents(500),
		minSubtotalCents: null,
	});
	await h.taxRules.createClass({ id: "standard", name: "Standard rate" });
	await h.taxRules.createRate({
		id: "t",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 1000,
		appliesToShipping: true,
	});
	await h.couponStore.create({
		id: "cpn",
		code: "SAVE5",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: 5,
		maxUsesPerCustomer: null,
	});
	await h.seedPhysical({
		productId: "p1",
		sku: "SKU-1",
		priceCents: 1500,
		title: "Mug",
		onHand: 5,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const command = (cartId: string) => ({
	cartId,
	idempotencyKey: idempotencyKey(`k-${cartId}`),
	buyerRef: "ada@example.com",
	paymentMethod: "stripe" as const,
	couponCode: "SAVE5",
	shippingMethodId: "m",
	shippingAddress: {
		name: "Ada",
		line1: "1 Main St",
		city: "New York",
		region: "NY",
		postalCode: "10001",
		country: "US",
	},
});

describe("createOrderFromCart → TaxCalculator", () => {
	test("a refusing calculator ⇒ TAX_UNAVAILABLE: no order, no redemption, holds untouched", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const before = await h.cartStore.get(cartId);
		const refusing: TaxCalculator = {
			id: "acme.tax",
			calculate: async () => ({ ok: false, reason: "unavailable" }),
		};
		const res = await createOrderFromCart(
			{ ...h.createDeps, taxCalculator: refusing },
			command(cartId),
		);
		expect(res).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });
		expect(await h.orderStore.getByIdempotencyKey(idempotencyKey(`k-${cartId}`))).toBeNull();
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
		const after = await h.cartStore.get(cartId);
		expect(after?.state).toBe("active");
		expect(after?.lines).toEqual(before?.lines);
		for (const line of after?.lines ?? []) {
			expect(h.inventory.reservationState(line.reservationId as string)).toBe("held");
		}
		expect(h.stripeGw.intentCalls).toEqual([]);
	});

	test("the built-in writes the typed v1 snapshot, labelled by class name", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, command(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// 3000 − 500 coupon = 2500 @10% = 250; shipping 500 @10% = 50.
		expect(res.order.totals.taxBreakdown).toEqual({
			v: 1,
			calculatorId: "otta.rate-table",
			pricesIncludeTax: false,
			lines: [
				{
					lineIndex: 0,
					taxClassId: "standard",
					taxableCents: 2500,
					rateBps: 1000,
					label: "Standard rate",
					taxCents: 250,
				},
			],
			shipping: { taxableCents: 500, rateBps: 1000, label: "Standard rate", taxCents: 50 },
		});
		expect(res.order.totals.tax).toBe(300);
		expect(readOrderTaxSnapshot(res.order.totals.taxBreakdown)?.v).toBe(1);
	});

	test("an outside calculator is asked for purpose 'order', and its answer frozen", async () => {
		const seen: TaxRequest[] = [];
		const calc: TaxCalculator = {
			id: "acme.tax",
			async calculate(req) {
				seen.push(req);
				return {
					ok: true,
					currency: req.currency,
					lines: req.lines.map((l) => ({
						lineId: l.lineId,
						rateBps: 888,
						label: "NY",
						taxCents: cents(222),
					})),
					shipping: null,
				};
			},
		};
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(
			{ ...h.createDeps, taxCalculator: calc },
			command(cartId),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			purpose: "order",
			destination: { country: "US", region: "NY" },
		});
		expect(res.ok && res.order.totals).toMatchObject({
			tax: 222,
			total: 2500 + 500 + 222,
			taxBreakdown: {
				v: 1,
				calculatorId: "acme.tax",
				lines: [{ lineIndex: 0, rateBps: 888, label: "NY", taxCents: 222 }],
				shipping: null,
			},
		});
	});
});
