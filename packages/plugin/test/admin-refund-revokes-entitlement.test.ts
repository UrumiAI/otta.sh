/**
 * The admin refund path wires the entitlement store into `refundOrder`, so a FULL
 * refund from the console revokes the order's download access and a partial one
 * does not (issue #376). The domain proves the rule over the fakes; this proves the
 * composition: `refundOrder`'s `entitlementStore` dependency is optional, so a
 * composition that forgot it would refund correctly and leave the file
 * downloadable — nothing else would fail.
 *
 * Real document store (in-memory SQLite, the host's migrations), the client's own
 * stores; the gateway is the domain's fake Stripe, since the provider leg is not
 * what is under test here.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	type OrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
const FAR = "2099-01-01T00:00:00.000Z";

let harness: InProcessCommerceHarness;
const gateways = { stripe: new FakePaymentGateway({ id: "stripe" }) };

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce({ gateways });
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

/** A paid card order for one digital line, with its $15.00 captured and its
 *  entitlement granted under settlement's own key — the state `settleOrder` leaves. */
async function seedPaidDigital(id: string): Promise<OrderId> {
	const oid = toOrderId(id);
	const sku = toSku(`DIG-${id}`);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: FAR,
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku,
				title: "Ebook",
				unitPrice: cents(1500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
	});
	await harness.stores.orderStore.markPaid(oid);
	await harness.stores.orderStore.recordPayment({
		orderId: oid,
		gateway: "stripe",
		providerRef: `pi_${id}`,
		amount: cents(1500),
		currency: USD,
		status: "succeeded",
	});
	await harness.stores.entitlementStore.grant({
		orderId: oid,
		productId: toProductId(`prod-${id}`),
		sku,
		buyerRef: "buyer@example.com",
		source: "order_paid",
		grantIdempotencyKey: toIdempotencyKey(`ent:${id}:${sku}`),
	});
	return oid;
}

function entitled(id: string): Promise<boolean> {
	return harness.stores.entitlementStore.check({ orderId: toOrderId(id), sku: toSku(`DIG-${id}`) });
}

describe("the admin refund revokes download access on a FULL refund only", () => {
	test("a full refund revokes the order's entitlement", async () => {
		const id = await seedPaidDigital("ord-full");
		const orders = new InProcessAdminOrdersClient(harness.ctx, { gateways });
		const res = await orders.refundOrder(
			id,
			{ amountCents: 1500, currency: "USD", refundedBy: "carol" },
			{ idempotencyKey: "k-full" },
		);
		expect(res).toMatchObject({ ok: true, fullyRefunded: true });
		expect(await entitled(id)).toBe(false);
	});

	test("a partial refund leaves it entitled", async () => {
		const id = await seedPaidDigital("ord-part");
		const orders = new InProcessAdminOrdersClient(harness.ctx, { gateways });
		const res = await orders.refundOrder(
			id,
			{ amountCents: 400, currency: "USD", refundedBy: "carol" },
			{ idempotencyKey: "k-part" },
		);
		expect(res).toMatchObject({ ok: true, fullyRefunded: false });
		expect(await entitled(id)).toBe(true);
	});
});
