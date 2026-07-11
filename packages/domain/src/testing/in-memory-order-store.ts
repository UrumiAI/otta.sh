import { cents } from "../money/cents.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CreateOrderInput,
	CreateOrderResult,
	OrderStore,
	RecordPaymentInput,
} from "../ports/order-store.js";
import type { Order, OrderLine, OrderState, OrderTotals } from "../orders/model.js";

interface StoredOrder {
	order: Order;
}

interface StoredPayment {
	orderId: string;
	providerRef: string;
}

/**
 * IO-free `OrderStore` fake — the first adapter to pass `orderStoreContract`.
 * Models the real adapter: an `idempotency_key`-guarded create (replay returns
 * the existing order, no re-snapshot), immutable `order_items`, a 1:1
 * `order_totals`, and guarded state flips. Deterministic and synchronous so the
 * contract's replay / snapshot-immutability / illegal-transition cases run here
 * first.
 */
export class InMemoryOrderStore implements OrderStore {
	#idGen: IdGen;
	#clock: Clock;
	#orders = new Map<string, StoredOrder>();
	#byKey = new Map<string, string>();
	#payments: StoredPayment[] = [];

	constructor(options: { idGen: IdGen; clock: Clock }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async createFromCart(input: CreateOrderInput): Promise<CreateOrderResult> {
		const existingId = this.#byKey.get(input.idempotencyKey);
		if (existingId !== undefined) {
			return { created: false, order: this.#clone(this.#orders.get(existingId)!.order) };
		}

		const now = this.#clock.now().toISOString();
		const orderId = input.orderId;
		const lines: OrderLine[] = input.lines.map((l) => ({
			id: this.#idGen.newId(),
			orderId,
			productId: l.productId,
			sku: l.sku,
			title: l.title,
			unitPrice: l.unitPrice,
			currency: l.currency,
			quantity: l.quantity,
			fulfillmentKind: l.fulfillmentKind,
			reservationId: l.reservationId,
		}));
		const totals: OrderTotals = {
			orderId,
			currency: input.totals.currency,
			subtotal: input.totals.subtotal,
			discount: cents(0),
			shipping: cents(0),
			tax: cents(0),
			total: input.totals.total,
			appliedCouponCode: null,
			shippingMethodSnapshot: null,
			taxBreakdown: null,
		};
		const order: Order = {
			id: orderId,
			cartId: input.cartId,
			currency: input.currency,
			state: "pending",
			idempotencyKey: input.idempotencyKey,
			holdExpiresAt: input.holdExpiresAt,
			paymentMethod: input.paymentMethod,
			buyerRef: input.buyerRef,
			customerId: null,
			createdAt: now,
			updatedAt: now,
			lines,
			totals,
			reconciliationFlag: null,
		};
		this.#orders.set(orderId, { order });
		this.#byKey.set(input.idempotencyKey, orderId);
		return { created: true, order: this.#clone(order) };
	}

	async getById(orderId: OrderId): Promise<Order | null> {
		const stored = this.#orders.get(orderId);
		return stored === undefined ? null : this.#clone(stored.order);
	}

	async getByIdempotencyKey(key: IdempotencyKey): Promise<Order | null> {
		const orderId = this.#byKey.get(key);
		if (orderId === undefined) return null;
		const stored = this.#orders.get(orderId);
		return stored === undefined ? null : this.#clone(stored.order);
	}

	async markPaid(orderId: OrderId): Promise<boolean> {
		return this.#transition(orderId, "pending", "paid");
	}

	async markFailed(orderId: OrderId): Promise<boolean> {
		return this.#transition(orderId, "pending", "failed");
	}

	async expire(orderId: OrderId, now: string): Promise<boolean> {
		const stored = this.#orders.get(orderId);
		if (stored === undefined) return false;
		if (stored.order.state !== "pending") return false;
		if (stored.order.holdExpiresAt > now) return false; // not yet due (re-checked)
		stored.order.state = "expired";
		stored.order.updatedAt = this.#clock.now().toISOString();
		return true;
	}

	async listExpirable(now: string): Promise<OrderId[]> {
		const out: OrderId[] = [];
		for (const stored of this.#orders.values()) {
			if (stored.order.state === "pending" && stored.order.holdExpiresAt <= now) {
				out.push(stored.order.id);
			}
		}
		return out;
	}

	async recordPayment(input: RecordPaymentInput): Promise<void> {
		if (this.#payments.some((p) => p.providerRef === input.providerRef)) return; // idempotent
		this.#payments.push({ orderId: input.orderId, providerRef: input.providerRef });
	}

	async flagReconciliation(orderId: OrderId, detail: string): Promise<void> {
		const stored = this.#orders.get(orderId);
		if (stored === undefined) return;
		stored.order.reconciliationFlag = detail;
		stored.order.updatedAt = this.#clock.now().toISOString();
	}

	// -- test surface ---------------------------------------------------------

	/** Payments recorded (for contract assertions). */
	payments(orderId: string): StoredPayment[] {
		return this.#payments.filter((p) => p.orderId === orderId);
	}

	// -- internals ------------------------------------------------------------

	#transition(orderId: OrderId, from: OrderState, to: OrderState): boolean {
		const stored = this.#orders.get(orderId);
		if (stored === undefined || stored.order.state !== from) return false;
		stored.order.state = to;
		stored.order.updatedAt = this.#clock.now().toISOString();
		return true;
	}

	#clone(order: Order): Order {
		return {
			...order,
			lines: order.lines.map((l) => ({ ...l })),
			totals: { ...order.totals },
		};
	}
}
