import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, sku } from "../src/money/ids.js";
import { deleteTaxClass } from "../src/pricing/delete-tax-class.js";
import { FixedClock } from "../src/testing/deterministic.js";
import { InMemoryProductCommerceStore } from "../src/testing/in-memory-product-commerce-store.js";
import { InMemorySettingsStore } from "../src/testing/in-memory-settings-store.js";
import { InMemoryTaxRulesStore } from "../src/testing/in-memory-tax-rules-store.js";
import { NEW_STORE_TAX_SETTINGS } from "../src/pricing/tax-settings.js";

/**
 * `deleteTaxClass` — the tax-class registry's delete-in-use guard (Increment 2
 * slice 5), composing the product-reference count with the tax store's own-grain
 * rate guard. The registry itself is the existing `TaxRulesStore`; this proves
 * a class a product (or a rate) still points at can never be deleted out from
 * under it.
 */
describe("deleteTaxClass (delete-in-use guard over the in-memory fakes)", () => {
	let taxRules: InMemoryTaxRulesStore;
	let productCommerce: InMemoryProductCommerceStore;
	let settings: InMemorySettingsStore;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	beforeEach(() => {
		taxRules = new InMemoryTaxRulesStore();
		productCommerce = new InMemoryProductCommerceStore({ clock });
		settings = new InMemorySettingsStore();
	});

	test("deletes an unreferenced class", async () => {
		await taxRules.createClass({ id: "temp", name: "Temp" });
		const res = await deleteTaxClass({ taxRules, productCommerce, settings }, "temp");
		expect(res).toEqual({ ok: true });
		expect((await taxRules.listClasses()).map((c) => c.id)).not.toContain("temp");
	});

	test("not_found for an unknown class", async () => {
		expect(await deleteTaxClass({ taxRules, productCommerce, settings }, "nope")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	test("refuses a class a LIVE product still references (in_use_by_products)", async () => {
		await taxRules.createClass({ id: "reduced", name: "Reduced" });
		const pid = productId("p1");
		const seeded = await productCommerce.upsert(
			{ productId: pid, sku: sku("SKU-1"), price: money(cents(1000), currency("USD")) },
			idempotencyKey("seed-1"),
		);
		await productCommerce.updateCommerceFields(
			{ productId: pid, taxClass: "reduced" },
			idempotencyKey("edit-1"),
			seeded.updatedAt.toISOString(),
		);

		const res = await deleteTaxClass({ taxRules, productCommerce, settings }, "reduced");
		expect(res).toEqual({ ok: false, reason: "in_use_by_products", count: 1 });
		// The class survives.
		expect((await taxRules.listClasses()).map((c) => c.id)).toContain("reduced");
	});

	test("a soft-deleted product's reference does NOT block deletion", async () => {
		await taxRules.createClass({ id: "reduced", name: "Reduced" });
		const pid = productId("p1");
		const seeded = await productCommerce.upsert(
			{ productId: pid, sku: sku("SKU-1"), price: money(cents(1000), currency("USD")) },
			idempotencyKey("seed-1"),
		);
		await productCommerce.updateCommerceFields(
			{ productId: pid, taxClass: "reduced" },
			idempotencyKey("edit-1"),
			seeded.updatedAt.toISOString(),
		);
		await productCommerce.softDelete(pid, idempotencyKey("del-1"));

		expect(await deleteTaxClass({ taxRules, productCommerce, settings }, "reduced")).toEqual({ ok: true });
	});

	test("refuses a class a rate references (in_use_by_rates), checked after the product guard", async () => {
		await taxRules.createClass({ id: "standard", name: "Standard" });
		await taxRules.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		expect(await deleteTaxClass({ taxRules, productCommerce, settings }, "standard")).toEqual({
			ok: false,
			reason: "in_use_by_rates",
			count: 1,
		});
	});

	test("in_use_by_rates carries the FULL referencing count, not just >0", async () => {
		await taxRules.createClass({ id: "standard", name: "Standard" });
		await taxRules.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		await taxRules.createRate({
			id: "r2",
			taxClassId: "standard",
			zoneId: "z-eu",
			rateBps: 2000,
			appliesToShipping: false,
		});
		expect(await deleteTaxClass({ taxRules, productCommerce, settings }, "standard")).toEqual({
			ok: false,
			reason: "in_use_by_rates",
			count: 2,
		});
	});

	// Review 2a B4: a class the tax options name as the FIXED shipping tax class is
	// in use too — deleting it would leave shipping tax pointing at nothing.
	test("refuses the class the tax options use as the fixed shipping tax class", async () => {
		await taxRules.createClass({ id: "ship", name: "Shipping" });
		await settings.update(
			{
				tax: {
					...NEW_STORE_TAX_SETTINGS,
					shippingTaxClass: { kind: "fixed", taxClassId: "ship" },
				},
			},
			idempotencyKey("tax-options"),
		);
		expect(await deleteTaxClass({ taxRules, productCommerce, settings }, "ship")).toEqual({
			ok: false,
			reason: "in_use_by_settings",
		});
		expect((await taxRules.listClasses()).map((c) => c.id)).toContain("ship");

		// Once the options name another class, the delete goes through.
		await settings.update(
			{ tax: { ...NEW_STORE_TAX_SETTINGS, shippingTaxClass: { kind: "inherit" } } },
			idempotencyKey("tax-options-2"),
		);
		expect(await deleteTaxClass({ taxRules, productCommerce, settings }, "ship")).toEqual({
			ok: true,
		});
	});
});
