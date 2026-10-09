import {
	addLine,
	type CartDeps,
	cents,
	createCart,
	currency,
	type Currency,
	type CreateOrderDeps,
	type ExpireOrdersDeps,
	type FulfillmentKind,
	idempotencyKey,
	money,
	productId as brandProductId,
	type SettleDeps,
	sku as brandSku,
} from "@otta-sh/domain";
import {
	CountingIdGen,
	FakePaymentGateway,
	FixedClock,
	InMemoryCartStore,
	InMemoryCouponStore,
	InMemoryEntitlementStore,
	InMemoryInventoryStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	InMemoryProductCommerceStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
} from "@otta-sh/domain/testing";

export const USD = currency("USD");

/** The publish watermark every seeded product carries — older than any lifecycle
 *  event a case applies afterwards, so a later unpublish is never "stale". */
export const SEED_PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

export interface OrderHarness {
	clock: FixedClock;
	inventory: InMemoryInventoryStore;
	cartStore: InMemoryCartStore;
	productCommerce: InMemoryProductCommerceStore;
	orderStore: InMemoryOrderStore;
	entitlementStore: InMemoryEntitlementStore;
	paymentEventStore: InMemoryPaymentEventStore;
	shippingRules: InMemoryShippingRulesStore;
	taxRules: InMemoryTaxRulesStore;
	couponStore: InMemoryCouponStore;
	stripeGw: FakePaymentGateway;
	/** A Stripe-id gateway that cannot refund (`refundable:false`): the manual / record-only path. */
	manualGw: FakePaymentGateway;
	createDeps: CreateOrderDeps;
	cartDeps: CartDeps;
	settleDeps: SettleDeps;
	expireDeps: ExpireOrdersDeps;
	seedPhysical(input: SeedInput & { onHand: number }): Promise<void>;
	seedDigital(input: SeedInput): Promise<void>;
	/** `code` defaults to USD (the payment-rounding suite prices in KWD). */
	cartWith(lines: CartLineSpec[], code?: string): Promise<string>;
}

interface SeedInput {
	productId: string;
	sku: string;
	priceCents: number;
	title: string;
	/** Defaults to USD. */
	currency?: Currency;
}

interface CartLineSpec {
	sku: string;
	productId: string;
	qty: number;
	kind: FulfillmentKind;
}

let seq = 0;

export function makeOrderHarness(): OrderHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
	const cartStore = new InMemoryCartStore({
		idGen: new CountingIdGen("cart"),
		reservationState: (id) => {
			try {
				return inventory.reservationState(id);
			} catch {
				return undefined;
			}
		},
		releaseHold: (id) => {
			void inventory.release(id);
		},
	});
	const productCommerce = new InMemoryProductCommerceStore({ clock });
	const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	const entitlementStore = new InMemoryEntitlementStore({ idGen: new CountingIdGen("ent"), clock });
	const paymentEventStore = new InMemoryPaymentEventStore();
	const shippingRules = new InMemoryShippingRulesStore();
	const taxRules = new InMemoryTaxRulesStore();
	const couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
	const stripeGw = new FakePaymentGateway({ id: "stripe" });
	const manualGw = new FakePaymentGateway({ id: "stripe", refundable: false });

	const cartDeps: CartDeps = { cartStore, inventoryStore: inventory, clock };
	const createDeps: CreateOrderDeps = {
		orderStore,
		cartStore,
		inventoryStore: inventory,
		productCommerce,
		shippingRules,
		taxRules,
		couponStore,
		clock,
		idGen: new CountingIdGen("order"),
		gateways: { stripe: stripeGw },
	};
	const settleDeps: SettleDeps = {
		orderStore,
		entitlementStore,
		paymentEventStore,
		inventoryStore: inventory,
		clock,
	};
	const expireDeps: ExpireOrdersDeps = {
		orderStore,
		inventoryStore: inventory,
		couponStore,
		clock,
	};

	/** A seeded product is a SELLABLE one: published through the same publish-gate
	 *  flip `content:afterPublish` drives, since checkout refuses an unpublished row. */
	async function publish(id: string): Promise<void> {
		await productCommerce.activate(
			brandProductId(id),
			idempotencyKey(`publish-${seq++}`),
			SEED_PUBLISHED_AT,
		);
	}

	return {
		clock,
		inventory,
		cartStore,
		productCommerce,
		orderStore,
		entitlementStore,
		paymentEventStore,
		shippingRules,
		taxRules,
		couponStore,
		stripeGw,
		manualGw,
		createDeps,
		cartDeps,
		settleDeps,
		expireDeps,
		async seedPhysical(input) {
			await productCommerce.upsert(
				{
					productId: brandProductId(input.productId),
					sku: brandSku(input.sku),
					price: money(cents(input.priceCents), input.currency ?? USD),
					title: input.title,
					productKind: "physical",
				},
				idempotencyKey(`seed-${seq++}`),
			);
			await publish(input.productId);
			inventory.seed(input.sku, input.onHand);
		},
		async seedDigital(input) {
			await productCommerce.upsert(
				{
					productId: brandProductId(input.productId),
					sku: brandSku(input.sku),
					price: money(cents(input.priceCents), input.currency ?? USD),
					title: input.title,
					productKind: "digital",
				},
				idempotencyKey(`seed-${seq++}`),
			);
			await publish(input.productId);
		},
		async cartWith(specs, code) {
			const cartId = await createCart(cartDeps, code === undefined ? USD : currency(code));
			for (const spec of specs) {
				const res = await addLine(
					cartDeps,
					cartId,
					brandSku(spec.sku),
					spec.productId,
					spec.qty,
					idempotencyKey(`add-${seq++}`),
					spec.kind,
				);
				if (!res.ok) throw new Error(`seed addLine failed: ${res.reason}`);
			}
			return cartId;
		},
	};
}
