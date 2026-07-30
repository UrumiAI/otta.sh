import {
	cents,
	createOrderFromCart,
	currency,
	idempotencyKey,
	money,
	productId as brandProductId,
	updateProductCommerceFields,
	upsertProductCommerce,
} from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { makeOrderHarness } from "./fake-harness.js";

/**
 * Snapshot-invariant regression (CLAUDE.md: "editing a product NEVER rewrites
 * an existing order's line items"). Changing a product's price or its title
 * writes ONLY `product_commerce`; an order's `order_items` are an independent
 * snapshot taken once at purchase time (create-order-from-cart §4), so they
 * must survive the change byte-for-byte. This test pins that: place an order,
 * change the product, assert the order's lines are unchanged.
 *
 * PR 1c ("one home per field") changed this test's MECHANISM, not its subject.
 * Price is still edited through `updateProductCommerceFields` (the admin
 * console's guarded CAS). The rename now goes through `upsertProductCommerce`,
 * because after ADR-0013 the CMS content sync is `title`'s only writer — the
 * edit port no longer accepts one. That makes the coverage STRONGER than
 * before: one placed order is now exercised against BOTH of the two writers
 * that can touch a product, rather than one.
 */
describe("product edit never rewrites an existing order's line snapshot", () => {
	test("a price edit AND a CMS-sync rename leave a placed order's line items byte-identical", async () => {
		const h = makeOrderHarness();
		await h.seedPhysical({
			productId: "prod-1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Original Title",
			onHand: 10,
		});

		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "prod-1", qty: 2, kind: "physical" },
		]);
		const placed = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("order-1"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		expect(placed.ok).toBe(true);
		if (!placed.ok) throw new Error("unreachable");

		// The line snapshot AT purchase time (a deep copy — the assertion target).
		const snapshotBefore = structuredClone(placed.order.lines);
		expect(snapshotBefore).toHaveLength(1);
		expect(snapshotBefore[0]?.title).toBe("Original Title");
		expect(snapshotBefore[0]?.unitPrice).toBe(1000);

		const pid = brandProductId("prod-1");
		const deps = { productCommerce: h.productCommerce, inventory: h.inventory };

		// WRITER ONE — the admin console's guarded edit: a new price, under the
		// row's own optimistic-concurrency watermark.
		const current = await h.productCommerce.getByProductId(pid);
		expect(current).not.toBeNull();
		const edit = await updateProductCommerceFields(
			deps,
			{ productId: pid, price: money(cents(9999), currency("USD")) },
			idempotencyKey("edit-1"),
			current!.updatedAt.toISOString(),
		);
		expect(edit.ok).toBe(true);

		// WRITER TWO — the CMS content sync: a rename. This is the ONLY channel
		// that may write `product_commerce.title` (ADR-0013), so the rename half of
		// this regression has to travel through it.
		await upsertProductCommerce(
			deps,
			{ productId: pid, title: "Renamed Product" },
			idempotencyKey("sync-1"),
		);

		// The product itself changed on both axes (sanity — both writes applied)…
		const afterEdit = await h.productCommerce.getByProductId(pid);
		expect(afterEdit?.price).toEqual({ amount: 9999, currency: "USD" });
		expect(afterEdit?.title).toBe("Renamed Product");

		// …but the placed order's line snapshot is UNTOUCHED.
		const reread = await h.orderStore.getById(placed.order.id);
		expect(reread).not.toBeNull();
		expect(reread!.lines).toEqual(snapshotBefore);
		expect(reread!.lines[0]?.title).toBe("Original Title");
		expect(reread!.lines[0]?.unitPrice).toBe(1000);
		// The order total is likewise the snapshot subtotal (2 × 1000), never re-derived.
		expect(reread!.totals.subtotal).toBe(2000);
	});
});
