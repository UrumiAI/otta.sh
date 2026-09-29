/**
 * `entitlements/download` under storage pressure: the entitlement check is a
 * storage READ, and a busy store must answer a typed, retryable refusal — not
 * escape as the host's 500, and not be mistaken for NOT_ENTITLED (which would
 * tell a paying buyer they do not own what they bought).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createEntitlementDownloadHandler,
	type EntitlementDownloadResult,
} from "../src/entitlements/download-route.js";
import type { PluginContext } from "../src/types.js";
import { busyStorage } from "./helpers/busy-storage.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

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
	test("a busy store is a retryable BUSY refusal, never NOT_ENTITLED and never a throw", async () => {
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

	test("an unloaded store still answers NOT_ENTITLED for an unknown order (no regression)", async () => {
		expect(await invoke({ orderId: "ord-none", sku: "SKU-1" }, harness.ctx)).toEqual({
			authorized: false,
			reason: "NOT_ENTITLED",
		});
	});
});
