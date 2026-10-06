/**
 * `entitlements/download` under storage pressure: the entitlement check is a
 * storage READ, and a busy store must answer a typed, retryable refusal — not
 * escape as the host's 500, and not be mistaken for NOT_FOUND (which would
 * tell a paying buyer they do not own what they bought). The delivery gate reads
 * four collections in turn, so the refusal is pinned at the first read and at
 * the last one, past a grant that already passed.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { PRODUCT_COMMERCE_COLLECTION } from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createEntitlementDownloadHandler,
	type EntitlementDownloadResult,
} from "../src/entitlements/download-route.js";
import type { PluginContext, StorageAccess } from "../src/types.js";
import { busyStorage } from "./helpers/busy-storage.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

/** `storage` with ONE collection under load, the rest untouched. */
function busyCollection(storage: StorageAccess, name: string): StorageAccess {
	const busy = busyStorage(storage);
	return new Proxy(storage, {
		get(target, key, receiver) {
			return key === name ? Reflect.get(busy, key) : Reflect.get(target, key, receiver);
		},
	});
}

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

async function invoke(input: unknown, ctx: PluginContext): Promise<EntitlementDownloadResult> {
	const handler = createEntitlementDownloadHandler();
	return (await handler(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		ctx,
	)) as EntitlementDownloadResult;
}

describe("entitlements/download under storage pressure", () => {
	test("a busy store is a retryable BUSY refusal, never NOT_FOUND and never a throw", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx: PluginContext = { ...harness.ctx, storage: busyStorage(harness.ctx.storage!) };

		expect(await invoke({ orderId: "ord-1", sku: "SKU-1" }, ctx)).toEqual({
			authorized: false,
			reason: "BUSY",
			retryable: true,
		});
	});

	test("an unrelated fault still propagates", async () => {
		const ctx: PluginContext = {
			...harness.ctx,
			storage: busyStorage(harness.ctx.storage!, () => new Error("disk on fire")),
		};

		await expect(invoke({ orderId: "ord-1", sku: "SKU-1" }, ctx)).rejects.toThrow("disk on fire");
	});

	test("an unloaded store still answers NOT_FOUND for an unknown order (no regression)", async () => {
		expect(await invoke({ orderId: "ord-none", sku: "SKU-1" }, harness.ctx)).toEqual({
			authorized: false,
			reason: "NOT_FOUND",
		});
	});

	test("busy on the LAST read of the gate, past an active grant and a paid order, is still BUSY", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { orderStore, entitlementStore } = harness.stores;
		await orderStore.createFromCart({
			orderId: toOrderId("ord-busy"),
			cartId: null,
			currency: currency("USD"),
			idempotencyKey: idempotencyKey("seed-ord-busy"),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "busy@example.test",
			paymentMethod: "stripe",
			lines: [
				{
					productId: toProductId("prod-busy"),
					sku: toSku("SKU-BUSY"),
					title: "Digital Guide",
					unitPrice: cents(900),
					currency: currency("USD"),
					quantity: 1,
					fulfillmentKind: "digital",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(900), total: cents(900), currency: currency("USD") },
		});
		await orderStore.markPaid(toOrderId("ord-busy"));
		await entitlementStore.grant({
			orderId: toOrderId("ord-busy"),
			productId: toProductId("prod-busy"),
			sku: toSku("SKU-BUSY"),
			buyerRef: "busy@example.test",
			source: "order_paid",
			grantIdempotencyKey: idempotencyKey("ent:ord-busy:SKU-BUSY"),
		});
		const ctx: PluginContext = {
			...harness.ctx,
			storage: busyCollection(harness.ctx.storage!, PRODUCT_COMMERCE_COLLECTION),
		};

		expect(await invoke({ orderId: "ord-busy", sku: "SKU-BUSY" }, ctx)).toEqual({
			authorized: false,
			reason: "BUSY",
			retryable: true,
		});
	});
});
