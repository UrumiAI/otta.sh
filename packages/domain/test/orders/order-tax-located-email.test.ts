import {
	buildOrderEmailData,
	createOrderFromCart,
	idempotencyKey,
	NEW_STORE_TAX_SETTINGS,
	readOrderTaxSnapshot,
	renderEmail,
	type Order,
} from "@otta-sh/domain";
import { InMemorySettingsStore } from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";
import { makeOrderHarness } from "./fake-harness.js";

/**
 * ADR-0031: a digital-only cart is taxed at the shop base address. It has no
 * shipping zone (nothing ships), so "was tax calculated?" cannot be read off the
 * shipping snapshot: the order's tax snapshot records `located`, and the email
 * reads it — the tax charged is shown, never "Not calculated".
 */
async function placeDigitalAtBase(): Promise<Order> {
	const h = makeOrderHarness();
	await h.shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await h.taxRules.createClass({ id: "standard", name: "Standard" });
	await h.taxRules.createRate({
		id: "t-gb",
		taxClassId: "standard",
		zoneId: "z-gb",
		rateBps: 2000,
		appliesToShipping: true,
	});
	const settings = new InMemorySettingsStore();
	await settings.update(
		{
			tax: {
				...NEW_STORE_TAX_SETTINGS,
				enabled: true,
				baseAddress: { country: "GB", region: null },
			},
		},
		idempotencyKey("tax-on"),
	);
	await h.seedDigital({ productId: "ebook", sku: "EBOOK", priceCents: 5000, title: "E-book" });
	const cartId = await h.cartWith([{ sku: "EBOOK", productId: "ebook", qty: 1, kind: "digital" }]);
	const placed = await createOrderFromCart(
		{ ...h.createDeps, settings },
		{
			cartId,
			idempotencyKey: idempotencyKey("order-1"),
			buyerRef: "ada@example.com",
			paymentMethod: "stripe",
		},
	);
	if (!placed.ok) throw new Error(placed.reason);
	return placed.order;
}

const money = (minor: number, code: string): string => `${code} ${String(minor)}`;

describe("a digital cart taxed at the shop base address", () => {
	test("the order snapshot records located, with no shipping zone", async () => {
		const order = await placeDigitalAtBase();
		expect(order.totals.tax).toBe(1000);
		expect(order.totals.total).toBe(6000);
		expect(order.totals.shippingMethodSnapshot).toBeNull();
		const snapshot = readOrderTaxSnapshot(order.totals.taxBreakdown);
		expect(snapshot?.v === 1 && snapshot.located).toBe(true);
	});

	test("the email shows the tax charged, not 'Not calculated'", async () => {
		const order = await placeDigitalAtBase();
		const data = buildOrderEmailData(order, "paid");
		expect(data).toMatchObject({ taxCents: 1000, taxCalculated: true, totalCents: 6000 });
		const rendered = renderEmail("order-confirmation", data, { formatMoney: money });
		expect(rendered.text).toContain("Tax: USD 1000");
		expect(rendered.text).not.toMatch(/Tax: Not calculated/);
	});

	test("an older snapshot without `located` keeps the zone rule: tax reads as not calculated", async () => {
		const order = await placeDigitalAtBase();
		const { located: _drop, ...older } = order.totals.taxBreakdown as Record<string, unknown>;
		const old: Order = { ...order, totals: { ...order.totals, taxBreakdown: older } };
		expect(buildOrderEmailData(old, "paid")["taxCalculated"]).toBe(false);
	});
});
