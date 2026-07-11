import { cents, currency as brandCurrency } from "../money/cents.js";
import {
	idempotencyKey,
	orderId as brandOrderId,
	productId,
	reservationId,
	sku as brandSku,
} from "../money/ids.js";
import type { OrderId, ReservationId, Sku } from "../money/ids.js";
import type { PaymentGateway, RawConfirmation } from "../ports/payment-gateway.js";
import type { SettleDeps } from "../orders/settle-order.js";
import { CountingIdGen, FixedClock } from "./deterministic.js";
import { InMemoryEntitlementStore } from "./in-memory-entitlement-store.js";
import { InMemoryInventoryStore } from "./in-memory-inventory-store.js";
import { InMemoryOrderStore } from "./in-memory-order-store.js";
import {
	InMemoryPaymentEventStore,
	type RecordedAnomaly,
} from "./in-memory-payment-event-store.js";

/** Fields a gateway needs to mint a raw confirmation the contract will verify. */
export interface GatewayConfirmInput {
	orderId: OrderId;
	amountCents: number;
	currency: string;
	outcome: "succeeded" | "failed";
	dedupeKey: string;
	providerRef: string;
}

export interface GatewayHarnessConfig {
	gateway: PaymentGateway;
	/** Mint a VALID raw confirmation for the gateway under test. */
	confirm(input: GatewayConfirmInput): RawConfirmation;
	/** Mint a raw confirmation whose signature is invalid. */
	confirmBadSignature(input: GatewayConfirmInput): RawConfirmation;
}

export interface PaymentGatewayHarness {
	gateway: PaymentGateway;
	settleDeps: SettleDeps;
	confirm(input: GatewayConfirmInput): RawConfirmation;
	confirmBadSignature(input: GatewayConfirmInput): RawConfirmation;
	/** Seed a pending PHYSICAL order with an adopted reservation. */
	seedPhysicalOrder(
		amountCents: number,
		cur?: string,
	): Promise<{ orderId: OrderId; reservationId: ReservationId; sku: Sku }>;
	/** Seed a pending DIGITAL order (no reservation). */
	seedDigitalOrder(amountCents: number, cur?: string): Promise<{ orderId: OrderId; sku: Sku }>;
	reservationState(id: string): string;
	hasEntitlement(orderId: OrderId, sku: Sku): Promise<boolean>;
	orderState(orderId: OrderId): Promise<string | null>;
	anomalies(): RecordedAnomaly[];
}

const FUTURE = "2026-07-10T00:15:00.000Z";
const NOW = "2026-07-10T00:00:00.000Z";

/**
 * Wire the in-memory stores + a gateway into a `PaymentGatewayHarness` so
 * `paymentGatewayContract` can drive `settleOrder` end-to-end against ANY gateway
 * (the fake, then the real Stripe / x402 adapters — the gateway only supplies
 * verify+mint; the settle orchestration is store-agnostic).
 */
export function buildGatewayHarness(config: GatewayHarnessConfig): PaymentGatewayHarness {
	const clock = new FixedClock(new Date(NOW));
	const inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
	const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	const entitlementStore = new InMemoryEntitlementStore({ idGen: new CountingIdGen("ent"), clock });
	const paymentEventStore = new InMemoryPaymentEventStore();
	const settleDeps: SettleDeps = {
		orderStore,
		entitlementStore,
		paymentEventStore,
		inventoryStore: inventory,
		clock,
	};

	let n = 0;
	return {
		gateway: config.gateway,
		settleDeps,
		confirm: config.confirm,
		confirmBadSignature: config.confirmBadSignature,
		async seedPhysicalOrder(amountCents, cur = "USD") {
			n++;
			const cy = brandCurrency(cur);
			const skuStr = `SKU-${n}`;
			inventory.seed(skuStr, 100);
			const reserved = await inventory.reserve(skuStr, 1, idempotencyKey(`res-key-${n}`));
			if (!reserved.ok) throw new Error("seed reserve failed");
			const oid = brandOrderId(`ord-${n}`);
			await orderStore.createFromCart({
				orderId: oid,
				cartId: `cart-${n}`,
				currency: cy,
				idempotencyKey: idempotencyKey(`ok-${n}`),
				holdExpiresAt: FUTURE,
				buyerRef: `buyer-${n}@example.com`,
				paymentMethod: config.gateway.id,
				lines: [
					{
						productId: productId(`p-${n}`),
						sku: brandSku(skuStr),
						title: `Item ${n}`,
						unitPrice: cents(amountCents),
						currency: cy,
						quantity: 1,
						fulfillmentKind: "physical",
						reservationId: reservationId(reserved.reservationId),
					},
				],
				totals: { subtotal: cents(amountCents), total: cents(amountCents), currency: cy },
			});
			const adopted = await inventory.adopt({
				reservationId: reserved.reservationId,
				orderId: oid,
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			if (!adopted.ok) throw new Error("seed adopt failed");
			return {
				orderId: oid,
				reservationId: reservationId(reserved.reservationId),
				sku: brandSku(skuStr),
			};
		},
		async seedDigitalOrder(amountCents, cur = "USD") {
			n++;
			const cy = brandCurrency(cur);
			const skuStr = `DIG-${n}`;
			const oid = brandOrderId(`ord-${n}`);
			await orderStore.createFromCart({
				orderId: oid,
				cartId: `cart-${n}`,
				currency: cy,
				idempotencyKey: idempotencyKey(`ok-${n}`),
				holdExpiresAt: FUTURE,
				buyerRef: `buyer-${n}@example.com`,
				paymentMethod: config.gateway.id,
				lines: [
					{
						productId: productId(`p-${n}`),
						sku: brandSku(skuStr),
						title: `Ebook ${n}`,
						unitPrice: cents(amountCents),
						currency: cy,
						quantity: 1,
						fulfillmentKind: "digital",
						reservationId: null,
					},
				],
				totals: { subtotal: cents(amountCents), total: cents(amountCents), currency: cy },
			});
			return { orderId: oid, sku: brandSku(skuStr) };
		},
		reservationState(id) {
			return inventory.reservationState(id);
		},
		async hasEntitlement(oid, s) {
			return entitlementStore.check({ orderId: oid, sku: s });
		},
		async orderState(oid) {
			return (await orderStore.getById(oid))?.state ?? null;
		},
		anomalies() {
			return paymentEventStore.anomalies();
		},
	};
}
