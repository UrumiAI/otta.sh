/**
 * ADR-0032, end to end through the in-process client: a digital-only cart taxed
 * at the shop base address. The checkout review shows the tax; after the order
 * is placed its public read must say the same — the order has no shipping zone
 * (nothing ships), so the wire carries `taxLocated` off the order's frozen tax
 * snapshot and the order page shows the tax charged, never "Not calculated".
 *
 * Real document store (no mocks).
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	NEW_STORE_TAX_SETTINGS,
	productId as brandProductId,
	sku as brandSku,
	type TaxCalculator,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildCheckoutTotals, buildOrderView } from "../src/storefront/checkout-view-model.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = currency("USD");
let h: InProcessCommerceHarness;

beforeEach(async () => {
	h = await makeInProcessCommerce({
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
	await h.stores.shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await h.stores.taxRules.createClass({ id: "standard", name: "Standard" });
	await h.stores.taxRules.createRate({
		id: "t-gb",
		taxClassId: "standard",
		zoneId: "z-gb",
		rateBps: 2000,
		appliesToShipping: true,
	});
	await h.stores.settingsStore.update(
		{
			tax: {
				...NEW_STORE_TAX_SETTINGS,
				enabled: true,
				baseAddress: { country: "GB", region: null },
			},
		},
		idempotencyKey("tax-on"),
	);
	await h.stores.productCommerce.upsert(
		{
			productId: brandProductId("ebook"),
			sku: brandSku("EBOOK"),
			price: money(cents(5000), USD),
			title: "E-book",
			productKind: "digital",
		},
		idempotencyKey("seed"),
	);
	await h.stores.productCommerce.activate(
		brandProductId("ebook"),
		idempotencyKey("publish"),
		"2026-01-01T00:00:00.000Z",
	);
});

afterEach(async () => {
	await h.close();
});

describe("a digital cart taxed at the shop base address", () => {
	test("the review and the placed order's page both show the tax", async () => {
		const { cartId } = await h.client.createCart(USD);
		const added = await h.client.addCartLine(cartId, "EBOOK", "ebook", 1, "add-1");
		expect(added.ok).toBe(true);

		const quote = await h.client.quoteCheckout({ cartId });
		if (!quote.ok) throw new Error(quote.reason);
		expect(quote.breakdown).toMatchObject({ taxCents: 1000, totalCents: 6000 });
		expect(quote.breakdown.tax?.located).toBe(true);

		const placed = await h.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
			`place-${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);

		const read = await h.client.getPublicOrder(placed.order.id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.totals).toMatchObject({
			shippingZoneId: null,
			taxCents: 1000,
			totalCents: 6000,
			taxLocated: true,
		});
		const view = buildOrderView(read.order, "en-US");
		expect(view.totals.tax.label).toBe("$10.00");
		expect(view.totals.taxRows.map((r) => [r.label, r.amount.label])).toEqual([["Tax", "$10.00"]]);
	});
});

/**
 * Issue #436: a store whose outside tax calculator charges tax but which has NO
 * shipping zones. The calculator answers for the ship-to itself, so the tax is
 * located; the review and the order page show it, not "Not calculated".
 */
describe("an outside calculator charging tax on a store with no shipping zones", () => {
	const calc: TaxCalculator = {
		id: "acme.tax",
		async calculate(req) {
			return {
				ok: true,
				currency: req.currency,
				lines: req.lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 1000,
					label: "VAT",
					taxCents: cents(500),
				})),
				shipping: null,
			};
		},
	};
	let z: InProcessCommerceHarness;

	beforeEach(async () => {
		z = await makeInProcessCommerce({
			gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
			taxCalculator: calc,
		});
		await z.stores.settingsStore.update(
			{ tax: { ...NEW_STORE_TAX_SETTINGS, enabled: true } },
			idempotencyKey("tax-on"),
		);
		await z.client.upsertProductCommerce(
			"mug",
			{
				sku: "MUG",
				title: "Mug",
				price: { amount: 5000, currency: "USD" },
				productKind: "physical",
				initialOnHand: 5,
			},
			"seed-mug",
		);
		await z.client.activateProductCommerce("mug", "publish-mug", "2026-01-01T00:00:00.000Z");
	});

	afterEach(async () => {
		await z.close();
	});

	test("the review and the placed order's page both show the tax", async () => {
		const { cartId } = await z.client.createCart(USD);
		const added = await z.client.addCartLine(cartId, "MUG", "mug", 1, "add-1");
		expect(added.ok).toBe(true);

		const quote = await z.client.quoteCheckout({ cartId, destination: { country: "GB" } });
		if (!quote.ok) throw new Error(quote.reason);
		expect(quote.destination.status).toBe("no_zones");
		expect(quote.breakdown).toMatchObject({ taxCents: 500, totalCents: 5500 });
		expect(quote.breakdown.tax?.located).toBe(true);
		// The review's flags for a store with no zones (checkout-routes): no
		// method, no matched zone — the calculator's answer alone locates the tax.
		const review = buildCheckoutTotals(quote.breakdown, {
			locale: "en-US",
			shippingSelected: false,
			taxZoneSelected: false,
		});
		expect(review.tax.label).toBe("$5.00");

		const placed = await z.client.createOrder(
			{
				cartId,
				paymentMethod: "stripe",
				buyerRef: "ada@example.com",
				shippingAddress: {
					name: "Ada Lovelace",
					line1: "1 Main St",
					city: "London",
					postalCode: "N1 1AA",
					country: "GB",
				},
			},
			`place-${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);

		const read = await z.client.getPublicOrder(placed.order.id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.totals).toMatchObject({
			shippingZoneId: null,
			taxCents: 500,
			taxLocated: true,
		});
		const view = buildOrderView(read.order, "en-US");
		expect(view.totals.tax.label).toBe("$5.00");
	});
});
