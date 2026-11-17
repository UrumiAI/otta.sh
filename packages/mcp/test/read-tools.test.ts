/**
 * The read-only tools, driven through `withMcp`'s routes over a real SQLite
 * document store with one product, one order and one coupon seeded.
 */
import { createOttaPlugin, STRIPE_WEBHOOK_SECRET_KEY } from "@urumi.ai/otta-plugin";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OTTA_MCP_TOOLS, withMcp, type McpRouteEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";
import { SEED, seedStore } from "./helpers/seed.js";

let harness: AdminHarness;
const plugin = withMcp(createOttaPlugin());

beforeAll(async () => {
	harness = await makeAdminHarness();
	await seedStore(harness.ctx);
});
afterAll(async () => {
	await harness?.close();
});

/** Call a tool the way EmDash does, resolving to its result or its thrown error. */
async function call(name: string, input: unknown = {}): Promise<any> {
	const route = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
	if (route === undefined) throw new Error(`no route mcp/${name}`);
	return route.handler(
		{ input, request: new Request("http://x"), user: { name: "Ada" } } as never,
		harness.ctx,
	);
}

async function failure(name: string, input: unknown = {}): Promise<{ code: string }> {
	try {
		await call(name, input);
	} catch (e) {
		return e as { code: string };
	}
	throw new Error(`${name} did not fail`);
}

test("the read tools are all in the table", () => {
	const names = OTTA_MCP_TOOLS.map((t) => t.name);
	expect(names).toEqual([
		"products_list",
		"products_get",
		"products_low_stock",
		"orders_list",
		"orders_get",
		"coupons_list",
		"coupons_get",
		"shipping_zones_list",
		"shipping_methods_list",
		"shipping_rate_get",
		"tax_settings_get",
		"tax_classes_list",
		"tax_rates_list",
		"reports_revenue",
		"reports_orders_by_status",
		"reports_top_products",
		"settings_get",
	]);
	for (const tool of OTTA_MCP_TOOLS) {
		expect(tool.destructive ?? false).toBe(false);
		expect(tool.description.length).toBeGreaterThan(40);
	}
});

describe("products", () => {
	test("products_list returns summaries and a cursor slot", async () => {
		const out = await call("products_list", {});
		expect(out.nextCursor).toBeNull();
		expect(out.items).toHaveLength(1);
		expect(out.items[0]).toMatchObject({
			productId: SEED.productId,
			sku: SEED.sku,
			priceCents: SEED.priceCents,
			currency: "USD",
			onHand: SEED.onHand,
		});
	});
	test("products_list honours query and limit", async () => {
		expect((await call("products_list", { query: "nothing-matches" })).items).toEqual([]);
		expect((await call("products_list", { limit: 1 })).items).toHaveLength(1);
		expect((await failure("products_list", { limit: 0 })).code).toBe("INVALID_INPUT");
	});
	test("products_list refuses a cursor that does not belong", async () => {
		expect((await failure("products_list", { cursor: "garbage" })).code).toBe("INVALID_CURSOR");
	});
	test("products_get returns the product", async () => {
		const out = await call("products_get", { productId: SEED.productId });
		expect(out).toMatchObject({ productId: SEED.productId });
	});
	test("products_get on an unknown id is NOT_FOUND", async () => {
		expect((await failure("products_get", { productId: "nope" })).code).toBe("NOT_FOUND");
	});
	test("products_low_stock lists skus at or below the threshold", async () => {
		const low = await call("products_low_stock", { threshold: 10 });
		expect(low.items).toEqual([{ sku: SEED.sku, onHand: SEED.onHand, title: SEED.title }]);
		expect((await call("products_low_stock", { threshold: 1 })).items).toEqual([]);
	});
});

describe("orders", () => {
	test("orders_list returns summaries, filtered by status and query", async () => {
		const all = await call("orders_list", {});
		expect(all.items).toHaveLength(1);
		expect(all.items[0]).toMatchObject({
			id: SEED.orderId,
			totalCents: SEED.orderTotalCents,
			currency: "USD",
		});
		expect(
			(await call("orders_list", { status: "paid" })).items.length +
				(await call("orders_list", { status: "pending" })).items.length,
		).toBeGreaterThanOrEqual(1);
		expect((await call("orders_list", { status: "cancelled" })).items).toEqual([]);
	});
	test("orders_get returns detail, customer, timeline, refunds with refundedSoFarCents, and notes", async () => {
		const out = await call("orders_get", { orderId: SEED.orderId });
		expect(out.order).toMatchObject({ id: SEED.orderId });
		expect(Array.isArray(out.allowedTransitions)).toBe(true);
		expect(out).toHaveProperty("customer");
		expect(out).toHaveProperty("timeline");
		expect(out.notes).toEqual([]);
		expect(out.refunds.refundedSoFarCents).toBe(SEED.refundedCents);
		expect(out.refunds.refundedSoFarCents).toBe(out.refunds.finalizedTotalCents);
		expect(out.refunds.refunds).toHaveLength(1);
	});
	test("orders_get on an unknown id is NOT_FOUND", async () => {
		expect((await failure("orders_get", { orderId: "nope" })).code).toBe("NOT_FOUND");
	});
});

describe("coupons", () => {
	test("coupons_list / coupons_get return the seeded coupon", async () => {
		const list = await call("coupons_list", {});
		expect(list.items).toHaveLength(1);
		expect(list.items[0]).toMatchObject({ code: SEED.couponCode });
		expect((await call("coupons_list", { query: SEED.couponCode })).items).toHaveLength(1);
		expect(await call("coupons_get", { code: SEED.couponCode })).toMatchObject({
			id: SEED.couponId,
			code: SEED.couponCode,
			amountCents: 500,
		});
	});
	test("coupons_get on an unknown code is NOT_FOUND", async () => {
		expect((await failure("coupons_get", { code: "NOPE" })).code).toBe("NOT_FOUND");
	});
});

describe("shipping and tax", () => {
	let zoneId = "";
	let methodId = "";
	beforeAll(async () => {
		const { makeAdminClients } = await import("@urumi.ai/otta-plugin");
		const clients = await makeAdminClients(harness.ctx);
		const z = await clients.rules.createZone({ id: "z1", name: "Domestic", regions: ["US"] });
		if (!z.ok) throw new Error(JSON.stringify(z));
		zoneId = "z1";
		const m = await clients.rules.createMethod(zoneId, {
			id: "m1",
			name: "Ground",
			type: "flat_rate",
		});
		if (!m.ok) throw new Error(JSON.stringify(m));
		methodId = "m1";
		const r = await clients.rules.createRate(methodId, { currency: "USD", amountCents: 700 });
		if (!r.ok) throw new Error(JSON.stringify(r));
	});
	test("zones, methods and rate", async () => {
		expect((await call("shipping_zones_list")).items.map((z: any) => z.id)).toContain(zoneId);
		expect((await call("shipping_methods_list", { zoneId })).items.map((m: any) => m.id)).toEqual([
			methodId,
		]);
		expect(await call("shipping_rate_get", { methodId, currency: "USD" })).toMatchObject({
			amountCents: 700,
		});
	});
	test("unknown zone / rate are NOT_FOUND", async () => {
		expect((await failure("shipping_methods_list", { zoneId: "nope" })).code).toBe("NOT_FOUND");
		expect((await failure("shipping_rate_get", { methodId, currency: "EUR" })).code).toBe(
			"NOT_FOUND",
		);
		expect((await failure("tax_rates_list", { zoneId: "nope" })).code).toBe("NOT_FOUND");
	});
	test("tax settings, classes and rates", async () => {
		expect(await call("tax_settings_get")).toHaveProperty("settings");
		expect(await call("tax_classes_list")).toHaveProperty("items");
		expect(await call("tax_rates_list", { zoneId })).toEqual({ items: [] });
	});
});

describe("reports", () => {
	const range = { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" };
	test("revenue, orders by status and top products see the seeded order", async () => {
		const revenue = await call("reports_revenue", { ...range, granularity: "month" });
		expect(revenue.items.reduce((n: number, b: any) => n + b.revenueCents, 0)).toBe(
			SEED.orderTotalCents,
		);
		const byStatus = await call("reports_orders_by_status", range);
		expect(byStatus.items.reduce((n: number, s: any) => n + s.orderCount, 0)).toBe(1);
		const top = await call("reports_top_products", { ...range, limit: 5 });
		expect(top.items[0]).toMatchObject({ productId: SEED.productId, qtySold: 1 });
	});
	test("a range over the 400-day cap is INVALID_INPUT", async () => {
		const wide = { from: "2020-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" };
		expect((await failure("reports_revenue", wide)).code).toBe("INVALID_INPUT");
		expect((await failure("reports_orders_by_status", wide)).code).toBe("INVALID_INPUT");
	});
	test("a bad range is INVALID_INPUT, not an internal error", async () => {
		expect((await failure("reports_revenue", { from: "yesterday", to: "today" })).code).toBe(
			"INVALID_INPUT",
		);
	});
});

describe("settings_get", () => {
	test("reports secrets as set / not_set and never their value", async () => {
		const SECRET = "whsec_SEEDED_SECRET_VALUE_1234567890";
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, SECRET);
		const out = await call("settings_get");
		expect(out).toMatchObject({ currency: "USD", operational: { holdTtlMinutes: 15 } });
		expect(out.paymentSecrets.stripeWebhookSecret).toBe("set");
		expect(JSON.stringify(out)).not.toContain(SECRET);
	});
});
