/**
 * The delivery gate's three real shapes, as cases both the Node dialects and D1 run.
 *
 * They are shared rather than copied because they ARE the read contract: every one of
 * them binds a declared index, and the tier that plans the query is the tier where
 * that contract is worth checking. `entitlement-lookup-indices.dialects.test.ts` adds
 * the negative half (the same call over a layout with the indexes stripped), which is
 * a statement about the host's filter algebra and therefore identical everywhere.
 */
import { idempotencyKey, orderId, productId, sku } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import type { MiscHarness } from "./misc-harness.js";

const SKU = sku("DIG-1");
/** Mixed case on purpose: a buyer reference carries email semantics. */
const BUYER = "Mixed.Case.Buyer@Example.com";

/** The one grant every shape resolves to. */
export async function seedGrantedEntitlement(h: MiscHarness): Promise<void> {
	await h.entitlementStore.grant({
		orderId: orderId("ord-target"),
		productId: productId("p1"),
		sku: SKU,
		buyerRef: BUYER,
		source: "order_paid",
		grantIdempotencyKey: idempotencyKey("grant-target"),
	});
}

/** Register the three shapes against a fresh harness per case. */
export function entitlementGateCases(dialect: string, makeHarness: () => MiscHarness): void {
	describe(`entitlement delivery gate [${dialect}]`, () => {
		test("the order scope resolves, and another order does not", async () => {
			const h = makeHarness();
			await seedGrantedEntitlement(h);
			expect(await h.entitlementStore.check({ orderId: orderId("ord-target"), sku: SKU })).toBe(
				true,
			);
			expect(await h.entitlementStore.check({ orderId: orderId("ord-other"), sku: SKU })).toBe(
				false,
			);
		});

		test("the buyer scope resolves folded, and another buyer does not", async () => {
			const h = makeHarness();
			await seedGrantedEntitlement(h);
			expect(await h.entitlementStore.check({ buyerRef: BUYER.toUpperCase(), sku: SKU })).toBe(
				true,
			);
			expect(await h.entitlementStore.check({ buyerRef: BUYER.toLowerCase(), sku: SKU })).toBe(
				true,
			);
			expect(await h.entitlementStore.check({ buyerRef: "someone@else.example", sku: SKU })).toBe(
				false,
			);
		});

		test("the operator shape ANDs both scopes — either half wrong is a refusal", async () => {
			const h = makeHarness();
			await seedGrantedEntitlement(h);
			expect(
				await h.entitlementStore.check({
					orderId: orderId("ord-target"),
					buyerRef: BUYER.toUpperCase(),
					sku: SKU,
				}),
			).toBe(true);
			// The right buyer on the wrong order, and the right order with the wrong buyer,
			// are both refusals: this shape is a conjunction, not a union.
			expect(
				await h.entitlementStore.check({
					orderId: orderId("ord-other"),
					buyerRef: BUYER,
					sku: SKU,
				}),
			).toBe(false);
			expect(
				await h.entitlementStore.check({
					orderId: orderId("ord-target"),
					buyerRef: "someone@else.example",
					sku: SKU,
				}),
			).toBe(false);
			// And the sku still scopes both.
			expect(
				await h.entitlementStore.check({
					orderId: orderId("ord-target"),
					buyerRef: BUYER,
					sku: sku("OTHER"),
				}),
			).toBe(false);
		});
	});
}
