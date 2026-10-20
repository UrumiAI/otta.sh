/**
 * #420, end to end through the in-process client: an order priced while tax was
 * switched off hides the Tax row on its public read, as the review did; an order
 * priced with tax on keeps its row. Real document store (no mocks).
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	NEW_STORE_TAX_SETTINGS,
	productId as brandProductId,
	sku as brandSku,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import { afterEach, describe, expect, test } from "vitest";
import { buildOrderView } from "../src/storefront/checkout-view-model.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = currency("USD");
let h: InProcessCommerceHarness;
/** The placed order's stored tax snapshot, as the last `placedOrderView` left it. */
let placedSnapshot: unknown;

afterEach(async () => {
	await h.close();
});

async function placedOrderView(enabled: boolean) {
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
				enabled,
				// One "Tax" row, not one per rate (#422's itemized default): this
				// case is about tax on/off, not itemization.
				totalsDisplay: "single",
				baseAddress: { country: "GB", region: null },
			},
		},
		idempotencyKey("tax-setting"),
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
	const { cartId } = await h.client.createCart(USD);
	await h.client.addCartLine(cartId, "EBOOK", "ebook", 1, "add-1");
	const placed = await h.client.createOrder(
		{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
		`place-${cartId}`,
	);
	if (!placed.ok) throw new Error(placed.reason);
	placedSnapshot = (await h.stores.orderStore.getById(placed.order.id as never))?.totals
		.taxBreakdown;
	const read = await h.client.getPublicOrder(placed.order.id);
	if (!read.ok) throw new Error(read.reason);
	return buildOrderView(read.order, "en-US");
}

describe("an order's Tax row follows the tax setting it was priced under", () => {
	test("priced with tax off: no Tax row on the order page", async () => {
		const view = await placedOrderView(false);
		expect(view.totals.taxRows).toEqual([]);
		expect(view.totals.taxIncludedNote).toBeNull();
	});

	test("#478: priced with tax off, the order records no tax totals display (it shows no Tax row)", async () => {
		await placedOrderView(false);
		expect(placedSnapshot).toMatchObject({ v: 1, calculatorId: "otta.tax-disabled" });
		expect(placedSnapshot).not.toHaveProperty("totalsDisplay");
	});

	test("#478: priced with tax on, the order records the display it was placed under", async () => {
		await placedOrderView(true);
		expect(placedSnapshot).toMatchObject({ v: 1, totalsDisplay: "single" });
	});

	test("priced with tax on: the Tax row stays", async () => {
		const view = await placedOrderView(true);
		expect(view.totals.taxRows.map((r) => [r.label, r.amount.label])).toEqual([["Tax", "$10.00"]]);
	});
});
