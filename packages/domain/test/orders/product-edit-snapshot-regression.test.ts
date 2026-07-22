import {
	cents,
	createOrderFromCart,
	currency,
	idempotencyKey,
	money,
	productId as brandProductId,
	updateProductCommerceFields,
} from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { makeOrderHarness } from "./fake-harness.js";

/**
 * Snapshot-invariant regression (CLAUDE.md: "editing a product NEVER rewrites
 * an existing order's line items"). A standalone admin edit of a product's
 * price + title (admin-UX Increment 2 slice 2) writes ONLY `product_commerce`;
 * an order's `order_items` are an independent snapshot taken once at purchase
 * time (create-order-from-cart §4), so they must survive the edit byte-for-byte.
 * This test pins that: place an order, edit the product, assert the order's
 * lines are unchanged.
 */
describe("product edit never rewrites an existing order's line snapshot", () => {
	test("editing price + title leaves a placed order's line items byte-identical", async () => {
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

		// Now EDIT the product: new price AND new title, under the row's own
		// optimistic-concurrency watermark.
		const pid = brandProductId("prod-1");
		const current = await h.productCommerce.getByProductId(pid);
		expect(current).not.toBeNull();
		const edit = await updateProductCommerceFields(
			h.productCommerce,
			{ productId: pid, price: money(cents(9999), currency("USD")), title: "Renamed Product" },
			idempotencyKey("edit-1"),
			current!.updatedAt.toISOString(),
		);
		expect(edit.ok).toBe(true);

		// The product itself changed (sanity — the edit really applied)…
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
