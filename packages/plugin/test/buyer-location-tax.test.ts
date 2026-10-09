/**
 * Issue #426, end to end through the in-process client over a real document
 * store (no mocks): "Calculate tax based on: customer billing address". A cart
 * that ships nothing is priced, on the review, for the coarse location the
 * page sent (`destination` — for such a cart, where the buyer is), and the
 * order for the `billingLocation` the place sent; the order's frozen tax
 * snapshot says which address that was. Any other option leaves every reply
 * exactly as before.
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	NEW_STORE_TAX_SETTINGS,
	orderId as brandOrderId,
	productId as brandProductId,
	readOrderTaxSnapshot,
	sku as brandSku,
	type TaxSettings,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CommerceInputError } from "../src/commerce/commerce-input.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = currency("USD");
let h: InProcessCommerceHarness;
let seq = 0;

const SHOP_IN_GB: TaxSettings = {
	...NEW_STORE_TAX_SETTINGS,
	enabled: true,
	baseAddress: { country: "GB", region: null },
};
const BY_BUYER: TaxSettings = { ...SHOP_IN_GB, basedOn: "billing" };

async function saveTax(tax: TaxSettings): Promise<void> {
	await h.stores.settingsStore.update({ tax }, idempotencyKey(`tax-${seq++}`));
}

async function seed(id: string, sku: string, productKind: "digital" | "physical"): Promise<void> {
	await h.stores.productCommerce.upsert(
		{
			productId: brandProductId(id),
			sku: brandSku(sku),
			price: money(cents(5000), USD),
			title: id,
			productKind,
		},
		idempotencyKey(`seed-${id}`),
	);
	await h.stores.productCommerce.activate(
		brandProductId(id),
		idempotencyKey(`publish-${id}`),
		"2026-01-01T00:00:00.000Z",
	);
}

beforeEach(async () => {
	h = await makeInProcessCommerce({
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
	await h.stores.shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await h.stores.shippingRules.createZone({ id: "z-de", name: "Germany", regions: ["DE"] });
	await h.stores.taxRules.createClass({ id: "standard", name: "VAT" });
	for (const [zoneId, rateBps] of [
		["z-gb", 2000],
		["z-de", 1900],
	] as const) {
		await h.stores.taxRules.createRate({
			id: `t-${zoneId}`,
			taxClassId: "standard",
			zoneId,
			rateBps,
			appliesToShipping: true,
		});
	}
	await seed("ebook", "EBOOK", "digital");
});

afterEach(async () => {
	await h.close();
});

async function ebookCart(): Promise<string> {
	const { cartId } = await h.client.createCart(USD);
	const added = await h.client.addCartLine(cartId, "EBOOK", "ebook", 1, `add-${seq++}`);
	if (!added.ok) throw new Error(added.reason);
	return cartId;
}

describe("setting OFF: every reply exactly as before", () => {
	test("a digital cart's quote ignores the location: same reply, no buyer-location flag", async () => {
		await saveTax(SHOP_IN_GB);
		const cartId = await ebookCart();
		const plain = await h.client.quoteCheckout({ cartId });
		const located = await h.client.quoteCheckout({ cartId, destination: { country: "DE" } });
		expect(located).toEqual(plain);
		expect(located).not.toHaveProperty("taxByBuyerLocation");
		expect(located.ok && located.breakdown.taxCents).toBe(1000);
	});

	test("the order ignores a billing location: base-address tax, no tax address recorded", async () => {
		await saveTax(SHOP_IN_GB);
		const cartId = await ebookCart();
		const placed = await h.client.createOrder(
			{
				cartId,
				paymentMethod: "stripe",
				buyerRef: "ada@example.com",
				billingLocation: { country: "DE" },
			},
			`checkout:${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);
		const order = await h.stores.orderStore.getById(brandOrderId(placed.order.id));
		expect(order?.totals.tax).toBe(1000);
		expect(order?.totals.taxBreakdown).not.toHaveProperty("taxAddress");
	});
});

describe("setting ON: based on the customer's billing address", () => {
	test("the review is priced where the buyer is, and says it asks for that", async () => {
		await saveTax(BY_BUYER);
		const cartId = await ebookCart();
		const quote = await h.client.quoteCheckout({ cartId, destination: { country: "DE" } });
		if (!quote.ok) throw new Error(quote.reason);
		expect(quote.taxByBuyerLocation).toBe(true);
		expect(quote.breakdown).toMatchObject({ taxCents: 950, totalCents: 5950 });
		expect(quote.breakdown.tax?.located).toBe(true);
		// Before the buyer says where they are: the shop's base address, as before.
		const unplaced = await h.client.quoteCheckout({ cartId });
		if (!unplaced.ok) throw new Error(unplaced.reason);
		expect(unplaced.taxByBuyerLocation).toBe(true);
		expect(unplaced.breakdown.taxCents).toBe(1000);
	});

	test("the order is taxed at the same location, and its snapshot records it", async () => {
		await saveTax(BY_BUYER);
		const cartId = await ebookCart();
		const placed = await h.client.createOrder(
			{
				cartId,
				paymentMethod: "stripe",
				buyerRef: "ada@example.com",
				billingLocation: { country: "DE" },
			},
			`checkout:${cartId}`,
		);
		if (!placed.ok) throw new Error(placed.reason);
		const order = await h.stores.orderStore.getById(brandOrderId(placed.order.id));
		expect(order?.totals.tax).toBe(950);
		expect(readOrderTaxSnapshot(order?.totals.taxBreakdown)).toMatchObject({
			located: true,
			taxAddress: { basis: "billing", country: "DE", region: null },
		});
		const read = await h.client.getPublicOrder(placed.order.id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.totals).toMatchObject({ taxCents: 950, taxLocated: true });
	});

	test("a billing location that is not code-shaped is a malformed call, refused before anything", async () => {
		await saveTax(BY_BUYER);
		const cartId = await ebookCart();
		await expect(
			h.client.createOrder(
				{
					cartId,
					paymentMethod: "stripe",
					buyerRef: "ada@example.com",
					billingLocation: { country: "Germany" },
				},
				`checkout:${cartId}`,
			),
		).rejects.toBeInstanceOf(CommerceInputError);
	});

	test("a cart that ships is not asked where the buyer is", async () => {
		await saveTax(BY_BUYER);
		await seed("mug", "MUG", "physical");
		await h.stores.inventory.seedOnHand("MUG", 5);
		const { cartId } = await h.client.createCart(USD);
		const added = await h.client.addCartLine(cartId, "MUG", "mug", 1, `add-${seq++}`);
		if (!added.ok) throw new Error(added.reason);
		const quote = await h.client.quoteCheckout({ cartId, destination: { country: "GB" } });
		if (!quote.ok) throw new Error(quote.reason);
		expect(quote).not.toHaveProperty("taxByBuyerLocation");
	});
});
