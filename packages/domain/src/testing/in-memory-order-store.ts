import { cents, currency as toCurrency } from "../money/cents.js";
import {
	type CustomerId,
	idempotencyKey as toIdempotencyKey,
	type IdempotencyKey,
	type OrderId,
	orderId as toOrderId,
} from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CreateOrderInput,
	CreateOrderResult,
	OrderListFilter,
	OrderListPage,
	OrderListResult,
	OrderStore,
	OrderSummary,
	OrderTransitionInput,
	OrderTransitionResult,
	OutboxEmail,
	RecordPaymentInput,
	ResolveReconciliationInput,
	ResolveReconciliationStoreResult,
} from "../ports/order-store.js";
import type { Order, OrderLine, OrderState, OrderTotals, PaymentMethod } from "../orders/model.js";

/** Test-only seed shape for the admin-list contract — a direct order row (no
 *  cart/reservation flow), so a case can pin an EXACT `createdAt`/`state`/
 *  `buyerRef`/`total` per row (MOD-5: distinct clocks for ordering, identical
 *  clocks for the tie-break). Mirrors the columns `KyselyOrderStore.listOrders`
 *  reads, so the fake and the SQL agree byte-for-byte. */
export interface SeedOrderSummaryRow {
	id: string;
	state: OrderState;
	currency: string;
	buyerRef: string;
	customerId?: string | null;
	paymentMethod?: PaymentMethod | null;
	createdAt: string;
	totalCents: number;
	reconciliationFlag?: string | null;
}
import { emailTemplateForState } from "../orders/state-machine.js";

/** Descending code-unit string comparison (`>` first) — the SAME plain code-unit
 *  ordering the keyset predicate + from/to filters use, so the admin-list fake is
 *  internally consistent (never `localeCompare`). */
function codeUnitDesc(a: string, b: string): number {
	return a > b ? -1 : a < b ? 1 : 0;
}

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
			discount: input.totals.discount ?? cents(0),
			shipping: input.totals.shipping ?? cents(0),
			tax: input.totals.tax ?? cents(0),
			total: input.totals.total,
			appliedCouponCode: input.totals.appliedCouponCode ?? null,
			shippingMethodSnapshot: input.totals.shippingMethodSnapshot ?? null,
			taxBreakdown: input.totals.taxBreakdown ?? null,
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
			reconciliationResolution: null,
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

	async resolveReconciliation(
		input: ResolveReconciliationInput,
	): Promise<ResolveReconciliationStoreResult> {
		// EQUALITY-guarded compare-and-clear (mirrors the Kysely `WHERE
		// reconciliation_flag = :expectedFlag` UPDATE, the `transition` fromState
		// precedent): only the exact reviewed flag can be cleared, so exactly one
		// caller wins AND a re-flagged order (different detail) is a 0-row miss —
		// never a blind clear. A racing loser finds the flag cleared/changed →
		// resolved:false, and NEVER overwrites the first disposition.
		const stored = this.#orders.get(input.orderId);
		if (stored === undefined) return { resolved: false, order: null };
		if (stored.order.reconciliationFlag !== input.expectedFlag) {
			return { resolved: false, order: this.#clone(stored.order) };
		}
		const now = this.#clock.now().toISOString();
		stored.order.reconciliationFlag = null;
		stored.order.reconciliationResolution = {
			outcome: input.outcome,
			reason: input.reason,
			resolvedBy: input.resolvedBy,
			resolvedAt: now,
		};
		stored.order.updatedAt = now;
		return { resolved: true, order: this.#clone(stored.order) };
	}

	// -- Phase 5: state machine + outbox --------------------------------------

	async transition(input: OrderTransitionInput): Promise<OrderTransitionResult> {
		// input.idempotencyKey is intentionally unused here too (review round H4)
		// — mirrors the Kysely adapter: dedup is structural (guarded flip +
		// outbox uniqueness), the field exists for CLAUDE.md command-shape
		// consistency, not because the fake keys off it.
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

	/** The ONE `OrderListFilter` predicate, shared by `listOrders` and
	 *  `countOrders` (mirrors the Kysely adapter's single filter builder) — a
	 *  count can never disagree with the list it captions. */
	#matchesFilter(o: Order, filter: OrderListFilter): boolean {
		if (
			filter.states !== undefined &&
			filter.states.length > 0 &&
			!filter.states.includes(o.state)
		) {
			return false;
		}
		if (filter.from !== undefined && o.createdAt < filter.from) return false; // inclusive lower
		if (filter.to !== undefined && o.createdAt >= filter.to) return false; // EXCLUSIVE upper
		if (
			filter.search !== undefined &&
			!(o.id === filter.search || o.buyerRef.toLowerCase() === filter.search.toLowerCase())
		) {
			return false;
		}
		// The customer dimension: a UNION inside the key (customer_id = :id OR
		// lower(buyer_ref) = lower(:buyerRef)), ANDed with everything above. A key
		// with neither half set constrains nothing (matches the SQL adapter).
		if (filter.customer !== undefined) {
			const { customerId, buyerRef } = filter.customer;
			if (customerId !== undefined || buyerRef !== undefined) {
				const byId = customerId !== undefined && o.customerId === customerId;
				const byRef = buyerRef !== undefined && o.buyerRef.toLowerCase() === buyerRef.toLowerCase();
				if (!byId && !byRef) return false;
			}
		}
		return true;
	}

	async countOrders(filter: OrderListFilter): Promise<number> {
		let count = 0;
		for (const s of this.#orders.values()) {
			if (this.#matchesFilter(s.order, filter)) count++;
		}
		return count;
	}

	async listOrders(filter: OrderListFilter, page: OrderListPage): Promise<OrderListResult> {
		// EXACT parity with `KyselyOrderStore.listOrders` (MOD-5): same filters
		// (via the shared `#matchesFilter` predicate), same `created_at DESC, id
		// DESC` order, same half-open `[from, to)` window, same `lower(buyer_ref)
		// = lower(:search)` (exact-lower-equals, NOT substring), same `limit + 1`
		// next-page detection.
		const cursor = page.cursor ?? null;

		const matched = [...this.#orders.values()]
			.map((s) => s.order)
			.filter((o) => {
				if (!this.#matchesFilter(o, filter)) return false;
				// Keyset predicate: everything strictly "less than" the cursor position
				// under `created_at DESC, id DESC`.
				if (cursor !== null) {
					if (o.createdAt > cursor.createdAt) return false;
					if (o.createdAt === cursor.createdAt && o.id >= cursor.id) return false;
				}
				return true;
			})
			// Order ids and created_at are ASCII (opaque tokens / fixed-width ISO-8601),
			// so plain code-unit comparison matches the store's byte ordering. Use the
			// SAME code-unit `<`/`>` here as the keyset predicate + from/to filters above
			// (never `localeCompare`), so the fake is internally consistent. Non-C
			// Postgres collations are out of scope for the fake.
			.toSorted(
				(a, b) =>
					a.createdAt === b.createdAt
						? codeUnitDesc(a.id, b.id) // id DESC
						: codeUnitDesc(a.createdAt, b.createdAt), // created_at DESC
			);

		const window = matched.slice(0, page.limit + 1);
		const hasMore = window.length > page.limit;
		const rows = hasMore ? window.slice(0, page.limit) : window;
		const last = rows.at(-1);
		const nextCursor =
			hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null;
		return { orders: rows.map((o) => this.#toSummary(o)), nextCursor };
	}

	/** TEST-ONLY: directly seed an order row for the admin-list contract with an
	 *  EXACT `createdAt`/`state`/`buyerRef`/`total`. Not part of `OrderStore`. */
	seedSummaryOrder(row: SeedOrderSummaryRow): void {
		const oid = toOrderId(row.id);
		const cur = toCurrency(row.currency);
		const order: Order = {
			id: oid,
			cartId: null,
			currency: cur,
			state: row.state,
			idempotencyKey: toIdempotencyKey(`seed-${row.id}`),
			holdExpiresAt: row.createdAt,
			paymentMethod: row.paymentMethod ?? null,
			buyerRef: row.buyerRef,
			customerId: row.customerId ?? null,
			createdAt: row.createdAt,
			updatedAt: row.createdAt,
			lines: [],
			totals: {
				orderId: oid,
				currency: cur,
				subtotal: cents(row.totalCents),
				discount: cents(0),
				shipping: cents(0),
				tax: cents(0),
				total: cents(row.totalCents),
				appliedCouponCode: null,
				shippingMethodSnapshot: null,
				taxBreakdown: null,
			},
			reconciliationFlag: row.reconciliationFlag ?? null,
			reconciliationResolution: null,
		};
		this.#orders.set(row.id, { order });
	}

	#toSummary(order: Order): OrderSummary {
		return {
			id: order.id,
			state: order.state,
			currency: order.currency,
			buyerRef: order.buyerRef,
			customerId: order.customerId,
			paymentMethod: order.paymentMethod,
			createdAt: order.createdAt,
			total: order.totals.total,
			reconciliationFlag: order.reconciliationFlag !== null,
		};
	}

	async linkGuestOrders(customerId: CustomerId, buyerRef: string): Promise<number> {
		// Case-insensitive on buyer_ref (review round H2): checkout stores the
		// buyer's email VERBATIM, while the login email is lower-normalized —
		// compare-side folding links a mixed-case guest checkout without rewriting
		// the Phase-4 value (which is also the exact-match entitlement claim key).
		const needle = buyerRef.toLowerCase();
		let linked = 0;
		for (const stored of this.#orders.values()) {
			if (stored.order.buyerRef.toLowerCase() === needle && stored.order.customerId === null) {
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
