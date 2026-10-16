import {
	collectionOf,
	TAX_CLASSES_COLLECTION,
	TAX_RATE_OWNERS_COLLECTION,
	type StorageAccess as StoreStorageAccess,
	type TaxClassDoc,
	type TaxRateOwnerDoc,
} from "@otta-sh/store-emdash";
import { idempotencyKey } from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTaxPageHandler } from "../src/admin/tax-page.js";
import { encodePath } from "../src/admin/scaffold/nav.js";
import type { BlockResponse, PluginContext, RouteHandler, StorageAccess } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

/**
 * #471: the rates page reads the tax settings only to word its duplicate notes.
 * When that read fails the page still has to render its rates (the settings read
 * falls back to "not the legacy shipping rule"); it must not fail closed.
 */
let h: InProcessCommerceHarness;

beforeEach(async () => {
	h = await makeInProcessCommerce();
	await h.stores.taxRules.createClass({ id: "standard", name: "Standard" });
	await h.stores.shippingRules.createZone({ id: "us", name: "United States", regions: ["US"] });
	await h.stores.taxRules.createRate({
		id: "std-us",
		taxClassId: "standard",
		zoneId: "us",
		rateBps: 725,
		appliesToShipping: true,
	});
});

afterEach(async () => {
	await h.close();
});

/** The harness context with every read of the `settings` collection rejecting. */
function settingsFailingCtx(): PluginContext {
	const storage = new Proxy(h.ctx.storage ?? {}, {
		get(target, name, receiver) {
			const collection = Reflect.get(target, name, receiver) as unknown;
			if (name !== "settings") return collection;
			return new Proxy(
				{},
				{ get: () => () => Promise.reject(new Error("settings are unreachable")) },
			);
		},
	}) as StorageAccess;
	return { ...h.ctx, storage };
}

async function openStandard(ctx: PluginContext): Promise<BlockResponse> {
	const handler = createTaxPageHandler() as unknown as RouteHandler<Record<string, unknown>>;
	return (await handler(
		{
			input: {
				type: "block_action",
				action_id: "tax:open",
				value: { target: encodePath(["standard"]) },
			},
			request: { method: "POST", url: "/admin", headers: {} },
		},
		ctx,
	)) as BlockResponse;
}

describe("the tax rates page when the tax-settings read fails (#471)", () => {
	test("it still renders the class's rates", async () => {
		const res = await openStandard(settingsFailingCtx());
		const text = JSON.stringify(res.blocks);
		expect(text).toContain("std-us");
		expect(text).not.toContain("unavailable");
		expect(res.toast).toBeUndefined();
	});

	test("a duplicate's note stays neutral: no legacy and no 'taxes nothing' claim, and the failure is logged", async () => {
		await seedDuplicate();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Working read: this store (rates, nothing saved) is on the legacy rule.
			const known = JSON.stringify((await openStandard(h.ctx)).blocks);
			expect(known).toContain(
				"its shipping setting still counts, so deleting it can change shipping tax",
			);
			expect(warn).not.toHaveBeenCalled();

			const unknown = JSON.stringify((await openStandard(settingsFailingCtx())).blocks);
			expect(unknown).toContain("its shipping setting could not be checked");
			expect(unknown).not.toContain("still counts");
			expect(unknown).not.toContain("taxes nothing");
			expect(unknown).not.toContain("only if this rate becomes the active one");
			expect(unknown).not.toContain("counts toward shipping tax");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).not.toContain("725");
		} finally {
			warn.mockRestore();
		}
	});

	test("the class list still renders when the tax-settings read fails, and the failure is logged", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const handler = createTaxPageHandler() as unknown as RouteHandler<Record<string, unknown>>;
			const load = async (ctx: PluginContext) =>
				JSON.stringify(
					(
						(await handler(
							{
								input: { type: "page_load", page: "/tax" },
								request: { method: "POST", url: "/admin", headers: {} },
							},
							ctx,
						)) as BlockResponse
					).blocks,
				);
			// Control: with tax switched off and a working read, the page shows the
			// tax-off banner, so its absence below is meaningful.
			await h.stores.settingsStore.update(
				{
					tax: {
						enabled: false,
						pricesIncludeTax: false,
						basedOn: "shipping",
						baseAddress: null,
						shippingTaxClass: { kind: "inherit" },
						roundAtSubtotal: false,
						displayCart: "excl",
						totalsDisplay: "itemized",
					},
				},
				idempotencyKey("tax-off"),
			);
			expect(await load(h.ctx)).toContain("Tax is switched off");
			const text = await load(settingsFailingCtx());
			expect(text).toContain("standard");
			expect(text).not.toContain("Tax is switched off");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("the tax rates page duplicate note (#484)", () => {
	test("an ignored duplicate that does not apply to shipping is not warned about shipping tax", async () => {
		// std-us (the ignored one, "std-us" < "std-us-b") stops applying to shipping.
		await h.stores.taxRules.updateRate(
			"std-us",
			{ rateBps: 725, appliesToShipping: false },
			{ rateBps: 725, appliesToShipping: true },
		);
		await seedDuplicate();
		const text = JSON.stringify((await openStandard(h.ctx)).blocks);
		expect(text).toContain("Duplicate: only std-us-b applies");
		expect(text).not.toContain("can change shipping tax");
		// The toggle's label says what switching it ON does, so it is the same label
		// whether this copy applies to shipping or not.
		expect(text).toContain(
			"Applies to shipping — counts toward shipping tax even while this duplicate is ignored",
		);
	});
});

/** A second rate in the same (class, zone), written as a store did before it refused one. */
async function seedDuplicate(): Promise<void> {
	const storage = h.ctx.storage as unknown as StoreStorageAccess;
	const classes = collectionOf<TaxClassDoc>(storage, TAX_CLASSES_COLLECTION);
	const owners = collectionOf<TaxRateOwnerDoc>(storage, TAX_RATE_OWNERS_COLLECTION);
	const held = await classes.get("standard");
	await classes.put("standard", {
		taxClassId: "standard",
		name: held?.name ?? null,
		rates: {
			...held?.rates,
			"std-us-b": { rateId: "std-us-b", zoneId: "us", rateBps: 900, appliesToShipping: false },
		},
	});
	await owners.put("std-us-b", {
		rateId: "std-us-b",
		taxClassId: "standard",
		claimedAt: "2026-07-10T00:00:00.000Z",
	});
}
