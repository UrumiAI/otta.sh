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
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
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
async function placeOrder(
	key: string,
	customer?: { token: string },
	expectedTaxCents = 2050,
): Promise<string> {
	const { cartId } = await h.client.createCart(USD);
	expect((await h.client.addCartLine(cartId, "COURSE", "course", 1, `${key}-a`)).ok).toBe(true);
	expect((await h.client.addCartLine(cartId, "EBOOK", "ebook", 1, `${key}-b`)).ok).toBe(true);
	const placed = await h.client.createOrder(
		{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
		`place-${key}`,
		...(customer !== undefined ? [{ sessionToken: customer.token }] : []),
	);
	if (!placed.ok) throw new Error(placed.reason);
	expect(placed.order.totals.taxCents).toBe(expectedTaxCents);
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
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const id = await placeOrder("single");
		const read = await h.client.getPublicOrder(id);
		if (!read.ok) throw new Error(read.reason);
		const view = buildOrderView(read.order, "en-US");
		expect(view.totals.taxRows.map((r) => [r.label, r.amount.label])).toEqual([["Tax", "$20.50"]]);
	});

	test("prices entered WITH tax: the wire itemizes the tax inside the prices, and the page shows a net subtotal that still sums to the total", async () => {
		await saveTax({ pricesIncludeTax: true }, "tax-incl");
		// Gross 10,000 at 18% holds 1525 (half down); gross 5000 at 5% holds 238.
		const id = await placeOrder("incl", undefined, 1763);
		const read = await h.client.getPublicOrder(id);
		if (!read.ok) throw new Error(read.reason);
		expect(read.order.totals.totalCents).toBe(15_000);
		expect(read.order.totals.tax).toMatchObject({
			pricesIncludeTax: true,
			totalsDisplay: "itemized",
			lineTaxCents: 1763,
		});
		expect(
			read.order.totals.tax?.itemized.toSorted((a, b) => a.label.localeCompare(b.label)),
		).toEqual([
			{ label: "GST 18%", amountCents: 1525 },
			{ label: "GST 5%", amountCents: 238 },
		]);
		const view = buildOrderView(read.order, "en-US");
		expect(rowsOf(view)).toEqual([
			["GST 18%", "$15.25"],
			["GST 5%", "$2.38"],
		]);
		// Net subtotal: 15,000 gross less the 1763 tax inside it.
		expect(view.totals.subtotal.money?.amount).toBe(13_237);
		const rowsSum = view.totals.taxRows.reduce((s, r) => s + (r.amount.money?.amount ?? 0), 0);
		expect((view.totals.subtotal.money?.amount ?? 0) + rowsSum).toBe(
			view.totals.total.money?.amount,
		);
		expect(view.totals.total.label).toBe("$150.00");
	});

	test("#478: a placed order keeps the display it was placed under, whatever the option says later", async () => {
		const itemized = await placeOrder("kept-itemized");
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const single = await placeOrder("kept-single");
		await saveTax({ totalsDisplay: "itemized" }, "tax-itemized-again");
		await saveTax({ totalsDisplay: "single" }, "tax-single-again");
		const pub = await h.client.getPublicOrder(itemized);
		if (!pub.ok) throw new Error(pub.reason);
		expect(rowsOf(buildOrderView(pub.order, "en-US"))).toEqual(ITEMIZED);
		await saveTax({ totalsDisplay: "itemized" }, "tax-itemized-last");
		const one = await h.client.getPublicOrder(single);
		if (!one.ok) throw new Error(one.reason);
		expect(
			buildOrderView(one.order, "en-US").totals.taxRows.map((r) => [r.label, r.amount.label]),
		).toEqual([["Tax", "$20.50"]]);
	});

	test("#478: the account's order page keeps the placed display too", async () => {
		const customer = await h.stores.customerStore.create({ email: toEmail("ada@example.com") });
		const session = await h.stores.sessionStore.create(customer.id);
		const id = await placeOrder("acct-kept", session);
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const read = await h.client.getMyOrder(session.token, id);
		if (!read.ok) throw new Error(read.reason);
		expect(rowsOf(buildOrderView(read.order as never, "en-US"))).toEqual(ITEMIZED);
	});

	test("#478: an order placed before the display was recorded follows the live option", async () => {
		const id = await placeOrder("unrecorded");
		await stripRecordedDisplay(id);
		const before = await h.client.getPublicOrder(id);
		if (!before.ok) throw new Error(before.reason);
		expect(rowsOf(buildOrderView(before.order, "en-US"))).toEqual(ITEMIZED);
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const after = await h.client.getPublicOrder(id);
		if (!after.ok) throw new Error(after.reason);
		expect(
			buildOrderView(after.order, "en-US").totals.taxRows.map((r) => [r.label, r.amount.label]),
		).toEqual([["Tax", "$20.50"]]);
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
		const { buildOrderEmailData } = await import("@urumi.ai/otta-domain");
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
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const id = await placeOrder("mail-single");
		const text = await render(id);
		expect(text).toContain("Tax: $20.50");
		expect(text).not.toContain("GST 18%");
	});

	test("#478: an order's email keeps the display it was placed under, whatever the option says later", async () => {
		const itemized = await placeOrder("mail-kept-itemized");
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const single = await placeOrder("mail-kept-single");
		const kept = await render(itemized);
		expect(kept).toMatch(/^GST 18%: \$18\.00$/m);
		expect(kept).not.toMatch(/^Tax:/m);
		await saveTax({ totalsDisplay: "itemized" }, "tax-itemized-again");
		const one = await render(single);
		expect(one).toContain("Tax: $20.50");
		expect(one).not.toContain("GST 18%");
	});

	test("#478: an order placed before the display was recorded emails by the live option", async () => {
		const id = await placeOrder("mail-unrecorded");
		await stripRecordedDisplay(id);
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const text = await render(id);
		expect(text).toContain("Tax: $20.50");
		expect(text).not.toContain("GST 18%");
	});
});

describe("#502: the order emails read the live option only for an order that recorded none", () => {
	/** `h.ctx` with `ctx.email` and its settings collection's `get` counted —
	 *  or failing, when `failing` is set. */
	function countedCtx(failing = false) {
		const counter = { settingsReads: 0 };
		const storage = h.ctx.storage as unknown as Record<string, Record<string, unknown>>;
		const settings = storage["settings"];
		if (settings === undefined) throw new Error("no settings collection");
		const countedSettings = new Proxy(settings, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (prop !== "get" || typeof value !== "function") return value;
				return (...args: unknown[]) => {
					counter.settingsReads++;
					if (failing) return Promise.reject(new Error("settings unreadable"));
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		const sent: Array<{ text: string }> = [];
		const ctx = {
			...h.ctx,
			storage: new Proxy(storage, {
				get: (target, prop, receiver) =>
					prop === "settings" ? countedSettings : Reflect.get(target, prop, receiver),
			}),
			email: {
				async send(message: { text: string }) {
					sent.push(message);
				},
			},
		} as unknown as PluginContext;
		return { ctx, counter, sent };
	}

	async function sendFor(
		sender: Awaited<ReturnType<typeof makeEmailSender>>,
		id: string,
	): Promise<void> {
		const order = await h.stores.orderStore.getById(id as never);
		if (order === null) throw new Error("no order");
		const { buildOrderEmailData } = await import("@urumi.ai/otta-domain");
		await sender?.send({
			to: toEmail("ada@example.com"),
			template: "order-confirmation" as EmailTemplate,
			data: buildOrderEmailData(order, "paid"),
			idempotencyKey: `row-${id}`,
		});
	}

	test("building the sender reads nothing; an order that recorded its display never triggers the read", async () => {
		const recorded = await placeOrder("lazy-recorded");
		const { ctx, counter, sent } = countedCtx();
		const sender = await makeEmailSender(ctx);
		expect(counter.settingsReads).toBe(0);
		await sendFor(sender, recorded);
		await sendFor(sender, recorded);
		expect(counter.settingsReads).toBe(0);
		expect(sent).toHaveLength(2);
		expect(sent[0]?.text).toMatch(/^GST 18%: \$18\.00$/m);
	});

	test("an order with nothing recorded reads the live option — once per sender", async () => {
		const first = await placeOrder("lazy-unrecorded-1");
		const second = await placeOrder("lazy-unrecorded-2");
		await stripRecordedDisplay(first);
		await stripRecordedDisplay(second);
		await saveTax({ totalsDisplay: "single" }, "tax-single");
		const { ctx, counter, sent } = countedCtx();
		const sender = await makeEmailSender(ctx);
		await Promise.all([sendFor(sender, first), sendFor(sender, second)]);
		await sendFor(sender, first);
		expect(counter.settingsReads).toBe(1);
		expect(sent).toHaveLength(3);
		for (const message of sent) {
			expect(message.text).toContain("Tax: $20.50");
			expect(message.text).not.toContain("GST 18%");
		}
	});

	test("the live option it reads is the one the email renders (itemized, not the single-row fallback)", async () => {
		const id = await placeOrder("lazy-unrecorded-itemized");
		await stripRecordedDisplay(id);
		const { ctx, counter, sent } = countedCtx();
		const sender = await makeEmailSender(ctx);
		await sendFor(sender, id);
		expect(counter.settingsReads).toBe(1);
		expect(sent[0]?.text).toMatch(/^GST 18%: \$18\.00$/m);
		expect(sent[0]?.text).not.toMatch(/^Tax:/m);
	});

	test("an unreadable option still sends, with the single Tax row (fail-soft, as before)", async () => {
		const id = await placeOrder("lazy-unreadable");
		await stripRecordedDisplay(id);
		const { ctx, counter, sent } = countedCtx(true);
		const sender = await makeEmailSender(ctx);
		await sendFor(sender, id);
		expect(counter.settingsReads).toBe(1);
		expect(sent[0]?.text).toContain("Tax: $20.50");
		expect(sent[0]?.text).not.toContain("GST 18%");
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
	const { collectionOf, ORDERS_COLLECTION } = await import("@urumi.ai/otta-store-emdash");
	const orders = collectionOf<Record<string, unknown>>(h.ctx.storage as never, ORDERS_COLLECTION);
	const doc = await orders.getVersioned(id);
	if (doc === null) throw new Error("no order doc");
	const value = structuredClone(doc.value) as { totals: Record<string, unknown> };
	value.totals["taxBreakdown"] = null;
	await orders.compareAndSet(id, doc.revision, value as never);
}

/** Rewrite the stored order's tax snapshot as one written before #478: no
 *  recorded "Display tax totals". */
async function stripRecordedDisplay(id: string): Promise<void> {
	const { collectionOf, ORDERS_COLLECTION } = await import("@urumi.ai/otta-store-emdash");
	const orders = collectionOf<Record<string, unknown>>(h.ctx.storage as never, ORDERS_COLLECTION);
	const doc = await orders.getVersioned(id);
	if (doc === null) throw new Error("no order doc");
	const value = structuredClone(doc.value) as {
		totals: { taxBreakdown: Record<string, unknown> };
	};
	expect(value.totals.taxBreakdown).toHaveProperty("totalsDisplay");
	delete value.totals.taxBreakdown["totalsDisplay"];
	await orders.compareAndSet(id, doc.revision, value as never);
}
