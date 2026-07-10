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
	type FulfillmentKind,
	type IdGen,
	type Order,
	type OrderId,
	type OrderLine,
	type OrderStore,
	type OrderTotals,
	type PaymentMethod,
	type RecordPaymentInput,
} from "@urumi/domain";
import type { Kysely, Selectable } from "kysely";
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

			for (const line of input.lines) {
				await trx
					.insertInto("order_items")
					.values({
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
					})
					.execute();
			}
			await trx
				.insertInto("order_totals")
				.values({
					order_id: input.orderId,
					currency: input.totals.currency,
					subtotal_cents: input.totals.subtotal,
					discount_cents: 0,
					shipping_cents: 0,
					tax_cents: 0,
					total_cents: input.totals.total,
					applied_coupon_code: null,
					shipping_method_snapshot: null,
					tax_breakdown: null,
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

	async markPaid(orderId: OrderId): Promise<boolean> {
		return this.#guardedFlip(orderId, "pending", "paid");
	}

	async markFailed(orderId: OrderId): Promise<boolean> {
		return this.#guardedFlip(orderId, "pending", "failed");
	}

	async expire(orderId: OrderId, now: string): Promise<boolean> {
		const flipped = await this.#db
			.updateTable("orders")
			.set({ state: "expired", updated_at: this.#clock.now().toISOString() })
			.where("id", "=", orderId)
			.where("state", "=", "pending")
			.where("hold_expires_at", "<=", now)
			.returning("id")
			.executeTakeFirst();
		return flipped !== undefined;
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

	// -- internals ------------------------------------------------------------

	async #guardedFlip(orderId: OrderId, from: string, to: "paid" | "failed"): Promise<boolean> {
		const flipped = await this.#db
			.updateTable("orders")
			.set({ state: to, updated_at: this.#clock.now().toISOString() })
			.where("id", "=", orderId)
			.where("state", "=", from as OrdersTable["state"])
			.returning("id")
			.executeTakeFirst();
		return flipped !== undefined;
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
		shippingMethodSnapshot: totals.shipping_method_snapshot,
		taxBreakdown: totals.tax_breakdown,
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
	};
}
