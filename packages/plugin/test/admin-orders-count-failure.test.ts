/**
 * #601: a failing COUNT no longer blanks the Orders page.
 *
 * The page's caption is `countOrders`, the costlier of its two reads — a sku search
 * resolves every order that ever bought the sku — so past a store's query budget it
 * is the half that gives out first. It used to share a `Promise.all` with the list,
 * so its failure rejected the page and the console route answered the generic
 * "Orders are unavailable" banner, logging nothing. Now the list is served without
 * a total (the console captions it page-scoped) and the count's error is logged; a
 * failing LIST still fails the page, and the route now logs what it swallowed.
 *
 * Driven over a REAL document store, with only the `orders` collection's `count`
 * (and, for the last case, `query`) made to throw.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import { ORDERS_COLLECTION, type StorageAccess } from "@urumi.ai/otta-store-emdash";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { createOrdersConsoleHandler } from "../src/admin/orders-console-route.js";
import type { PluginContext } from "../src/types.js";
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

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

async function seed(id: string): Promise<void> {
	await harness.stores.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku("SKU-COUNT"),
				title: "Item",
				unitPrice: cents(1000),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: USD },
	});
}

/** The harness context with the `orders` collection's named methods throwing. */
function failing(methods: readonly string[]): PluginContext {
	const storage = harness.ctx.storage as unknown as StorageAccess;
	const orders = storage[ORDERS_COLLECTION]!;
	const broken = new Proxy(orders, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof prop === "string" && methods.includes(prop)) {
				return () => Promise.reject(new Error(`injected ${prop} failure`));
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		...harness.ctx,
		storage: { ...storage, [ORDERS_COLLECTION]: broken },
	} as unknown as PluginContext;
}

function consoleList(ctx: PluginContext): Promise<Record<string, unknown>> {
	return createOrdersConsoleHandler()(
		{ input: { type: "otta_console_read", resource: "orders.list" } } as never,
		ctx,
	) as Promise<Record<string, unknown>>;
}

test("a count that throws still serves the page's rows, with NO total, and logs the error", async () => {
	await seed("ord-count-a");
	await seed("ord-count-b");
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});

	const page = await new InProcessAdminOrdersClient(failing(["count"]), { gateways }).listOrders(
		{},
	);

	expect(page.orders.map((o) => o.id).toSorted()).toEqual(["ord-count-a", "ord-count-b"]);
	// Absent, never `0`: a page of rows is not captioned with a count of none.
	expect("total" in page).toBe(false);
	expect(logged).toHaveBeenCalledWith("[otta] orders count failed:", expect.any(Error));
});

test("the console route renders that page too, rather than the unavailable banner", async () => {
	await seed("ord-count-route");
	vi.spyOn(console, "error").mockImplementation(() => {});

	const result = await consoleList(failing(["count"]));

	expect(result["ok"]).toBe(true);
	expect((result["orders"] as Array<{ id: string }>).map((o) => o.id)).toEqual(["ord-count-route"]);
	expect("total" in result).toBe(false);
});

test("a healthy store still captions the page with its exact total", async () => {
	await seed("ord-count-ok");
	const result = await consoleList(harness.ctx);
	expect(result["ok"]).toBe(true);
	expect(result["total"]).toBe(1);
});

test("a LIST that throws still fails the page closed — and the route now logs why", async () => {
	await seed("ord-count-down");
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});

	const result = await consoleList(failing(["query", "count"]));

	expect(result["ok"]).toBe(false);
	expect(result["title"]).toBe("Orders are unavailable");
	expect(logged).toHaveBeenCalledWith("[otta] orders console failed:", expect.any(Error));
});
