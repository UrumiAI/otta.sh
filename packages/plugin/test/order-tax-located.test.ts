/**
 * ADR-0031, end to end through the in-process client: a digital-only cart taxed
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
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildOrderView } from "../src/storefront/checkout-view-model.js";
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
