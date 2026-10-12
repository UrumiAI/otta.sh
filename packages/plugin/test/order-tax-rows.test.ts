/**
 * Issue #422, end to end through the in-process clients: an order's frozen tax
 * snapshot reaches the buyer's order pages, the order emails and the admin order
 * detail as ONE row per tax (the domain's `orderTaxRows`), by the store's
 * "Display tax totals" — itemized or a single Tax row. The admin always itemizes,
 * as WooCommerce's order screen does. Older orders keep the single total.
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
	email as toEmail,
	type EmailTemplate,
	type TaxSettings,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { makeEmailSender } from "../src/email/ctx-email-sender.js";
import { buildOrderView } from "../src/storefront/checkout-view-model.js";
import type { PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = currency("USD");
const gateways = { stripe: new FakePaymentGateway({ id: "stripe" }) };
let h: InProcessCommerceHarness;

async function seedProduct(id: string, sku: string, priceCents: number, taxClassId: string) {
	await h.stores.productCommerce.upsert(
		{
			productId: brandProductId(id),
			sku: brandSku(sku),
			price: money(cents(priceCents), USD),
			title: id,
			productKind: "digital",
			taxClass: taxClassId,
		},
		idempotencyKey(`seed-${id}`),
	);
	await h.stores.productCommerce.activate(
		brandProductId(id),
		idempotencyKey(`publish-${id}`),
		"2026-01-01T00:00:00.000Z",
	);
}

async function saveTax(over: Partial<TaxSettings>, key: string) {
	await h.stores.settingsStore.update(
		{
			tax: {
				...NEW_STORE_TAX_SETTINGS,
				enabled: true,
				baseAddress: { country: "IN", region: null },
				...over,
			},
		},
		idempotencyKey(key),
	);
}

beforeEach(async () => {
	h = await makeInProcessCommerce({ gateways });
	await h.stores.shippingRules.createZone({ id: "z-in", name: "India", regions: ["IN"] });
	await h.stores.taxRules.createClass({ id: "gst18", name: "GST 18%" });
	await h.stores.taxRules.createClass({ id: "gst5", name: "GST 5%" });
	await h.stores.taxRules.createRate({
		id: "t-18",
		taxClassId: "gst18",
		zoneId: "z-in",
		rateBps: 1800,
		appliesToShipping: false,
	});
	await h.stores.taxRules.createRate({
		id: "t-5",
		taxClassId: "gst5",
		zoneId: "z-in",
		rateBps: 500,
		appliesToShipping: false,
	});
	await saveTax({}, "tax-on");
	await seedProduct("course", "COURSE", 10_000, "gst18");
	await seedProduct("ebook", "EBOOK", 5000, "gst5");
});

afterEach(async () => {
	await h.close();
});

/** Two lines at two rates: 1800 + 250 tax on 15,000. */
async function placeOrder(key: string, customer?: { token: string }): Promise<string> {
	const { cartId } = await h.client.createCart(USD);
	expect((await h.client.addCartLine(cartId, "COURSE", "course", 1, `${key}-a`)).ok).toBe(true);
	expect((await h.client.addCartLine(cartId, "EBOOK", "ebook", 1, `${key}-b`)).ok).toBe(true);
	const placed = await h.client.createOrder(
		{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
		`place-${key}`,
		...(customer !== undefined ? [{ sessionToken: customer.token }] : []),
	);
	if (!placed.ok) throw new Error(placed.reason);
	expect(placed.order.totals.taxCents).toBe(2050);
	return placed.order.id;
}

/** Rows in order-line order; the cart's line order is not the test's subject. */
function rowsOf(view: ReturnType<typeof buildOrderView>): string[][] {
	return view.totals.taxRows.map((r) => [r.label, r.amount.label]).toSorted();
}

const ITEMIZED = [
	["GST 18%", "$18.00"],
	["GST 5%", "$2.50"],
];

describe("the buyer's order pages", () => {
	test("itemized: one row per tax on the public order page, adding up to the tax total", async () => {
		const id = await placeOrder("pub");
		const read = await h.client.getPublicOrder(id);
		if (!read.ok) throw new Error(read.reason);
		const view = buildOrderView(read.order, "en-US");
		expect(rowsOf(view)).toEqual(ITEMIZED);
		expect(view.totals.total.label).toBe("$170.50");
	});

	test("itemized: the account's own order page shows the same rows", async () => {
		const customer = await h.stores.customerStore.create({ email: toEmail("ada@example.com") });
		const session = await h.stores.sessionStore.create(customer.id);
		const id = await placeOrder("acct", session);
		const read = await h.client.getMyOrder(session.token, id);
		if (!read.ok) throw new Error(read.reason);
		const view = buildOrderView(read.order as never, "en-US");
		expect(rowsOf(view)).toEqual(ITEMIZED);
	});

	test("single: one Tax row with the total", async () => {
		const id = await placeOrder("single");
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const read = await h.client.getPublicOrder(id);
		if (!read.ok) throw new Error(read.reason);
		const view = buildOrderView(read.order, "en-US");
		expect(view.totals.taxRows.map((r) => [r.label, r.amount.label])).toEqual([["Tax", "$20.50"]]);
	});

	test("an older order with no tax snapshot keeps the single Tax row", async () => {
		const id = await placeOrder("old");
		await stripSnapshot(id);
		const read = await h.client.getPublicOrder(id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.totals.tax).toBeUndefined();
		const view = buildOrderView(read.order, "en-US");
		expect(view.totals.taxRows.map((r) => r.label)).toEqual(["Tax"]);
	});
});

describe("the order emails", () => {
	function emailCtx(sent: Array<{ text: string; html: string }>): PluginContext {
		return {
			...h.ctx,
			email: {
				async send(message: { text: string; html: string }) {
					sent.push(message);
				},
			},
		} as unknown as PluginContext;
	}

	async function render(id: string): Promise<string> {
		const sent: Array<{ text: string; html: string }> = [];
		const sender = await makeEmailSender(emailCtx(sent));
		const order = await h.stores.orderStore.getById(id as never);
		if (order === null) throw new Error("no order");
		const { buildOrderEmailData } = await import("@otta-sh/domain");
		await sender?.send({
			to: toEmail("ada@example.com"),
			template: "order-confirmation" as EmailTemplate,
			data: buildOrderEmailData(order, "paid"),
			idempotencyKey: "row-1",
		});
		return sent[0]?.text ?? "";
	}

	test("itemized: the email lists one row per tax", async () => {
		const text = await render(await placeOrder("mail"));
		expect(text).toMatch(/^GST 18%: \$18\.00$/m);
		expect(text).toMatch(/^GST 5%: \$2\.50$/m);
		expect(text).not.toMatch(/^Tax:/m);
	});

	test("single: the email keeps the one Tax row", async () => {
		const id = await placeOrder("mail-single");
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const text = await render(id);
		expect(text).toContain("Tax: $20.50");
		expect(text).not.toContain("GST 18%");
	});
});

describe("the admin order detail", () => {
	test("always itemized — even when the buyer's surfaces show a single row", async () => {
		const id = await placeOrder("admin");
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const detail = await new InProcessAdminOrdersClient(h.ctx, { gateways }).getOrder(id);
		expect(detail?.order.totals.taxCents).toBe(2050);
		expect(
			detail?.order.totals.taxRows?.toSorted((a, b) => a.label.localeCompare(b.label)),
		).toEqual([
			{ label: "GST 18%", amountCents: 1800 },
			{ label: "GST 5%", amountCents: 250 },
		]);
	});

	test("an older order with no tax snapshot carries no rows (the single Tax row)", async () => {
		const id = await placeOrder("admin-old");
		await stripSnapshot(id);
		const detail = await new InProcessAdminOrdersClient(h.ctx, { gateways }).getOrder(id);
		expect(detail?.order.totals).not.toHaveProperty("taxRows");
	});
});

/** Rewrite the stored order as one written before ADR-0030: no tax snapshot. */
async function stripSnapshot(id: string): Promise<void> {
	const { collectionOf, ORDERS_COLLECTION } = await import("@otta-sh/store-emdash");
	const orders = collectionOf<Record<string, unknown>>(h.ctx.storage as never, ORDERS_COLLECTION);
	const doc = await orders.getVersioned(id);
	if (doc === null) throw new Error("no order doc");
	const value = structuredClone(doc.value) as { totals: Record<string, unknown> };
	value.totals["taxBreakdown"] = null;
	await orders.compareAndSet(id, doc.revision, value as never);
}
