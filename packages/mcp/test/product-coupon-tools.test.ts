/**
 * The product and coupon WRITE tools, driven through `withMcp`'s routes over a
 * real SQLite document store. Every one calls the plugin's admin operation
 * (`editProduct`, `restock`, `removeStock`, `createCoupon`, `patchCoupon`,
 * `retireCoupon`, `deleteCoupon`), never a surface write; these cases pin how each
 * outcome reaches an agent: success data, or a `ToolError` with a stable code.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import {
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	systemClock,
	uuidIdGen,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OTTA_MCP_TOOLS, withMcp, type McpRouteEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

let harness: AdminHarness;
let products: EmdashProductCommerceStore;
let inventory: EmdashInventoryStore;
let seq = 0;
const plugin = withMcp(createOttaPlugin());

beforeAll(async () => {
	harness = await makeAdminHarness();
	const storage = harness.ctx.storage;
	if (storage === undefined) throw new Error("harness has no storage");
	products = new EmdashProductCommerceStore({ storage, clock: systemClock });
	inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
});
afterAll(async () => {
	expect(harness.egressAttempts()).toBe(0);
	await harness?.close();
});

/** A $19.99 physical product with `onHand` units of its own sku. */
async function seedProduct(onHand = 3): Promise<string> {
	seq += 1;
	const id = `mcp-prod-${String(seq)}`;
	await products.upsert(
		{
			productId: toProductId(id),
			sku: toSku(`SKU-${id}`),
			title: "Linen apron",
			price: money(cents(1999), toCurrency("USD")),
			productKind: "physical",
		},
		toIdempotencyKey(`seed-${id}`),
	);
	await inventory.seedOnHand(`SKU-${id}`, onHand);
	return id;
}

const nonce = (): string => crypto.randomUUID();

async function call(name: string, input: unknown, user: unknown = { name: "Ada" }): Promise<any> {
	const route = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
	if (route === undefined) throw new Error(`no route mcp/${name}`);
	return route.handler({ input, request: new Request("http://x"), user } as never, harness.ctx);
}

async function failure(
	name: string,
	input: unknown,
): Promise<{ name: string; code: string; message: string; details?: any }> {
	try {
		await call(name, input);
	} catch (e) {
		return e as { name: string; code: string; message: string; details?: any };
	}
	throw new Error(`${name} did not fail`);
}

async function onHandOf(productId: string): Promise<number | null> {
	return (await call("products_get", { productId })).onHand;
}

/** A coupon's full summary (the window included) by code, through the list tool. */
async function couponRow(code: string): Promise<any> {
	const page = await call("coupons_list", { query: code });
	expect(page.items).toHaveLength(1);
	return page.items[0];
}

const WRITE_TOOLS = [
	"products_update",
	"products_restock",
	"products_remove_stock",
	"coupons_create",
	"coupons_update",
	"coupons_retire",
	"coupons_delete",
];

test("the product and coupon write tools are in the table; removal, retire and delete are destructive", () => {
	const byName = new Map(OTTA_MCP_TOOLS.map((t) => [t.name, t]));
	for (const name of WRITE_TOOLS) expect(byName.has(name), name).toBe(true);
	const destructive = WRITE_TOOLS.filter((n) => byName.get(n)?.destructive === true);
	expect(destructive).toEqual(["products_remove_stock", "coupons_retire", "coupons_delete"]);
	for (const name of ["products_restock", "products_remove_stock"]) {
		const description = byName.get(name)?.description ?? "";
		expect(description).toMatch(/UUID/);
		expect(description).toMatch(/reuse it/i);
	}
	expect(byName.get("coupons_update")?.description).toMatch(/cannot change a coupon's currency/i);
});

describe("products_restock", () => {
	test("the same key twice: the second is replayed and stock went up once", async () => {
		const id = await seedProduct(3);
		const args = { productId: id, onHand: 3, qty: 2, idempotencyKey: nonce() };
		expect(await call("products_restock", args)).toEqual({ status: "restocked", onHand: 5 });
		expect(await call("products_restock", args)).toEqual({ status: "replayed", liveOnHand: 5 });
		expect(await onHandOf(id)).toBe(5);
	});

	test("a key that is not a nonce is INVALID_INPUT and nothing moves", async () => {
		const id = await seedProduct(3);
		const err = await failure("products_restock", {
			productId: id,
			onHand: 3,
			qty: 2,
			idempotencyKey: "restock please",
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(await onHandOf(id)).toBe(3);
	});

	test("an unknown product is NOT_FOUND", async () => {
		const err = await failure("products_restock", {
			productId: "mcp-missing",
			onHand: 0,
			qty: 1,
			idempotencyKey: nonce(),
		});
		expect(err.code).toBe("NOT_FOUND");
	});
});

describe("products_remove_stock", () => {
	test("removes from the count the agent saw", async () => {
		const id = await seedProduct(3);
		const out = await call("products_remove_stock", {
			productId: id,
			onHand: 3,
			qty: 1,
			idempotencyKey: nonce(),
		});
		expect(out).toEqual({ status: "removed", onHand: 2 });
		expect(await onHandOf(id)).toBe(2);
	});

	test("a stale onHand is STOCK_CHANGED with the live count, and nothing moves", async () => {
		const id = await seedProduct(3);
		const err = await failure("products_remove_stock", {
			productId: id,
			onHand: 7,
			qty: 1,
			idempotencyKey: nonce(),
		});
		expect(err.code).toBe("STOCK_CHANGED");
		expect(err.details).toEqual({ liveOnHand: 3 });
		expect(await onHandOf(id)).toBe(3);
	});

	test("removing more than is on hand is INSUFFICIENT_STOCK, never a negative", async () => {
		const id = await seedProduct(3);
		const err = await failure("products_remove_stock", {
			productId: id,
			onHand: 3,
			qty: 4,
			idempotencyKey: nonce(),
		});
		expect(err.code).toBe("INSUFFICIENT_STOCK");
		expect(err.details).toEqual({ onHand: 3 });
		expect(await onHandOf(id)).toBe(3);
	});
});

describe("products_update", () => {
	test("edits the price under the watermark the agent read", async () => {
		const id = await seedProduct();
		const { updatedAt } = await call("products_get", { productId: id });
		const out = await call("products_update", {
			productId: id,
			expectedUpdatedAt: updatedAt,
			price: { amount: 2499, currency: "USD" },
		});
		expect(out.status).toBe("updated");
		expect(typeof out.updatedAt).toBe("string");
		expect((await call("products_get", { productId: id })).priceCents).toBe(2499);
	});

	test("a stale watermark is PRODUCT_CHANGED and nothing is written", async () => {
		const id = await seedProduct();
		const { updatedAt } = await call("products_get", { productId: id });
		await call("products_update", {
			productId: id,
			expectedUpdatedAt: updatedAt,
			price: { amount: 2499, currency: "USD" },
		});
		const err = await failure("products_update", {
			productId: id,
			expectedUpdatedAt: updatedAt,
			price: { amount: 999, currency: "USD" },
		});
		expect(err.code).toBe("PRODUCT_CHANGED");
		expect(typeof err.details.currentUpdatedAt).toBe("string");
		expect((await call("products_get", { productId: id })).priceCents).toBe(2499);
	});

	test("a currency the store does not support is UNSUPPORTED_CURRENCY", async () => {
		const id = await seedProduct();
		const { updatedAt } = await call("products_get", { productId: id });
		const err = await failure("products_update", {
			productId: id,
			expectedUpdatedAt: updatedAt,
			price: { amount: 2499, currency: "ZZZ" },
		});
		expect(err.code).toBe("UNSUPPORTED_CURRENCY");
		expect(err.details).toEqual({ currency: "ZZZ" });
	});

	test("a decimal price never reaches the operation", async () => {
		const id = await seedProduct();
		const { updatedAt } = await call("products_get", { productId: id });
		const err = await failure("products_update", {
			productId: id,
			expectedUpdatedAt: updatedAt,
			price: { amount: 24.99, currency: "USD" },
		});
		expect(err.code).toBe("INVALID_INPUT");
	});

	test("an unknown product is NOT_FOUND", async () => {
		const err = await failure("products_update", {
			productId: "mcp-missing",
			expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
			weightGrams: 10,
		});
		expect(err.code).toBe("NOT_FOUND");
	});
});

describe("coupons", () => {
	let n = 0;
	const code = (): string => {
		n += 1;
		return `MCP${String(n)}`;
	};

	test("a partial update (only maxUses) keeps the dates and the minimum spend", async () => {
		// Review focus 2.
		const c = code();
		const created = await call("coupons_create", {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
			minSubtotalCents: 3000,
			startsAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(created).toMatchObject({ status: "created", coupon: { id: `id-${c}`, code: c } });
		const out = await call("coupons_update", { couponId: `id-${c}`, maxUses: 10 });
		expect(out).toMatchObject({ status: "updated", coupon: { maxUses: 10 } });
		expect(await couponRow(c)).toMatchObject({
			amountCents: 500,
			currency: "USD",
			minSubtotalCents: 3000,
			startsAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
			maxUses: 10,
		});
	});

	test("an explicit null clears just that field", async () => {
		const c = code();
		await call("coupons_create", {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
			expiresAt: "2099-01-01T00:00:00.000Z",
			maxUses: 5,
		});
		await call("coupons_update", { couponId: `id-${c}`, expiresAt: null });
		expect(await couponRow(c)).toMatchObject({ expiresAt: null, maxUses: 5, amountCents: 500 });
	});

	test("a taken code is COUPON_CODE_TAKEN; a retried create says the coupon is the same", async () => {
		const c = code();
		const args = {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 100,
			currency: "USD",
		};
		await call("coupons_create", args);
		const taken = await failure("coupons_create", { ...args, id: `other-${c}` });
		expect(taken.code).toBe("COUPON_CODE_TAKEN");
		expect(taken.details).toEqual({ code: c, taken: "code" });
		const retried = await failure("coupons_create", args);
		expect(retried.code).toBe("COUPON_CODE_TAKEN");
		expect(retried.details).toEqual({ code: c, taken: "same" });
	});

	test("a rules-client refusal is INVALID_INPUT naming the field", async () => {
		const err = await failure("coupons_create", {
			code: "HAS SPACE",
			type: "fixed_amount",
			amountCents: 100,
			currency: "USD",
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.details).toMatchObject({ field: "code" });
	});

	test("a percentage coupon with a cap but no currency is COUPON_CURRENCY_REFUSED", async () => {
		const err = await failure("coupons_create", {
			code: code(),
			type: "percentage",
			rateBps: 1000,
			capCents: 500,
		});
		expect(err.code).toBe("COUPON_CURRENCY_REFUSED");
		expect(typeof err.details.reason).toBe("string");
	});

	test("an update cannot change a set currency: COUPON_CURRENCY_REFUSED, currency_moved", async () => {
		const c = code();
		await call("coupons_create", {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
		});
		const err = await failure("coupons_update", { couponId: `id-${c}`, currency: "EUR" });
		expect(err.code).toBe("COUPON_CURRENCY_REFUSED");
		expect(err.details).toMatchObject({ reason: "currency_moved" });
		expect((await couponRow(c)).currency).toBe("USD");
	});

	test("blanking a fixed coupon's amount is COUPON_WRITE_FAILED with the status", async () => {
		const c = code();
		await call("coupons_create", {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
		});
		const err = await failure("coupons_update", { couponId: `id-${c}`, amountCents: null });
		expect(err.code).toBe("COUPON_WRITE_FAILED");
		expect(err.details).toEqual({ status: 400 });
	});

	test("an unknown coupon is NOT_FOUND for update, retire and delete", async () => {
		for (const name of ["coupons_update", "coupons_retire", "coupons_delete"]) {
			const err = await failure(name, { couponId: "mcp-missing", maxUses: 1 });
			expect(err.code, name).toBe("NOT_FOUND");
		}
	});

	test("retire ends a coupon now; retiring it again is already_ended", async () => {
		const c = code();
		await call("coupons_create", {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
		});
		const out = await call("coupons_retire", { couponId: `id-${c}` });
		expect(out).toMatchObject({ status: "retired", coupon: { id: `id-${c}` } });
		expect(typeof out.retiredAt).toBe("string");
		expect(await call("coupons_retire", { couponId: `id-${c}` })).toEqual({
			status: "already_ended",
		});
	});

	test("delete removes an unredeemed coupon", async () => {
		const c = code();
		await call("coupons_create", {
			id: `id-${c}`,
			code: c,
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
		});
		expect(await call("coupons_delete", { couponId: `id-${c}` })).toEqual({ status: "deleted" });
		expect((await call("coupons_list", { query: c })).items).toEqual([]);
	});
});
