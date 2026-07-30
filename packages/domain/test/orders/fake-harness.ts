import {
	addLine,
	type CartDeps,
	cents,
	createCart,
	currency,
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
	x402Gw: FakePaymentGateway;
	createDeps: CreateOrderDeps;
	cartDeps: CartDeps;
	settleDeps: SettleDeps;
	expireDeps: ExpireOrdersDeps;
	seedPhysical(input: SeedInput & { onHand: number }): Promise<void>;
	seedDigital(input: SeedInput): Promise<void>;
	cartWith(lines: CartLineSpec[]): Promise<string>;
}

interface SeedInput {
	productId: string;
	sku: string;
	priceCents: number;
	title: string;
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
	const x402Gw = new FakePaymentGateway({ id: "x402" });

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
		gateways: { stripe: stripeGw, x402: x402Gw },
	};
	const settleDeps: SettleDeps = {
		orderStore,
		entitlementStore,
		paymentEventStore,
		inventoryStore: inventory,
		couponStore,
		clock,
	};
	const expireDeps: ExpireOrdersDeps = {
		orderStore,
		inventoryStore: inventory,
		couponStore,
		clock,
	};

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
		x402Gw,
		createDeps,
		cartDeps,
		settleDeps,
		expireDeps,
		async seedPhysical(input) {
			await productCommerce.upsert(
				{
					productId: brandProductId(input.productId),
					sku: brandSku(input.sku),
					price: money(cents(input.priceCents), USD),
					title: input.title,
					productKind: "physical",
				},
				idempotencyKey(`seed-${seq++}`),
			);
			inventory.seed(input.sku, input.onHand);
		},
		async seedDigital(input) {
			await productCommerce.upsert(
				{
					productId: brandProductId(input.productId),
					sku: brandSku(input.sku),
					price: money(cents(input.priceCents), USD),
					title: input.title,
					productKind: "digital",
				},
				idempotencyKey(`seed-${seq++}`),
			);
		},
		async cartWith(specs) {
			const cartId = await createCart(cartDeps, USD);
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
