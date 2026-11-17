/**
 * The admin PRODUCT operations, called directly — no console action, no notice.
 *
 * These are the decisions `products-actions.ts` used to make inline: a stock
 * movement's per-click nonce key and the re-read after a ledger replay, the
 * removal's on-hand watermark outcome (DA-3a), and the edit's unsupported-currency
 * guard and content-derived key. The admin console and the MCP tools both call
 * them, so a guard here holds for both. `products-actions.sandbox.test.ts` pins
 * the notices the console renders from these outcomes; this file pins the
 * outcomes.
 *
 * Real document store (in-memory SQLite, the host's migrations) and the client's
 * own stores.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminProductsClient } from "../src/admin/in-process-admin-products-client.js";
import {
	deriveEditIdempotencyKey,
	editProduct,
	NONCE_PATTERN,
	removeStock,
	restock,
	stockMovementKey,
} from "../src/admin/operations/index.js";
import * as pluginIndex from "../src/index.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;
let client: InProcessAdminProductsClient;
let seq = 0;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	client = new InProcessAdminProductsClient(harness.ctx);
});

afterAll(async () => {
	await harness?.close();
});

const nonce = (): string => crypto.randomUUID();

/** One live product row priced 19.99 USD (or unpriced), and optionally its stock. */
async function seed(
	opts: { onHand?: number | null; price?: { amount: number; currency: string } | null } = {},
): Promise<{ productId: string; sku: string; updatedAt: string }> {
	seq += 1;
	const productId = `ops-prod-${String(seq)}`;
	const sku = `OPS-SKU-${String(seq)}`;
	const product = await harness.stores.productCommerce.upsert(
		{
			productId: toProductId(productId),
			sku: toSku(sku),
			title: "Blue Widget",
			...(opts.price === null
				? {}
				: {
						price: money(
							cents(opts.price?.amount ?? 1999),
							toCurrency(opts.price?.currency ?? "USD"),
						),
					}),
			productKind: "physical",
		},
		toIdempotencyKey(`ops-seed-${String(seq)}`),
	);
	const onHand = opts.onHand === undefined ? 10 : opts.onHand;
	if (onHand !== null) await harness.stores.inventory.seedOnHand(sku, onHand);
	return { productId, sku, updatedAt: product.updatedAt.toISOString() };
}

const onHandOf = (sku: string) => harness.stores.inventory.findOnHand(sku);

describe("stock movements", () => {
	test("a restock is `moved`, carrying the count it produced", async () => {
		const p = await seed({ onHand: 10 });
		const outcome = await restock(client, {
			productId: p.productId,
			onHand: 10,
			qty: 3,
			nonce: nonce(),
		});
		expect(outcome).toEqual({ kind: "moved", result: { ok: true, onHand: 13 } });
		expect(await onHandOf(p.sku)).toBe(13);
	});

	test("a restock is NOT judged against the on-hand the caller saw", async () => {
		const p = await seed({ onHand: 10 });
		const outcome = await restock(client, {
			productId: p.productId,
			onHand: 99,
			qty: 3,
			nonce: nonce(),
		});
		expect(outcome.kind).toBe("moved");
		expect(await onHandOf(p.sku)).toBe(13);
	});

	test("the SAME nonce twice is `replayed`, with the live count re-read, and moves once", async () => {
		const p = await seed({ onHand: 10 });
		const input = { productId: p.productId, onHand: 10, qty: 3, nonce: nonce() };
		expect((await restock(client, input)).kind).toBe("moved");
		expect(await restock(client, input)).toEqual({ kind: "replayed", liveOnHand: 13 });
		expect(await onHandOf(p.sku)).toBe(13);
	});

	test("a replayed removal re-reads the LIVE count, not the one the removal produced", async () => {
		const p = await seed({ onHand: 10 });
		const input = { productId: p.productId, onHand: 10, qty: 2, nonce: nonce() };
		expect((await removeStock(client, input)).kind).toBe("moved");
		expect(
			(await harness.stores.inventory.reserve(p.sku, 1, toIdempotencyKey(`ops-sale-${p.sku}`))).ok,
		).toBe(true);
		expect(await removeStock(client, input)).toEqual({ kind: "replayed", liveOnHand: 7 });
	});

	test("a new nonce is a new decision: Add 2, Remove 2, Add 2 all land", async () => {
		const p = await seed({ onHand: 7 });
		await restock(client, { productId: p.productId, onHand: 7, qty: 2, nonce: nonce() });
		await removeStock(client, { productId: p.productId, onHand: 9, qty: 2, nonce: nonce() });
		const third = await restock(client, {
			productId: p.productId,
			onHand: 7,
			qty: 2,
			nonce: nonce(),
		});
		expect(third.kind).toBe("moved");
		expect(await onHandOf(p.sku)).toBe(9);
	});

	test("a removal is `moved` when the on-hand the caller saw is current", async () => {
		const p = await seed({ onHand: 10 });
		const outcome = await removeStock(client, {
			productId: p.productId,
			onHand: 10,
			qty: 4,
			nonce: nonce(),
		});
		expect(outcome).toEqual({ kind: "moved", result: { ok: true, onHand: 6 } });
	});

	test("a removal against a MOVED on-hand is `stock_changed`, naming the live count; nothing moves", async () => {
		const p = await seed({ onHand: 10 });
		const outcome = await removeStock(client, {
			productId: p.productId,
			onHand: 12,
			qty: 2,
			nonce: nonce(),
		});
		expect(outcome).toEqual({ kind: "stock_changed", liveOnHand: 10 });
		expect(await onHandOf(p.sku)).toBe(10);
	});

	test("a removal where the inventory record is GONE is `stock_changed` with no count", async () => {
		const p = await seed({ onHand: null });
		const outcome = await removeStock(client, {
			productId: p.productId,
			onHand: 5,
			qty: 1,
			nonce: nonce(),
		});
		expect(outcome).toEqual({ kind: "stock_changed", liveOnHand: null });
	});

	test("a restock where there is no inventory record is `failed`, not a stock change", async () => {
		const p = await seed({ onHand: null });
		const outcome = await restock(client, {
			productId: p.productId,
			onHand: 0,
			qty: 1,
			nonce: nonce(),
		});
		expect(outcome).toEqual({ kind: "failed", result: { ok: false, reason: "no_inventory_row" } });
	});

	test("a removal over stock is `failed` with `insufficient_stock`; never a negative", async () => {
		const p = await seed({ onHand: 10 });
		const outcome = await removeStock(client, {
			productId: p.productId,
			onHand: 10,
			qty: 11,
			nonce: nonce(),
		});
		expect(outcome).toEqual({
			kind: "failed",
			result: { ok: false, reason: "insufficient_stock", onHand: 10 },
		});
		expect(await onHandOf(p.sku)).toBe(10);
	});

	test("a movement of a product that does not exist is `failed` with `not_found`", async () => {
		const outcome = await removeStock(client, {
			productId: "ops-prod-nowhere",
			onHand: 5,
			qty: 1,
			nonce: nonce(),
		});
		expect(outcome).toEqual({ kind: "failed", result: { ok: false, reason: "not_found" } });
	});

	test("a malformed nonce, quantity or watermark THROWS before anything moves", async () => {
		const p = await seed({ onHand: 10 });
		const good = { productId: p.productId, onHand: 10, qty: 1, nonce: nonce() };
		for (const bad of [
			{ ...good, nonce: "short" },
			{ ...good, nonce: "has spaces in it, sixteen+" },
			{ ...good, qty: 0 },
			{ ...good, qty: 1.5 },
			{ ...good, onHand: -1 },
			{ ...good, onHand: 2.5 },
		]) {
			await expect(restock(client, bad), JSON.stringify(bad)).rejects.toThrow(RangeError);
			await expect(removeStock(client, bad), JSON.stringify(bad)).rejects.toThrow(RangeError);
		}
		expect(await onHandOf(p.sku)).toBe(10);
	});

	test("the movement key is per intent, from the nonce", () => {
		expect(stockMovementKey("p-1", "restock", "abcdefabcdefabcd")).toBe(
			"p-1:restock:nonce:abcdefabcdefabcd",
		);
		expect(stockMovementKey("p-1", "removal", "abcdefabcdefabcd")).toBe(
			"p-1:removal:nonce:abcdefabcdefabcd",
		);
		expect(NONCE_PATTERN.test(crypto.randomUUID())).toBe(true);
		expect(NONCE_PATTERN.test("a".repeat(15))).toBe(false);
		expect(NONCE_PATTERN.test("a".repeat(65))).toBe(false);
	});
});

describe("the product edit", () => {
	test("an edit's happy path is a `result` that went in", async () => {
		const p = await seed();
		const outcome = await editProduct(client, p.productId, {
			expectedUpdatedAt: p.updatedAt,
			price: { amount: 2450, currency: "USD" },
		});
		expect(outcome.kind).toBe("result");
		expect(outcome.kind === "result" && outcome.result.ok).toBe(true);
		const row = await harness.stores.productCommerce.getByProductId(toProductId(p.productId));
		expect(row?.price).toEqual({ amount: 2450, currency: "USD" });
	});

	test("a FIRST pricing in an unsupported currency is `unsupported_currency`; nothing is written", async () => {
		const p = await seed({ price: null });
		const outcome = await editProduct(client, p.productId, {
			expectedUpdatedAt: p.updatedAt,
			price: { amount: 2450, currency: "XYZ" },
		});
		expect(outcome).toEqual({ kind: "unsupported_currency", currency: "XYZ" });
		const row = await harness.stores.productCommerce.getByProductId(toProductId(p.productId));
		expect(row?.updatedAt.toISOString()).toBe(p.updatedAt);
	});

	test("an unlisted code ALREADY stored on the product is not refused", async () => {
		const p = await seed({ price: { amount: 1999, currency: "LKR" } });
		const outcome = await editProduct(client, p.productId, {
			expectedUpdatedAt: p.updatedAt,
			price: { amount: 2500, currency: "LKR" },
		});
		expect(outcome.kind).toBe("result");
		expect(outcome.kind === "result" && outcome.result.ok).toBe(true);
	});

	test("a stale watermark is the service's `stale` result, passed through", async () => {
		const p = await seed();
		const outcome = await editProduct(client, p.productId, {
			expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
			sku: `${p.sku}-X`,
		});
		expect(outcome.kind === "result" && !outcome.result.ok && outcome.result.reason).toBe("stale");
	});

	test("the same edit twice at one watermark is one write (the content-derived key)", async () => {
		const p = await seed();
		const wire = { expectedUpdatedAt: p.updatedAt, price: { amount: 2450, currency: "USD" } };
		const first = await editProduct(client, p.productId, wire);
		const second = await editProduct(client, p.productId, wire);
		expect(first.kind === "result" && first.result.ok).toBe(true);
		expect(second.kind === "result" && second.result.ok).toBe(true);
	});

	test("a blank watermark THROWS before anything is sent", async () => {
		const p = await seed();
		await expect(
			editProduct(client, p.productId, { expectedUpdatedAt: " ", sku: "NEW" }),
		).rejects.toThrow(RangeError);
	});

	test("the edit key is content-derived and stable", () => {
		const wire = { expectedUpdatedAt: "t1", taxStatus: "taxable" as const };
		expect(deriveEditIdempotencyKey("p-1", wire)).toBe(deriveEditIdempotencyKey("p-1", wire));
		expect(deriveEditIdempotencyKey("p-1", wire)).toMatch(/^p-1:edit:[0-9a-z]+$/);
		expect(deriveEditIdempotencyKey("p-1", wire)).not.toBe(
			deriveEditIdempotencyKey("p-1", { ...wire, taxStatus: "none" }),
		);
	});
});

describe("the plugin's public entry exports the operations (MCP reuses them)", () => {
	test("every product operation is re-exported from the package index", () => {
		for (const name of [
			"restock",
			"removeStock",
			"editProduct",
			"stockMovementKey",
			"deriveEditIdempotencyKey",
		]) {
			expect(typeof (pluginIndex as Record<string, unknown>)[name], name).toBe("function");
		}
		expect((pluginIndex as Record<string, unknown>)["NONCE_PATTERN"]).toBeInstanceOf(RegExp);
	});
});

describe("deriveEditIdempotencyKey: an absent field is not an explicit null", () => {
	const t = "2026-10-07T12:00:00.000Z";

	test("the console's page-shaped wires keep the keys they had before the distinction", () => {
		// Keys recorded from the formula as it stood before absent and null were told
		// apart. These are the shapes `products:save` builds: compare-at, cost and tax
		// class always ride (null = clear); sku, price, weight and size are omitted
		// when blank and never null. An in-flight console retry must keep its key.
		const full = {
			expectedUpdatedAt: t,
			sku: "SKU-1",
			price: { amount: 1999, currency: "USD" },
			compareAtPrice: { amount: 2999, currency: "USD" },
			unitCost: { amount: 800, currency: "USD" },
			productKind: "physical",
			taxClass: "reduced",
			taxStatus: "taxable",
			weightGrams: 250,
			lengthMm: 100,
			widthMm: 50,
			heightMm: 20,
		};
		const clears = {
			expectedUpdatedAt: t,
			sku: "SKU-1",
			price: { amount: 1999, currency: "USD" },
			compareAtPrice: null,
			unitCost: null,
			productKind: "physical",
			taxClass: null,
			taxStatus: "shipping_only",
		};
		const digital = {
			expectedUpdatedAt: t,
			price: { amount: 500, currency: "EUR" },
			compareAtPrice: null,
			unitCost: { amount: 100, currency: "EUR" },
			productKind: "digital",
			taxClass: null,
			taxStatus: "none",
		};
		expect(deriveEditIdempotencyKey("p-1", full)).toBe("p-1:edit:bf5ljo1l95fza");
		expect(deriveEditIdempotencyKey("p-1", clears)).toBe("p-1:edit:1a7qvwx1a3er1r");
		expect(deriveEditIdempotencyKey("p-1", digital)).toBe("p-1:edit:qc76rhiq0p97");
	});

	test("two different clears at one watermark get different keys", () => {
		const compareAt = deriveEditIdempotencyKey("p-1", {
			expectedUpdatedAt: t,
			compareAtPrice: null,
		});
		const cost = deriveEditIdempotencyKey("p-1", { expectedUpdatedAt: t, unitCost: null });
		const taxClass = deriveEditIdempotencyKey("p-1", { expectedUpdatedAt: t, taxClass: null });
		expect(new Set([compareAt, cost, taxClass]).size).toBe(3);
	});

	test("clearing a measurement is not the same edit as leaving it alone", () => {
		const base = { expectedUpdatedAt: t, compareAtPrice: null, unitCost: null, taxClass: null };
		for (const field of ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const) {
			expect(deriveEditIdempotencyKey("p-1", { ...base, [field]: null }), field).not.toBe(
				deriveEditIdempotencyKey("p-1", base),
			);
		}
	});
});
