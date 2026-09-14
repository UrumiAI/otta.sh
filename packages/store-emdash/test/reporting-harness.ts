/**
 * The wiring every reporting suite shares: a real `EmdashReportingStore` over real
 * plugin storage, plus the five seed hooks the domain's reporting contract defines.
 *
 * **Why the seeds write documents instead of driving a checkout.** The contract's
 * seed surface is row-shaped on purpose — it hands the adapter an order in an EXACT
 * state, at an EXACT instant, with an EXACT total, because that is the only way to
 * put all ten order states and two currencies across three fixed days in front of
 * one set of hand-computed expectations. A checkout cannot mint an `expired` order
 * dated last Tuesday. So the seeds write the same documents the order store writes
 * and then hand the reporting store the SAME event its hook would have handed it —
 * exactly the device `order-harness.ts`'s own `seedOrder` uses for the admin-list
 * cases, and for the same reason.
 *
 * That the hook really does emit those events, with that payload, against the real
 * order store, is a separate claim and is pinned separately in
 * `reporting-hook.dialects.test.ts`; the replay and heal suites drive real
 * checkouts end to end.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	productId as brandProductId,
	sku as brandSku,
	type Cents,
	type Currency,
	type OrderState,
	type ProductId,
} from "@otta-sh/domain";
import type { ReportingStoreHarness } from "@otta-sh/domain/testing";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	customerKeyFor,
	EmdashReportingStore,
	foldBuyerRef,
	INVENTORY_COLLECTION,
	lifecycleFor,
	newShellProductDoc,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	publishKeyFor,
	REPORTING_APPLIED_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	searchKeyFor,
	SKU_OWNERS_COLLECTION,
	type InventoryDoc,
	type OrderDoc,
	type ProductCommerceDoc,
	type RefundEntryDoc,
	type ReportingAppliedDoc,
	type ReportingDailyDoc,
	type ReportingOrderEvent,
	type SkuOwnerDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";

/** The epoch every reporting suite starts from. */
export const REPORTING_EPOCH = new Date("2026-07-10T00:00:00.000Z");

export interface ReportingHarnessOptions {
	/** Wrap the storage the REPORTING store writes through (fault injection). */
	storageForStore?: StorageAccess;
	/** Reuse another harness's clock, so a fault-injected twin shares its time. */
	clock?: FixedClock;
	/** Override the compare-and-set ceiling (the race suite measures the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Page ceiling for a report read. */
	maxReportPages?: number;
	/** Page ceiling for a recompute scan. */
	maxReconcilePages?: number;
}

/** Everything a reporting suite may reach for, all over one storage instance. */
export interface ReportingHarness extends ReportingStoreHarness {
	readonly clock: FixedClock;
	readonly store: EmdashReportingStore;
	/** The documents, for the assertions the port cannot express. */
	readonly daily: StorageCollection<ReportingDailyDoc>;
	readonly applied: StorageCollection<ReportingAppliedDoc>;
	readonly orders: StorageCollection<OrderDoc>;
	readonly inventoryDocs: StorageCollection<InventoryDoc>;
	readonly products: StorageCollection<ProductCommerceDoc>;
	readonly skuOwners: StorageCollection<SkuOwnerDoc>;
	/**
	 * Move a seeded order to a new state exactly as the order store's own flip
	 * does — the guarded state write and the appended audit event in ONE write,
	 * then the rollup event the hook emits after it is durable. The audit event is
	 * not decoration here: a recompute derives which transitions have already been
	 * applied from the order's own event log.
	 */
	transitionOrder(orderId: string, toState: string): Promise<ReportingOrderEvent>;
	/**
	 * The durable half of a transition ALONE: the guarded state write plus the audit
	 * event, and the rollup event it owes RETURNED rather than recorded. It is what a
	 * crash seam needs — the order has really moved and the rollup has not — and it is
	 * exactly the order the hook runs in.
	 */
	moveOrderDocument(orderId: string, toState: string): Promise<ReportingOrderEvent>;
	/** Record a FINALIZED refund on a seeded order, then its rollup event. */
	refundOrder(orderId: string, amountCents: number): Promise<ReportingOrderEvent>;
	/** The durable half of a refund alone; the rollup event is returned, not recorded. */
	addRefundDocument(orderId: string, amountCents: number): Promise<ReportingOrderEvent>;
	/** Every rollup document, by id, for a byte-comparison against a replay. */
	dailyDocs(): Promise<Record<string, ReportingDailyDoc>>;
	advance(ms: number): void;
	now(): string;
}

/** Build a harness over an already-bound `StorageAccess`. */
export function makeReportingHarness(
	storage: StorageAccess,
	options: ReportingHarnessOptions = {},
): ReportingHarness {
	const clock = options.clock ?? new FixedClock(new Date(REPORTING_EPOCH.getTime()));
	const written = options.storageForStore ?? storage;
	const store = new EmdashReportingStore({
		storage: written,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
		maxReportPages: options.maxReportPages,
		maxReconcilePages: options.maxReconcilePages,
	});

	const daily = collectionOf<ReportingDailyDoc>(storage, REPORTING_DAILY_COLLECTION);
	const applied = collectionOf<ReportingAppliedDoc>(storage, REPORTING_APPLIED_COLLECTION);
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const inventoryDocs = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const skuOwners = collectionOf<SkuOwnerDoc>(storage, SKU_OWNERS_COLLECTION);

	/** The order document, or a loud failure — a seed that names no order is a bug. */
	const requireOrder = async (orderId: string): Promise<OrderDoc> => {
		const doc = await orders.get(orderId);
		if (doc === null) throw new Error(`reporting seed names no order '${orderId}'`);
		return doc;
	};

	let seededProducts = 0;

	const moveOrderDocument = async (
		orderId: string,
		toState: string,
	): Promise<ReportingOrderEvent> => {
		const held = await orders.getVersioned(orderId);
		if (held === null) throw new Error(`reporting seed names no order '${orderId}'`);
		const doc = held.value;
		const from = doc.state;
		const at = clock.now().toISOString();
		await orders.compareAndSet(orderId, held.revision, {
			...doc,
			state: toState as OrderState,
			events: [
				...doc.events,
				{
					id: `ev-${orderId}-${String(doc.events.length + 1)}`,
					at,
					kind: "transition",
					fromState: from,
					toState: toState as OrderState,
					actor: null,
				},
			],
			updatedAt: at,
		});
		return {
			kind: "transition",
			orderId,
			orderCreatedAt: doc.createdAt,
			currency: doc.currency,
			fromState: from,
			toState,
			orderTotalCents: doc.totals.total,
		};
	};

	const addRefundDocument = async (
		orderId: string,
		amountCents: number,
	): Promise<ReportingOrderEvent> => {
		const held = await orders.getVersioned(orderId);
		if (held === null) throw new Error(`reporting seed names no order '${orderId}'`);
		const doc = held.value;
		const refundId = `rf-${orderId}-${String(doc.refunds.length + 1)}`;
		await orders.compareAndSet(orderId, held.revision, {
			...doc,
			refunds: [
				...doc.refunds,
				{
					id: refundId,
					amount: cents(amountCents),
					currency: doc.currency,
					kind: "partial",
					gateway: "stripe",
					refundRef: null,
					reason: null,
					refundedBy: "seed",
					status: "recorded",
					idempotencyKey: idempotencyKey(`seed-${refundId}`),
					createdAt: clock.now().toISOString(),
				},
			],
		});
		return {
			kind: "refund",
			orderId,
			orderCreatedAt: doc.createdAt,
			currency: doc.currency,
			refundId,
			refundedCents: amountCents,
		};
	};


	return {
		clock,
		store,
		daily,
		applied,
		orders,
		inventoryDocs,
		products,
		skuOwners,

		async seedOrder(row) {
			const created = row.createdAt;
			const currency = toCurrency(row.currency);
			const total = cents(row.totalCents);
			// The document analogue of the SQL harness's `orders` + `order_totals`
			// insert (see this file's docblock), with the header fields a reporting
			// read never looks at left at their empty values.
			await orders.compareAndSet(row.id, null, {
				orderId: row.id,
				cartId: null,
				currency,
				state: row.state as OrderState,
				idempotencyKey: idempotencyKey(`seed-${row.id}`),
				holdExpiresAt: created,
				paymentMethod: null,
				buyerRef: `${row.id}@example.test`,
				customerId: null,
				customerKey: customerKeyFor(null, `${row.id}@example.test`),
				buyerRefLower: foldBuyerRef(`${row.id}@example.test`),
				searchKey: searchKeyFor(row.id),
				emailDueAt: null,
				items: [],
				totals: {
					currency,
					subtotal: total,
					discount: cents(0),
					shipping: cents(0),
					tax: cents(0),
					total,
					appliedCouponCode: null,
					shippingMethodSnapshot: null,
					taxBreakdown: null,
				},
				shippingAddress: null,
				events: [],
				emailOutbox: [],
				payments: [],
				refunds: [],
				holdsPendingAt: null,
				holdsAdopted: null,
				holdsCommitted: null,
				holdsReleased: null,
				reconciliationFlag: null,
				reconciliationResolution: null,
				fulfillment: null,
				cancellation: null,
				createdAt: created,
				updatedAt: created,
			});
			// The event the hook would have emitted for an order that arrived in this
			// state: no previous bucket to leave, one to enter.
			await store.recordOrderEvent({
				kind: "transition",
				orderId: row.id,
				orderCreatedAt: created,
				currency: row.currency,
				fromState: null,
				toState: row.state,
				orderTotalCents: row.totalCents,
			});
		},

		async seedOrderItem(row) {
			const doc = await requireOrder(row.orderId);
			const held = await orders.getVersioned(row.orderId);
			await orders.compareAndSet(row.orderId, held?.revision ?? null, {
				...doc,
				items: [
					...doc.items,
					{
						id: `item-${row.orderId}-${String(doc.items.length + 1)}`,
						productId: brandProductId(row.productId),
						sku: brandSku(`${row.productId}-sku`),
						title: row.title,
						unitPrice: cents(row.unitPriceCents),
						currency: doc.currency,
						quantity: row.quantity,
						fulfillmentKind: "physical",
						reservationId: null,
					},
				],
			});
		},

		async seedInventory(row) {
			await inventoryDocs.put(row.sku, { sku: row.sku, onHand: row.onHand, holds: {} });
		},

		async seedRefund(row) {
			const doc = await requireOrder(row.orderId);
			const held = await orders.getVersioned(row.orderId);
			const status = row.status ?? "recorded";
			const refundId = `rf-${row.orderId}-${String(doc.refunds.length + 1)}`;
			const entry: RefundEntryDoc = {
				id: refundId,
				amount: cents(row.amountCents),
				currency: toCurrency(row.currency),
				kind: "partial",
				gateway: "stripe",
				refundRef: null,
				reason: null,
				refundedBy: "seed",
				status: status as RefundEntryDoc["status"],
				idempotencyKey: idempotencyKey(`seed-${refundId}`),
				createdAt: doc.createdAt,
			};
			await orders.compareAndSet(row.orderId, held?.revision ?? null, {
				...doc,
				refunds: [...doc.refunds, entry],
			});
			// Only a FINALIZED refund is money that came back, so only a finalized one
			// is an event — exactly the gate the hook applies.
			if (status === "recorded") {
				await store.recordOrderEvent({
					kind: "refund",
					orderId: row.orderId,
					orderCreatedAt: doc.createdAt,
					currency: row.currency,
					refundId,
					refundedCents: row.amountCents,
				});
			}
		},

		async seedProduct(row) {
			seededProducts++;
			const productId = brandProductId(`prod-${String(seededProducts)}`);
			const at = doc0(clock);
			const shell = newShellProductDoc(productId, at);
			await products.put(productId, {
				...shell,
				lifecycle: lifecycleFor(row.deletedAt ?? null),
				sku: brandSku(row.sku),
				title: row.title,
				active: true,
				publishKey: publishKeyFor(true),
				deletedAt: row.deletedAt ?? null,
			});
			// The live-sku claim, written for a LIVE row only: a tombstone releases the
			// sku, which is exactly what makes a live row and any number of tombstones
			// able to share one (the partial-index rule the SQL join's `deleted_at IS
			// NULL` half exists for).
			if ((row.deletedAt ?? null) === null) {
				const claim: SkuOwnerDoc = {
					sku: row.sku,
					ownerKind: "product",
					ownerId: productId,
					variantKey: null,
					live: true,
					claimedAt: at,
				};
				await skuOwners.put(row.sku, claim);
			}
		},

		moveOrderDocument,

		async transitionOrder(orderId, toState) {
			const event = await moveOrderDocument(orderId, toState);
			await store.recordOrderEvent(event);
			return event;
		},

		addRefundDocument,

		async refundOrder(orderId, amountCents) {
			const event = await addRefundDocument(orderId, amountCents);
			await store.recordOrderEvent(event);
			return event;
		},

		async dailyDocs() {
			const out: Record<string, ReportingDailyDoc> = {};
			let cursor: string | undefined;
			for (;;) {
				const page = await daily.query({ limit: 100, cursor });
				for (const row of page.items) out[row.id] = row.data;
				if (!page.hasMore || page.cursor === undefined) return out;
				cursor = page.cursor;
			}
		},

		advance(ms) {
			clock.advance(ms);
		},

		now() {
			return clock.now().toISOString();
		},
	};
}

/** The clock's instant as an ISO string — spelled once. */
function doc0(clock: FixedClock): string {
	return clock.now().toISOString();
}

/** The money shapes a suite asserts against, branded once. */
export function usd(amount: number): { currency: Currency; amount: Cents } {
	return { currency: toCurrency("USD"), amount: cents(amount) };
}

/** A product id, branded for a seed. */
export function pid(raw: string): ProductId {
	return brandProductId(raw);
}
