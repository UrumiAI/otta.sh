/**
 * Seeds one product, one order and one coupon straight through the adapter
 * stores (the same adapters the plugin composes), over the harness's real SQLite
 * document store. Reports roll up from the order store, so the order's revenue
 * is visible to the report tools.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	money,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import type { PluginContext } from "@urumi.ai/otta-plugin";
import {
	EmdashCouponStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashProductCommerceStore,
	EmdashReportingStore,
	systemClock,
	uuidIdGen,
} from "@urumi.ai/otta-store-emdash";

const USD = toCurrency("USD");

export const SEED = {
	productId: "seed-prod",
	sku: "SEED-SKU",
	title: "Blue Widget",
	priceCents: 1999,
	onHand: 3,
	orderId: "seed-order",
	orderTotalCents: 1999,
	couponId: "seed-coupon",
	couponCode: "SAVE5",
	refundedCents: 500,
} as const;

export async function seedStore(ctx: PluginContext): Promise<void> {
	const storage = ctx.storage;
	if (storage === undefined) throw new Error("harness has no storage");
	const clock = systemClock;
	const idGen = uuidIdGen;
	const inventory = new EmdashInventoryStore({ storage, idGen, clock });
	const reporting = new EmdashReportingStore({ storage, clock });
	const orders = new EmdashOrderStore({ storage, inventory, idGen, clock, reporting });
	const products = new EmdashProductCommerceStore({ storage, clock });
	const coupons = new EmdashCouponStore({ storage, idGen, clock });

	await products.upsert(
		{
			productId: toProductId(SEED.productId),
			sku: toSku(SEED.sku),
			title: SEED.title,
			price: money(cents(SEED.priceCents), USD),
			productKind: "physical",
		},
		toIdempotencyKey("seed-product"),
	);
	await inventory.seedOnHand(SEED.sku, SEED.onHand);

	const oid = toOrderId(SEED.orderId);
	await orders.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey("seed-order"),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(SEED.productId),
				sku: toSku(SEED.sku),
				title: SEED.title,
				unitPrice: cents(SEED.orderTotalCents),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: {
			subtotal: cents(SEED.orderTotalCents),
			total: cents(SEED.orderTotalCents),
			currency: USD,
		},
	});
	await orders.markPaid(oid);
	await orders.recordPayment({
		orderId: oid,
		gateway: "stripe",
		providerRef: "pi_seed",
		amount: cents(SEED.orderTotalCents),
		currency: USD,
		status: "succeeded",
	});
	await orders.recordRefund({
		orderId: oid,
		amount: cents(SEED.refundedCents),
		currency: USD,
		kind: "gateway",
		gateway: "stripe",
		refundRef: "re_seed",
		reason: null,
		refundedBy: "seed",
		idempotencyKey: toIdempotencyKey("seed-refund"),
	});

	await coupons.create({
		id: SEED.couponId,
		code: SEED.couponCode,
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: null,
		maxUsesPerCustomer: null,
	});
}
