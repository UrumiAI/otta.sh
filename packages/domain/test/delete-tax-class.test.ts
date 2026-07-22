import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, sku } from "../src/money/ids.js";
import { deleteTaxClass } from "../src/pricing/delete-tax-class.js";
import { FixedClock } from "../src/testing/deterministic.js";
import { InMemoryProductCommerceStore } from "../src/testing/in-memory-product-commerce-store.js";
import { InMemoryTaxRulesStore } from "../src/testing/in-memory-tax-rules-store.js";

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
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	beforeEach(() => {
		taxRules = new InMemoryTaxRulesStore();
		productCommerce = new InMemoryProductCommerceStore({ clock });
	});

	test("deletes an unreferenced class", async () => {
		await taxRules.createClass({ id: "temp", name: "Temp" });
		const res = await deleteTaxClass({ taxRules, productCommerce }, "temp");
		expect(res).toEqual({ ok: true });
		expect((await taxRules.listClasses()).map((c) => c.id)).not.toContain("temp");
	});

	test("not_found for an unknown class", async () => {
		expect(await deleteTaxClass({ taxRules, productCommerce }, "nope")).toEqual({
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

		const res = await deleteTaxClass({ taxRules, productCommerce }, "reduced");
		expect(res).toEqual({ ok: false, reason: "in_use_by_products" });
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

		expect(await deleteTaxClass({ taxRules, productCommerce }, "reduced")).toEqual({ ok: true });
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
		expect(await deleteTaxClass({ taxRules, productCommerce }, "standard")).toEqual({
			ok: false,
			reason: "in_use_by_rates",
		});
	});
});
