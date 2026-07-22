import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	type Clock,
	type CreateOrderInput,
	type CreateOrderResult,
	type CustomerId,
	type FulfillmentKind,
	type IdempotencyKey,
	type IdGen,
	type Order,
	type OrderId,
	type OrderLine,
	type OrderListFilter,
	type OrderListPage,
	type OrderListResult,
	type OrderState,
	type OrderStore,
	type OrderSummary,
	type OrderTotals,
	type OrderTransitionInput,
	type OrderTransitionResult,
	type OutboxEmail,
	type PaymentMethod,
	type ReconciliationOutcome,
	type RecordPaymentInput,
	type ResolveReconciliationInput,
	type ResolveReconciliationStoreResult,
} from "@urumi/domain";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type { Database, OrderItemsTable, OrdersTable, OrderTotalsTable } from "./schema.js";

export interface KyselyOrderStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `OrderStore` over Kysely (§4), dialect-agnostic across better-sqlite3 and pg.
 * `createFromCart` co-locates the `orders` + `order_items` + `order_totals` writes
 * in one short transaction guarded by `orders.idempotency_key` UNIQUE: the order
 * row is durably persisted before the caller adopts any reservation (§5). A replay
 * (key conflict) returns the existing order, re-snapshotting nothing. Every state
 * change is a guarded flip (0 rows ⇒ someone else won). `order_items` are
 * insert-once — no code path ever updates a snapshot (immutability is structural).
 */
export class KyselyOrderStore implements OrderStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyOrderStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async createFromCart(input: CreateOrderInput): Promise<CreateOrderResult> {
		const now = this.#clock.now().toISOString();
		const created = await this.#db.transaction().execute(async (trx) => {
			const inserted = await trx
				.insertInto("orders")
				.values({
					id: input.orderId,
					cart_id: input.cartId,
					currency: input.currency,
					state: "pending",
					idempotency_key: input.idempotencyKey,
					hold_expires_at: input.holdExpiresAt,
					payment_method: input.paymentMethod,
					buyer_ref: input.buyerRef,
					created_at: now,
					updated_at: now,
				})
				.onConflict((oc) => oc.column("idempotency_key").doNothing())
				.returning("id")
				.executeTakeFirst();
			if (inserted === undefined) return false; // key exists ⇒ replay

			// One multi-row INSERT for the whole cart instead of a per-line loop:
			// `newId()` is still called PER LINE (ids stay one-per-line) and every
			// column mapping is byte-for-byte the old loop body. The length guard is
			// defensive — a real order always has ≥1 line, but an empty array would
			// otherwise emit invalid `INSERT ... VALUES ()` SQL.
			if (input.lines.length > 0) {
				await trx
					.insertInto("order_items")
					.values(
						input.lines.map((line) => ({
							id: this.#idGen.newId(),
							order_id: input.orderId,
							product_id: line.productId,
							sku: line.sku,
							title: line.title,
							unit_price_cents: line.unitPrice,
							currency: line.currency,
							quantity: line.quantity,
							fulfillment_kind: line.fulfillmentKind,
							reservation_id: line.reservationId,
						})),
					)
					.execute();
			}
			await trx
				.insertInto("order_totals")
				.values({
					order_id: input.orderId,
					currency: input.totals.currency,
					subtotal_cents: input.totals.subtotal,
					// Phase 6: the full computed breakdown. Phase-4/5 callers pass none
					// of these ⇒ 0 / null, reproducing the stub byte-for-byte.
					discount_cents: input.totals.discount ?? 0,
					shipping_cents: input.totals.shipping ?? 0,
					tax_cents: input.totals.tax ?? 0,
					total_cents: input.totals.total,
					applied_coupon_code: input.totals.appliedCouponCode ?? null,
					// jsonb-as-text: stored as a JSON string (null stays null).
					shipping_method_snapshot: jsonOrNull(input.totals.shippingMethodSnapshot),
					tax_breakdown: jsonOrNull(input.totals.taxBreakdown),
				})
				.execute();
			return true;
		});

		const order = created
			? await this.#loadById(input.orderId)
			: await this.#loadByKey(input.idempotencyKey);
		if (order === null) throw new Error("order vanished immediately after createFromCart");
		return { created, order };
	}

	async getById(orderId: OrderId): Promise<Order | null> {
		return this.#loadById(orderId);
	}

	async getByIdempotencyKey(key: IdempotencyKey): Promise<Order | null> {
		return this.#loadByKey(key);
	}

	async markPaid(orderId: OrderId): Promise<boolean> {
		// pending → paid also enqueues the order-confirmation email (§5), in the
		// same transaction as the flip.
		return this.#guardedTransition({
			orderId,
			fromState: "pending",
			toState: "paid",
			enqueueEmail: true,
		});
	}

	async markFailed(orderId: OrderId): Promise<boolean> {
		// pending → failed has no template (§9 Risk 8), so no outbox row.
		return this.#guardedTransition({
			orderId,
			fromState: "pending",
			toState: "failed",
			enqueueEmail: false,
		});
	}

	async expire(orderId: OrderId, now: string): Promise<boolean> {
		// Phase 4's deadline-guarded flip, now wrapped with the outbox INSERT in one
		// transaction (§5 "Wiring, not duplication"). The guard predicate is
		// unchanged; the reservation-release logic stays in `expireOrders`.
		return this.#guardedTransition({
			orderId,
			fromState: "pending",
			toState: "expired",
			enqueueEmail: true,
			holdExpiresBefore: now,
		});
	}

	async listExpirable(now: string): Promise<OrderId[]> {
		const rows = await this.#db
			.selectFrom("orders")
			.select("id")
			.where("state", "=", "pending")
			.where("hold_expires_at", "<=", now)
			.execute();
		return rows.map((r) => toOrderId(r.id));
	}

	async recordPayment(input: RecordPaymentInput): Promise<void> {
		await this.#db
			.insertInto("payments")
			.values({
				id: this.#idGen.newId(),
				order_id: input.orderId,
				gateway: input.gateway,
				provider_ref: input.providerRef,
				amount_cents: input.amount,
				currency: input.currency,
				status: input.status,
				created_at: this.#clock.now().toISOString(),
			})
			.onConflict((oc) => oc.column("provider_ref").doNothing())
			.execute();
	}

	async flagReconciliation(orderId: OrderId, detail: string): Promise<void> {
		await this.#db
			.updateTable("orders")
			.set({ reconciliation_flag: detail, updated_at: this.#clock.now().toISOString() })
			.where("id", "=", orderId)
			.execute();
	}

	async resolveReconciliation(
		input: ResolveReconciliationInput,
	): Promise<ResolveReconciliationStoreResult> {
		// EQUALITY-guarded compare-and-clear on the reconciliation axis — the
		// `transition` fromState precedent: `WHERE reconciliation_flag =
		// :expectedFlag` makes the resolve once-only under concurrency (exactly one
		// caller clears the flag + records the disposition) AND stale-review-safe (a
		// NEW anomaly re-flagging the order after the admin loaded the page no longer
		// matches — a 0-row miss, never a blind clear). RETURNING id tells us who
		// won. NEVER touches state / order_items / order_totals — only the mutable
		// reconciliation envelope. input.idempotencyKey is intentionally unused:
		// dedup is structural via the guard (mirrors `transition`, H4).
		const now = this.#clock.now().toISOString();
		const won = await this.#db
			.updateTable("orders")
			.set({
				reconciliation_flag: null,
				reconciliation_outcome: input.outcome,
				reconciliation_reason: input.reason,
				reconciliation_resolved_by: input.resolvedBy,
				reconciliation_resolved_at: now,
				updated_at: now,
			})
			.where("id", "=", input.orderId)
			.where("reconciliation_flag", "=", input.expectedFlag)
			.returning("id")
			.executeTakeFirst();
		const order = await this.#loadById(input.orderId);
		return { resolved: won !== undefined, order };
	}

	// -- Phase 5: state machine + email outbox --------------------------------

	async transition(input: OrderTransitionInput): Promise<OrderTransitionResult> {
		// input.idempotencyKey is intentionally unused: dedup here is structural —
		// the guarded `WHERE state=:fromState` flip plus the outbox
		// `UNIQUE(order_id, to_state)` already make a replay a no-op (review round
		// H4). The field is kept on the port for CLAUDE.md command-shape
		// consistency ("every command carries one"), not because this adapter
		// keys off it.
		const transitioned = await this.#guardedTransition({
			orderId: input.orderId,
			fromState: input.fromState,
			toState: input.toState,
			enqueueEmail: input.enqueueEmail,
		});
		const order = await this.#loadById(input.orderId);
		return { transitioned, order };
	}

	async listForCustomer(customerId: CustomerId): Promise<Order[]> {
		const rows = await this.#db
			.selectFrom("orders")
			.select("id")
			.where("customer_id", "=", customerId)
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		const orders: Order[] = [];
		for (const row of rows) {
			const order = await this.#loadById(row.id);
			if (order !== null) orders.push(order);
		}
		return orders;
	}

	async listOrders(filter: OrderListFilter, page: OrderListPage): Promise<OrderListResult> {
		// A SINGLE SELECT joining orders → order_totals 1:1 (no N+1 into
		// order_items/order_totals per row — the list is a projection, not a full
		// Order load). Keyset pagination on `(created_at DESC, id DESC)`: fetch
		// `limit + 1` to detect a next page, emit `nextCursor` from the last RETURNED
		// row. `created_at` is fixed-width ISO-8601 text ⇒ lexical order IS
		// chronological, so the raw text comparisons below are dialect-identical
		// (no casts) across better-sqlite3 and pg.
		let q = this.#db
			.selectFrom("orders")
			.innerJoin("order_totals", "order_totals.order_id", "orders.id")
			.select([
				"orders.id as id",
				"orders.state as state",
				"orders.currency as currency",
				"orders.buyer_ref as buyer_ref",
				"orders.customer_id as customer_id",
				"orders.payment_method as payment_method",
				"orders.created_at as created_at",
				"orders.reconciliation_flag as reconciliation_flag",
				"order_totals.total_cents as total_cents",
			]);

		if (filter.states !== undefined && filter.states.length > 0) {
			q = q.where("orders.state", "in", filter.states as OrderState[]);
		}
		if (filter.from !== undefined) q = q.where("orders.created_at", ">=", filter.from); // inclusive
		if (filter.to !== undefined) q = q.where("orders.created_at", "<", filter.to); // EXCLUSIVE (half-open, MOD-7)
		if (filter.search !== undefined) {
			const search = filter.search;
			// Exact order id OR case-insensitive EXACT buyer_ref — `lower(buyer_ref) =
			// lower(:search)`, matching the fake (never a substring/LIKE).
			q = q.where((eb) =>
				eb.or([
					eb("orders.id", "=", search),
					eb(sql`lower(orders.buyer_ref)`, "=", search.toLowerCase()),
				]),
			);
		}
		if (page.cursor !== undefined && page.cursor !== null) {
			const cursor = page.cursor;
			// (created_at < :c) OR (created_at = :c AND id < :cid) — everything
			// strictly "after" the cursor position under `created_at DESC, id DESC`.
			q = q.where((eb) =>
				eb.or([
					eb("orders.created_at", "<", cursor.createdAt),
					eb.and([eb("orders.created_at", "=", cursor.createdAt), eb("orders.id", "<", cursor.id)]),
				]),
			);
		}

		const rows = await q
			.orderBy("orders.created_at", "desc")
			.orderBy("orders.id", "desc")
			.limit(page.limit + 1)
			.execute();

		const hasMore = rows.length > page.limit;
		const returned = hasMore ? rows.slice(0, page.limit) : rows;
		const last = returned.at(-1);
		const nextCursor =
			hasMore && last !== undefined ? { createdAt: last.created_at, id: toOrderId(last.id) } : null;

		const orders: OrderSummary[] = returned.map((r) => ({
			id: toOrderId(r.id),
			state: r.state as OrderState,
			currency: toCurrency(r.currency),
			buyerRef: r.buyer_ref,
			customerId: r.customer_id,
			paymentMethod: r.payment_method === null ? null : (r.payment_method as PaymentMethod),
			createdAt: r.created_at,
			total: cents(r.total_cents),
			reconciliationFlag: r.reconciliation_flag !== null,
		}));
		return { orders, nextCursor };
	}

	async linkGuestOrders(customerId: CustomerId, buyerRef: string): Promise<number> {
		// Case-insensitive on buyer_ref (review round H2): checkout stores the
		// buyer's email VERBATIM, while the login email is lower-normalized —
		// compare-side folding (lower(buyer_ref) = lower(?)) links a mixed-case
		// guest checkout without rewriting the Phase-4 value. Dialect-agnostic:
		// `lower()` is standard SQL, works identically on sqlite and pg.
		const res = await this.#db
			.updateTable("orders")
			.set({ customer_id: customerId, updated_at: this.#clock.now().toISOString() })
			.where(sql`lower(buyer_ref)`, "=", buyerRef.toLowerCase())
			.where("customer_id", "is", null)
			.executeTakeFirst();
		return Number(res.numUpdatedRows);
	}

	async claimNextEmail(now: string, leaseUntil: string): Promise<OutboxEmail | null> {
		// Lease-driven claimability (§5): not sent, not failed, and no live lease
		// (null, or elapsed) — covers fresh-pending, crashed-'sending', and
		// rescheduled-with-backoff uniformly.
		const claimable = (eb: import("kysely").ExpressionBuilder<Database, "order_emails_outbox">) =>
			eb.and([
				eb("sent_at", "is", null),
				eb("status", "!=", "failed"),
				eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]),
			]);

		const candidate = await this.#db
			.selectFrom("order_emails_outbox")
			.select("id")
			.where(claimable)
			.orderBy("created_at")
			.orderBy("id")
			.limit(1)
			.executeTakeFirst();
		if (candidate === undefined) return null;

		// Guarded claim — only one runner wins even under concurrent dispatch.
		const claimed = await this.#db
			.updateTable("order_emails_outbox")
			.set({ status: "sending", lease_until: leaseUntil, attempts: sql`attempts + 1` })
			.where("id", "=", candidate.id)
			.where(claimable)
			.returning(["id", "order_id", "to_state", "attempts"])
			.executeTakeFirst();
		if (claimed === undefined) return null; // lost the claim race — next tick retries

		return {
			id: claimed.id,
			orderId: toOrderId(claimed.order_id),
			toState: claimed.to_state as OrderState,
			attempts: claimed.attempts,
		};
	}

	async markEmailSent(id: string, now: string): Promise<void> {
		await this.#db
			.updateTable("order_emails_outbox")
			.set({ status: "sent", sent_at: now, lease_until: null })
			.where("id", "=", id)
			.execute();
	}

	async rescheduleEmail(id: string, retryAt: string | null): Promise<void> {
		await this.#db
			.updateTable("order_emails_outbox")
			.set(
				retryAt === null
					? { status: "failed", lease_until: null }
					: { status: "pending", lease_until: retryAt }, // backoff until retryAt
			)
			.where("id", "=", id)
			.execute();
	}

	/**
	 * TEST-ONLY (§5 / 5.5 atomicity case; review round H5) — run the REAL
	 * transition transaction — guarded `UPDATE` + outbox `INSERT` — then throw
	 * before `COMMIT`, forcing a rollback. Proves the two writes are atomic:
	 * after this rejects, neither is visible.
	 *
	 * Safe co-location, not a production path: this method is NOT part of the
	 * `OrderStore` port, so no port consumer (use-case, route, dispatcher) can
	 * reach it through the interface they're typed against — only test code
	 * holding a concrete `KyselyOrderStore` (see `order-harness.ts`'s
	 * `forceFailedTransition`) can call it. It also isn't a candidate to hoist
	 * into a standalone test helper: it reuses the private `#flipAndEnqueue` to
	 * exercise the exact production write path rather than a re-implementation
	 * that could drift from it.
	 */
	async transitionForTestRollback(input: {
		orderId: OrderId;
		fromState: OrderState;
		toState: OrderState;
	}): Promise<void> {
		const now = this.#clock.now().toISOString();
		await this.#db.transaction().execute(async (trx) => {
			await this.#flipAndEnqueue(trx, {
				orderId: input.orderId,
				fromState: input.fromState,
				toState: input.toState,
				enqueueEmail: true,
				now,
			});
			throw new Error("injected mid-transition failure");
		});
	}

	// -- internals ------------------------------------------------------------

	/** The guarded flip + conditional outbox insert, in one transaction on one
	 *  connection (§5). Returns whether this call won the flip. */
	async #guardedTransition(input: {
		orderId: OrderId;
		fromState: OrderState;
		toState: OrderState;
		enqueueEmail: boolean;
		holdExpiresBefore?: string;
	}): Promise<boolean> {
		const now = this.#clock.now().toISOString();
		return this.#db.transaction().execute((trx) =>
			this.#flipAndEnqueue(trx, {
				orderId: input.orderId,
				fromState: input.fromState,
				toState: input.toState,
				enqueueEmail: input.enqueueEmail,
				now,
				...(input.holdExpiresBefore !== undefined
					? { holdExpiresBefore: input.holdExpiresBefore }
					: {}),
			}),
		);
	}

	async #flipAndEnqueue(
		trx: Transaction<Database>,
		input: {
			orderId: OrderId;
			fromState: OrderState;
			toState: OrderState;
			enqueueEmail: boolean;
			now: string;
			holdExpiresBefore?: string;
		},
	): Promise<boolean> {
		let flip = trx
			.updateTable("orders")
			.set({ state: input.toState, updated_at: input.now })
			.where("id", "=", input.orderId)
			.where("state", "=", input.fromState);
		if (input.holdExpiresBefore !== undefined) {
			flip = flip.where("hold_expires_at", "<=", input.holdExpiresBefore);
		}
		const flipped = await flip.returning("id").executeTakeFirst();
		if (flipped === undefined) return false; // already transitioned / not due

		if (input.enqueueEmail) {
			await trx
				.insertInto("order_emails_outbox")
				.values({
					id: this.#idGen.newId(),
					order_id: input.orderId,
					to_state: input.toState,
					status: "pending",
					attempts: 0,
					lease_until: null,
					sent_at: null,
					created_at: input.now,
				})
				.onConflict((oc) => oc.columns(["order_id", "to_state"]).doNothing())
				.execute();
		}
		return true;
	}

	async #loadByKey(key: string): Promise<Order | null> {
		const row = await this.#db
			.selectFrom("orders")
			.select("id")
			.where("idempotency_key", "=", key)
			.executeTakeFirst();
		return row === undefined ? null : this.#loadById(toOrderId(row.id));
	}

	async #loadById(orderId: string): Promise<Order | null> {
		const order = await this.#db
			.selectFrom("orders")
			.selectAll()
			.where("id", "=", orderId)
			.executeTakeFirst();
		if (order === undefined) return null;
		const items = await this.#db
			.selectFrom("order_items")
			.selectAll()
			.where("order_id", "=", orderId)
			.orderBy("id")
			.execute();
		const totals = await this.#db
			.selectFrom("order_totals")
			.selectAll()
			.where("order_id", "=", orderId)
			.executeTakeFirstOrThrow();
		return toOrder(order, items, totals);
	}
}

/** Serialize a jsonb-as-text column value (null passes through). */
function jsonOrNull(value: unknown | null | undefined): string | null {
	return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Parse a jsonb-as-text column back to data (null/invalid passes through as null). */
function parseJsonOrNull(value: string | null): unknown | null {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value; // tolerate a legacy/plain-string value
	}
}

function toOrder(
	order: Selectable<OrdersTable>,
	items: Selectable<OrderItemsTable>[],
	totals: Selectable<OrderTotalsTable>,
): Order {
	const oid = toOrderId(order.id);
	const lines: OrderLine[] = items.map((i) => ({
		id: i.id,
		orderId: oid,
		productId: toProductId(i.product_id),
		sku: toSku(i.sku),
		title: i.title,
		unitPrice: cents(i.unit_price_cents),
		currency: toCurrency(i.currency),
		quantity: i.quantity,
		fulfillmentKind: i.fulfillment_kind as FulfillmentKind,
		reservationId: i.reservation_id === null ? null : toReservationId(i.reservation_id),
	}));
	const t: OrderTotals = {
		orderId: oid,
		currency: toCurrency(totals.currency),
		subtotal: cents(totals.subtotal_cents),
		discount: cents(totals.discount_cents),
		shipping: cents(totals.shipping_cents),
		tax: cents(totals.tax_cents),
		total: cents(totals.total_cents),
		appliedCouponCode: totals.applied_coupon_code,
		shippingMethodSnapshot: parseJsonOrNull(totals.shipping_method_snapshot),
		taxBreakdown: parseJsonOrNull(totals.tax_breakdown),
	};
	return {
		id: oid,
		cartId: order.cart_id,
		currency: toCurrency(order.currency),
		state: order.state,
		idempotencyKey: toIdempotencyKey(order.idempotency_key),
		holdExpiresAt: order.hold_expires_at,
		paymentMethod: order.payment_method === null ? null : (order.payment_method as PaymentMethod),
		buyerRef: order.buyer_ref,
		customerId: order.customer_id,
		createdAt: order.created_at,
		updatedAt: order.updated_at,
		lines,
		totals: t,
		reconciliationFlag: order.reconciliation_flag,
		// A resolution exists iff the flag was resolved (all four columns written
		// atomically by resolveReconciliation); `resolved_at` is the presence witness.
		reconciliationResolution:
			order.reconciliation_resolved_at === null
				? null
				: {
						outcome: order.reconciliation_outcome as ReconciliationOutcome,
						reason: order.reconciliation_reason ?? "",
						resolvedBy: order.reconciliation_resolved_by ?? "",
						resolvedAt: order.reconciliation_resolved_at,
					},
	};
}
