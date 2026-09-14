/**
 * One cancellation case that needs the FULL order harness, factored out so all three
 * dialects run it — the two Node ones through
 * `order-cancellation-contract.dialects.test.ts` and D1 through its own spec, which
 * cannot import a `.dialects.test.ts` (that file pulls in `better-sqlite3` and `pg` at
 * module scope, neither of which exists inside `workerd`).
 *
 * **The release bracket's sharp edge.** Cancelling a PAID order whose holds settle
 * already COMMITTED must return nothing: the intent is recorded and completed exactly
 * as it is for a pending order, but `releaseAdopted` only ever touches a hold that is
 * still `adopted` BY THIS ORDER, and a committed hold is not. Spent units stay spent —
 * the guard, not the caller, is what makes recording the release intent on every cancel
 * safe, and this case is what pins it.
 *
 * It is a plain module rather than a `.test.ts` for the same reason
 * `order-contract-b2.ts` is.
 */
import { cancelOrder, createOrderFromCart, idempotencyKey, settleOrder } from "@otta-sh/domain";
import { expect, test } from "vitest";
import type { OrderHarness } from "./order-harness.js";

/** Register the case against a factory for a fresh full order harness. */
export function cancellationReleaseCase(makeHarness: () => OrderHarness): void {
	test("cancelling a PAID order completes the release without returning committed units", async () => {
		const full = makeHarness();
		await full.seedPhysical({
			productId: "p-cx",
			sku: "SKU-CX-PAID",
			priceCents: 500,
			title: "Widget",
			onHand: 5,
		});
		const cartId = await full.cartWith([
			{ sku: "SKU-CX-PAID", productId: "p-cx", qty: 2, kind: "physical" },
		]);
		const created = await createOrderFromCart(full.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("key-cx-paid"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!created.ok) throw new Error(created.reason);
		// Settle: the paid flip, then `commitMany` — the units are now SPENT.
		const settled = await settleOrder(
			full.settleDeps,
			full.stripeGateway,
			full.stripeGateway.webhook({
				outcome: "succeeded",
				orderId: created.order.id,
				providerRef: `pi-${created.order.id}`,
				amount: created.order.totals.total,
				currency: "USD",
				dedupeKey: `evt-${created.order.id}`,
			}),
		);
		expect(settled.ok).toBe(true);
		expect(await full.onHand("SKU-CX-PAID"), "committed stock is gone").toBe(3);

		const res = await cancelOrder(
			{ orderStore: full.store },
			{
				orderId: created.order.id,
				reason: "customer_request",
				cancelledBy: "ops",
				idempotencyKey: idempotencyKey("cx-paid"),
			},
		);
		expect(res.ok && res.cancelled).toBe(true);
		expect((await full.store.getById(created.order.id))?.state).toBe("cancelled");
		// The intent was recorded AND completed — no work is left owed — and not one
		// unit came back.
		const doc = await full.orders.get(created.order.id);
		expect(doc?.holdsReleased?.completedAt).not.toBeNull();
		expect(await full.onHand("SKU-CX-PAID"), "a committed hold is never released").toBe(3);
		expect(await full.reservationState(created.order.lines[0]?.reservationId ?? "")).toBe(
			"committed",
		);
	});
}
