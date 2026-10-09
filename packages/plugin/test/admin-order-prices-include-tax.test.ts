/**
 * The admin order detail says whether an order's prices were entered tax-inclusive,
 * read from the order's FROZEN tax snapshot (ADR-0030) and nothing else (#421).
 * Orders with no snapshot, an old-shape one, or one without the field carry no
 * flag: the answer is never guessed from today's store settings.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { afterAll, beforeEach, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce({});
	else await harness.reset();
});
afterAll(async () => {
	await harness?.close();
});

const snapshot = (extra: Record<string, unknown>) => ({
	v: 1,
	calculatorId: "otta.rate-table",
	lines: [
		{
			lineIndex: 0,
			taxClassId: "standard",
			taxableCents: 1500,
			rateBps: 1000,
			label: "VAT",
			taxCents: 136,
		},
	],
	shipping: null,
	...extra,
});

async function seed(id: string, taxBreakdown: unknown) {
	const oid = toOrderId(id);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Widget",
				unitPrice: cents(1500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: {
			subtotal: cents(1500),
			total: cents(1500),
			currency: USD,
			taxBreakdown,
		} as never,
	});
	const admin = new InProcessAdminOrdersClient(harness.ctx, { gateways: {} });
	const got = await admin.getOrder(id);
	return got?.order.totals.pricesIncludeTax;
}

test("a snapshot that recorded tax-inclusive prices flags the order", async () => {
	expect(await seed("o-incl", snapshot({ pricesIncludeTax: true }))).toBe(true);
});

test("a snapshot that recorded tax-exclusive prices carries no flag", async () => {
	expect(await seed("o-excl", snapshot({ pricesIncludeTax: false }))).toBeFalsy();
});

test("no snapshot, an old-shape one, or one lacking the field carries no flag", async () => {
	expect(await seed("o-none", null)).toBeFalsy();
	expect(await seed("o-v0", { lines: [], shippingTaxCents: 0 })).toBeFalsy();
	expect(await seed("o-nofield", snapshot({}))).toBeFalsy();
});
