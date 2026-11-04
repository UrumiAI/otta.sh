/**
 * Cancelling an unpaid cash-on-delivery order from the console (ADR-0044).
 *
 * The React console sends NO `restock` for any unpaid order — every state in
 * `UNPAID_ORDER_STATES` (pending, awaiting_payment, shipped_awaiting_payment) —
 * because an unpaid cancel releases the held stock whatever a box would say. The
 * cancel action must therefore not demand the field for any of them: demanding it
 * for the two COD states answered "reload the page" forever and the order could
 * never be cancelled from the console.
 *
 * Driven end to end: a real COD placement over a real document store, the action
 * POSTed exactly as the console posts it (`orders:cancel-<reason>`, no `restock`),
 * and the held unit back on sale afterwards.
 */
import { idempotencyKey as toIdempotencyKey } from "@urumi.ai/otta-domain";
import { CashOnDeliveryGateway } from "@urumi.ai/otta-payments-cod";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { dispatchOrdersAction } from "../src/admin/orders-actions.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const ON_HAND = 3;
const gateway = new CashOnDeliveryGateway();
let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) {
		harness = await makeInProcessCommerce({
			gateways: { cod: gateway },
			resolveOfflinePolicy: async () => ({
				enabled: true,
				maxOpenPerBuyer: 0,
				maxOpenPerClient: 0,
				maxUnitsPerOrder: 0,
			}),
		});
	} else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

let seq = 0;
async function placeCodOrder(): Promise<{ orderId: string; sku: string }> {
	seq += 1;
	const productId = `prod-codcancel-${String(seq)}`;
	const sku = `SKU-CODCANCEL-${String(seq)}`;
	await harness.client.upsertProductCommerce(
		productId,
		{
			sku,
			title: "Mug",
			price: { amount: 1200, currency: "USD" },
			productKind: "physical",
			initialOnHand: ON_HAND,
		},
		`seed-${productId}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`publish-${productId}`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	const added = await harness.client.addCartLine(cartId, sku, productId, 1, `add-${productId}`);
	if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
	const placed = await harness.client.createOrder(
		{
			cartId,
			paymentMethod: "cod",
			buyerRef: "asha@example.test",
			shippingAddress: {
				name: "Asha Rao",
				line1: "12 Park Street",
				city: "Springfield",
				postalCode: "62701",
				country: "US",
				region: "IL",
				phone: "+1 217 555 0100",
			},
			clientKey: "203.0.113.7",
		},
		`checkout:${cartId}`,
	);
	if (!placed.ok) throw new Error(`arrange failed: ${placed.reason}`);
	return { orderId: placed.order.id, sku };
}

/** Whether every unit of `sku` can be held right now — i.e. nothing else holds one. */
async function allUnitsFree(sku: string): Promise<boolean> {
	seq += 1;
	const res = await harness.stores.inventory.reserve(
		sku,
		ON_HAND,
		toIdempotencyKey(`probe-${String(seq)}`),
	);
	if (res.ok) await harness.stores.inventory.release(res.reservationId);
	return res.ok;
}

describe("the console's cancel of an unpaid COD order", () => {
	for (const state of ["awaiting_payment", "shipped_awaiting_payment"] as const) {
		test(`cancels a ${state} order posted with no restock field, and its held unit goes back on sale`, async () => {
			const admin = new InProcessAdminOrdersClient(harness.ctx, { gateways: { cod: gateway } });
			const { orderId, sku } = await placeCodOrder();
			if (state === "shipped_awaiting_payment") {
				const shipped = await admin.recordFulfillment(
					orderId,
					{ carrier: "UPS", trackingNumber: "1Z999", recordedBy: "ops" },
					{ idempotencyKey: `ship-${orderId}` },
				);
				expect(shipped).toMatchObject({ ok: true, state: "shipped_awaiting_payment" });
			}
			expect((await admin.getOrder(orderId))?.order.state).toBe(state);
			expect(await allUnitsFree(sku)).toBe(false);

			const result = await dispatchOrdersAction(
				"orders:cancel-customer_request",
				{ orderId, reason: "customer_request", state },
				admin,
				"ops@example.test",
			);

			expect(result?.notice?.title).not.toMatch(/reload/i);
			expect((await admin.getOrder(orderId))?.order.state).toBe("cancelled");
			expect(await allUnitsFree(sku)).toBe(true);
		});
	}
});
