/**
 * Every admin path that returns an order's money IN FULL wires the entitlement
 * store into its use-case, so it revokes the order's download access (issue #376):
 * Money → Refunds (`refundOrder`), Mark refunded (`transitionOrderAsAdmin`), Cancel
 * order (`cancelOrderWithRefund`) and resolving an unverified refund
 * (`resolveUnverifiedRefund`). The domain proves each rule over the fakes; this
 * proves the composition: the dependency is optional on every one of those
 * use-cases, so a composition that forgot it would return the money correctly and
 * leave the file downloadable — nothing else would fail.
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
	PROVIDER_REFUNDED_FLAG_PREFIX,
	productId as toProductId,
	refundOrder as refundOrderUseCase,
	sku as toSku,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { dispatchOrdersAction } from "../src/admin/orders-actions.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
const FAR = "2099-01-01T00:00:00.000Z";

let harness: InProcessCommerceHarness;
const gateways = {
	stripe: new FakePaymentGateway({ id: "stripe" }),
};

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

describe("the other full-refund paths revoke from the admin console too", () => {
	test("Mark refunded revokes", async () => {
		// The provider reported the payment refunded in full (a refund made in its
		// dashboard), the one state in which Mark refunded is the way to record it.
		const id = await seedPaidDigital("ord-mark");
		await harness.stores.orderStore.flagReconciliation(
			toOrderId("ord-mark"),
			`${PROVIDER_REFUNDED_FLAG_PREFIX} — test`,
		);
		const orders = new InProcessAdminOrdersClient(harness.ctx, { gateways });
		const res = await orders.transitionOrder(id, "refunded", { idempotencyKey: "k-mark" });
		expect(res).toMatchObject({ ok: true, transitioned: true });
		expect(await entitled(id)).toBe(false);
	});

	test("Cancel order on a paid order refunds it in full and revokes", async () => {
		const id = await seedPaidDigital("ord-cancel");
		const orders = new InProcessAdminOrdersClient(harness.ctx, { gateways });
		const res = await orders.cancelOrder(
			id,
			{ reason: "customer_request", cancelledBy: "carol" },
			{ idempotencyKey: "k-cancel" },
		);
		expect(res).toMatchObject({ ok: true, cancelled: true });
		expect(await entitled(id)).toBe(false);
	});

	test("confirming an unverified full refund revokes", async () => {
		const id = await seedPaidDigital("ord-unv");
		const orders = new InProcessAdminOrdersClient(harness.ctx, { gateways });
		gateways.stripe.setRefundResult({ ok: false, reason: "UNVERIFIED" });
		try {
			await orders.refundOrder(
				id,
				{ amountCents: 1500, currency: "USD", refundedBy: "carol" },
				{ idempotencyKey: "k-unv" },
			);
		} finally {
			gateways.stripe.clearRefundResult();
		}
		expect(await entitled(id)).toBe(true);
		const res = await orders.resolveUnverifiedRefund(id, {
			refundKey: "k-unv",
			outcome: "confirmed",
			resolvedBy: "carol",
		});
		expect(res).toMatchObject({ ok: true });
		expect(await entitled(id)).toBe(false);
	});
});

describe("the console's re-click finishes a refund whose revoke never ran (issue #405, item 3)", () => {
	/**
	 * The crash between refund and revoke: the refund is recorded and the order is
	 * `refunded`, but the process died before `revokeByOrder`, so the grant is
	 * still active. That state is built here by running the domain use-case
	 * WITHOUT an entitlement store, under the very key the console derives — the
	 * money leg exactly as a real run leaves it, minus the revoke.
	 */
	async function crashBeforeRevoke(id: string): Promise<OrderId> {
		const oid = await seedPaidDigital(id);
		const res = await refundOrderUseCase(
			{
				orderStore: harness.stores.orderStore,
				paymentEventStore: harness.stores.paymentEventStore,
				clock: harness.stores.clock,
			},
			gateways.stripe,
			{
				orderId: oid,
				amount: cents(1500),
				currency: USD,
				reason: null,
				refundedBy: "carol",
				idempotencyKey: toIdempotencyKey(`admin-refund:${id}:1500:0`),
			},
		);
		expect(res).toMatchObject({ ok: true, fullyRefunded: true });
		expect(await entitled(id)).toBe(true);
		return oid;
	}

	test("re-clicking the same refund revokes the entitlement and asks the provider for nothing", async () => {
		const id = "ord-crash";
		await crashBeforeRevoke(id);
		const providerCallsBefore = gateways.stripe.refundCalls.length;
		const orders = new InProcessAdminOrdersClient(harness.ctx, { gateways });

		// The operator's re-click: the SAME confirm, so its watermark (0) is now
		// stale against the ledger its own refund moved.
		const result = await dispatchOrdersAction(
			"orders:refund",
			{ orderId: id, amountCents: "1500", refundedSoFarCents: "0", currency: "USD" },
			orders,
			"carol",
		);

		expect(result?.notice).toMatchObject({ variant: "default", title: "Already refunded" });
		expect(await entitled(id)).toBe(false);
		// The replay resolves on the recorded row: no second provider refund.
		expect(gateways.stripe.refundCalls.length).toBe(providerCallsBefore);
		expect(await harness.stores.orderStore.listRefunds(toOrderId(id))).toHaveLength(1);
	});
});
