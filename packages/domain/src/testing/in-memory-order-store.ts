import { cents } from "../money/cents.js";
import type { CustomerId, IdempotencyKey, OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CreateOrderInput,
	CreateOrderResult,
	OrderStore,
	OrderTransitionInput,
	OrderTransitionResult,
	OutboxEmail,
	RecordPaymentInput,
} from "../ports/order-store.js";
import type { Order, OrderLine, OrderState, OrderTotals } from "../orders/model.js";
import { emailTemplateForState } from "../orders/state-machine.js";

interface StoredOrder {
	order: Order;
}

interface StoredPayment {
	orderId: string;
	providerRef: string;
}

type OutboxStatus = "pending" | "sending" | "sent" | "failed";

interface StoredOutbox {
	id: string;
	orderId: string;
	toState: OrderState;
	status: OutboxStatus;
	attempts: number;
	leaseUntil: string | null;
	sentAt: string | null;
	createdAt: string;
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
	#outbox: StoredOutbox[] = [];

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
		return this.#guardedFlip(orderId, "pending", "paid");
	}

	async markFailed(orderId: OrderId): Promise<boolean> {
		return this.#guardedFlip(orderId, "pending", "failed");
	}

	async expire(orderId: OrderId, now: string): Promise<boolean> {
		const stored = this.#orders.get(orderId);
		if (stored === undefined) return false;
		if (stored.order.state !== "pending") return false;
		if (stored.order.holdExpiresAt > now) return false; // not yet due (re-checked)
		stored.order.state = "expired";
		stored.order.updatedAt = this.#clock.now().toISOString();
		// Same-"transaction" outbox enqueue as the real adapter (§5).
		this.#enqueue(orderId, "expired");
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

	// -- Phase 5: state machine + outbox --------------------------------------

	async transition(input: OrderTransitionInput): Promise<OrderTransitionResult> {
		const transitioned = this.#guardedFlip(
			input.orderId,
			input.fromState,
			input.toState,
			input.enqueueEmail,
		);
		const order = await this.getById(input.orderId);
		return { transitioned, order };
	}

	async listForCustomer(customerId: CustomerId): Promise<Order[]> {
		return [...this.#orders.values()]
			.filter((s) => s.order.customerId === customerId)
			.toSorted((a, b) => a.order.createdAt.localeCompare(b.order.createdAt))
			.map((s) => this.#clone(s.order));
	}

	async linkGuestOrders(customerId: CustomerId, buyerRef: string): Promise<number> {
		let linked = 0;
		for (const stored of this.#orders.values()) {
			if (stored.order.buyerRef === buyerRef && stored.order.customerId === null) {
				stored.order.customerId = customerId;
				stored.order.updatedAt = this.#clock.now().toISOString();
				linked++;
			}
		}
		return linked;
	}

	async claimNextEmail(now: string, leaseUntil: string): Promise<OutboxEmail | null> {
		// Claimability is lease-driven: a row is claimable when it isn't sent, isn't
		// failed, and has no live lease (null, or elapsed). This unifies "fresh
		// pending", "crashed 'sending' whose lease expired", and "rescheduled with a
		// retry backoff" — a rescheduled row is not re-claimed until its lease passes.
		const claimable = this.#outbox
			.filter(
				(r) =>
					r.sentAt === null &&
					r.status !== "failed" &&
					(r.leaseUntil === null || r.leaseUntil <= now),
			)
			.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
		const row = claimable[0];
		if (row === undefined) return null;
		row.status = "sending";
		row.leaseUntil = leaseUntil;
		row.attempts += 1;
		return {
			id: row.id,
			orderId: row.orderId as OrderId,
			toState: row.toState,
			attempts: row.attempts,
		};
	}

	async markEmailSent(id: string, now: string): Promise<void> {
		const row = this.#outbox.find((r) => r.id === id);
		if (row === undefined) return;
		row.status = "sent";
		row.sentAt = now;
	}

	async rescheduleEmail(id: string, retryAt: string | null): Promise<void> {
		const row = this.#outbox.find((r) => r.id === id);
		if (row === undefined) return;
		if (retryAt === null) {
			row.status = "failed";
			row.leaseUntil = null;
		} else {
			row.status = "pending";
			row.leaseUntil = retryAt; // backoff — not re-claimable until retryAt
		}
	}

	// -- test surface ---------------------------------------------------------

	/** Payments recorded (for contract assertions). */
	payments(orderId: string): StoredPayment[] {
		return this.#payments.filter((p) => p.orderId === orderId);
	}

	/** Outbox rows for an order (for contract assertions). */
	outboxFor(orderId: string): { toState: OrderState; status: OutboxStatus }[] {
		return this.#outbox
			.filter((r) => r.orderId === orderId)
			.map((r) => ({ toState: r.toState, status: r.status }));
	}

	// -- internals ------------------------------------------------------------

	#guardedFlip(orderId: OrderId, from: OrderState, to: OrderState, enqueue?: boolean): boolean {
		const stored = this.#orders.get(orderId);
		if (stored === undefined || stored.order.state !== from) return false;
		stored.order.state = to;
		stored.order.updatedAt = this.#clock.now().toISOString();
		// markPaid/markFailed pass no explicit flag → enqueue iff the target state
		// has a template (paid ⇒ yes, failed ⇒ no); `transition` passes it explicitly.
		const shouldEnqueue = enqueue ?? emailTemplateForState(to) !== null;
		if (shouldEnqueue) this.#enqueue(orderId, to);
		return true;
	}

	/** Outbox INSERT … ON CONFLICT(order_id, to_state) DO NOTHING (§5). */
	#enqueue(orderId: string, toState: OrderState): void {
		if (this.#outbox.some((r) => r.orderId === orderId && r.toState === toState)) return;
		this.#outbox.push({
			id: this.#idGen.newId(),
			orderId,
			toState,
			status: "pending",
			attempts: 0,
			leaseUntil: null,
			sentAt: null,
			createdAt: this.#clock.now().toISOString(),
		});
	}

	#clone(order: Order): Order {
		return {
			...order,
			lines: order.lines.map((l) => ({ ...l })),
			totals: { ...order.totals },
		};
	}
}
