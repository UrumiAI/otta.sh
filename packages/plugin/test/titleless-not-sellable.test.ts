/**
 * #109 / #156: a product with no commerce title is not for sale on ANY sell path.
 *
 * `createOrderFromCart` refuses a line whose product has a null title (an order
 * line snapshots it), so the add-to-cart guard and the checkout quote must refuse
 * the same product with the same `PRODUCT_NOT_PRICED` token. Otherwise a buyer
 * adds it, sees a priced review, enters their address and fails at the last step.
 *
 * Driven over a REAL document store through `InProcessCommerceClient`.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
let harness: InProcessCommerceHarness;
const gateways = { stripe: new FakePaymentGateway({ id: "stripe" }) };

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce({ gateways });
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

/** A published, priced, stocked product — titled only when `title` is given. */
async function seed(id: string, sku: string, title: string | null): Promise<void> {
	await harness.stores.productCommerce.upsert(
		{
			productId: toProductId(id),
			sku: toSku(sku),
			price: money(cents(1400), USD),
			...(title !== null ? { title } : {}),
			productKind: "digital",
		},
		toIdempotencyKey(`seed-${id}`),
	);
	await harness.stores.productCommerce.activate(
		toProductId(id),
		toIdempotencyKey(`publish-${id}`),
		"2026-01-01T00:00:00.000Z",
	);
}

describe("a product with no commerce title is not for sale", () => {
	test("the ADD refuses it PRODUCT_NOT_PRICED and holds nothing", async () => {
		await seed("p-untitled", "SKU-UNTITLED", null);
		const { cartId } = await harness.client.createCart(USD);
		const added = await harness.client.addCartLine(
			cartId,
			"SKU-UNTITLED",
			"p-untitled",
			1,
			"add-untitled",
		);
		expect(added).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
		expect(await harness.client.getCart(cartId)).toMatchObject({ ok: true, cart: { lines: [] } });
	});

	test("the QUOTE refuses a cart whose product lost its title after the add — the same answer the order gives", async () => {
		await seed("p-renamed", "SKU-RENAMED", "Otta Tee");
		const { cartId } = await harness.client.createCart(USD);
		const added = await harness.client.addCartLine(cartId, "SKU-RENAMED", "p-renamed", 1, "add-1");
		expect(added.ok).toBe(true);
		expect((await harness.client.quoteCheckout({ cartId })).ok).toBe(true);

		// The CMS sync clears the cache when the content no longer carries a title.
		await harness.stores.productCommerce.upsert(
			{ productId: toProductId("p-renamed"), sku: toSku("SKU-RENAMED"), title: null },
			toIdempotencyKey("untitle-p-renamed"),
		);

		expect(await harness.client.quoteCheckout({ cartId })).toEqual({
			ok: false,
			reason: "PRODUCT_NOT_PRICED",
		});
		const placed = await harness.client.createOrder(
			{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
			`place-${cartId}`,
		);
		expect(placed).toMatchObject({ ok: false, reason: "PRODUCT_NOT_PRICED" });
	});

	test("a TITLED product on the same path is still sold (the gate is not over-eager)", async () => {
		await seed("p-titled", "SKU-TITLED", "Otta Tee");
		const { cartId } = await harness.client.createCart(USD);
		const added = await harness.client.addCartLine(cartId, "SKU-TITLED", "p-titled", 1, "add-t");
		expect(added.ok).toBe(true);
		expect((await harness.client.quoteCheckout({ cartId })).ok).toBe(true);
	});
});
