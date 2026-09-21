/**
 * The wiring every order suite shares: a real `EmdashOrderStore` over real plugin
 * storage, composed with the real `EmdashCartStore` and `EmdashInventoryStore`, so
 * a checkout in these suites walks the same three documents a deployed one walks.
 *
 * **What is real, and what is a fake, and why the line is where it is.** The
 * subject under test is the ORDER store; the cart and inventory stores are real
 * because the order store genuinely composes over them (hold adoption, commit and
 * release are cross-aggregate edges, and a fake inventory could not lose a
 * `compareAndSet` race). The stores the checkout USE-CASES need but this package
 * does not implement yet — product commerce, coupons, shipping and tax rules,
 * entitlements, payment events — come from `@otta-sh/domain/testing`'s in-memory
 * fakes. That is not a mocked subject: none of them is an order-store invariant,
 * and each has its own adapter increment with its own contract suite. Where a real
 * document store is load-bearing (every order, cart and inventory write in these
 * suites) it is real.
 *
 * The notes store is the same call: `OrderNotesStore` is its own port, and the
 * timeline contract merges its rows. `InMemoryOrderNotesStore` supplies them until
 * an EmDash notes adapter exists.
 *
 * Three harness shapes are exported, one per contract suite the port has
 * (`OrderStoreHarness`, `OrderTransitionHarness`, `OrderTimelineHarness`), plus
 * the full-flow harness the end-to-end and race suites drive. They share one
 * `FixedClock` per harness instance, so every deadline and event timestamp in a
 * case is deterministic.
 */
import {
	addLine,
	type CartDeps,
	cents,
	createCart,
	type CreateOrderDeps,
	currency,
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
	FakeEmailSender,
	FakePaymentGateway,
	FixedClock,
	InMemoryCouponStore,
	InMemoryEntitlementStore,
	InMemoryOrderNotesStore,
	InMemoryPaymentEventStore,
	InMemoryProductCommerceStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
	type OrderStoreHarness,
	type OrderTimelineHarness,
	type OrderTransitionHarness,
	type SeedOrderSummaryRow,
} from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashCartStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	INVENTORY_COLLECTION,
	type CartDoc,
	type InventoryDoc,
	type OrderDoc,
	type OrderKeyDoc,
	type ReportingRollupWriter,
	type ReservationIndexDoc,
	type StorageAccess,
	type StorageCollection,
	CARTS_COLLECTION,
	customerKeyFor,
	foldBuyerRef,
	normalizeInventoryDoc,
	ORDER_KEYS_COLLECTION,
	ORDERS_COLLECTION,
	RESERVATION_INDEX_COLLECTION,
	searchKeyFor,
	uuidIdGen,
} from "../src/index.js";

/** The epoch every order suite starts from, so deadlines read identically. */
export const ORDER_EPOCH = new Date("2026-07-10T00:00:00.000Z");

const USD = currency("USD");

export interface OrderHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Wrap the storage the ORDER store writes through (fault injection). */
	storageForOrders?: StorageAccess;
	/** Wrap the storage the CART store writes through (fault injection). */
	storageForCart?: StorageAccess;
	/** Wrap the storage the INVENTORY store writes through (fault injection). */
	storageForInventory?: StorageAccess;
	/**
	 * Deterministic, lexically-increasing ids (`CountingIdGen`), so an event's
	 * `(at, id)` tie-break IS append order under a fixed clock — what the timeline
	 * contract's same-instant cases need.
	 */
	countingIds?: boolean;
	/**
	 * The rollup writer the order store hands every transition and every finalized
	 * refund. Omitted, the store's own no-op stands — which is what every suite but
	 * the reporting-hook one wants.
	 */
	reporting?: ReportingRollupWriter;
	/**
	 * Reuse another harness's clock and non-storage collaborators, so a
	 * fault-injected TWIN sees the same seeded catalogue, the same gateways and the
	 * same clock as the harness that seeded them, and differs only in which storage
	 * collection is wrapped. Without it a twin would carry its own empty product
	 * catalogue and every checkout through it would fail `PRODUCT_NOT_PRICED`.
	 */
	share?: OrderHarnessShared;
}

/** The collaborators a fault-injected twin shares with its origin harness. */
export interface OrderHarnessShared {
	clock: FixedClock;
	productCommerce: InMemoryProductCommerceStore;
	couponStore: InMemoryCouponStore;
	entitlementStore: InMemoryEntitlementStore;
	paymentEventStore: InMemoryPaymentEventStore;
	notesStore: InMemoryOrderNotesStore;
	emailSender: FakeEmailSender;
	stripeGateway: FakePaymentGateway;
	x402Gateway: FakePaymentGateway;
	shippingRules: InMemoryShippingRulesStore;
	taxRules: InMemoryTaxRulesStore;
}

/** Everything an order suite may reach for, all over one storage instance. */
export interface OrderHarness {
	readonly clock: FixedClock;
	readonly store: EmdashOrderStore;
	readonly cartStore: EmdashCartStore;
	readonly inventory: EmdashInventoryStore;
	readonly notesStore: InMemoryOrderNotesStore;
	readonly entitlementStore: InMemoryEntitlementStore;
	readonly paymentEventStore: InMemoryPaymentEventStore;
	readonly emailSender: FakeEmailSender;
	readonly stripeGateway: FakePaymentGateway;
	readonly x402Gateway: FakePaymentGateway;
	readonly cartDeps: CartDeps;
	readonly createDeps: CreateOrderDeps;
	readonly settleDeps: SettleDeps;
	readonly expireDeps: ExpireOrdersDeps;
	/** The documents, for the assertions the port cannot express. */
	readonly orders: StorageCollection<OrderDoc>;
	readonly orderKeys: StorageCollection<OrderKeyDoc>;
	readonly carts: StorageCollection<CartDoc>;
	readonly inventoryDocs: StorageCollection<InventoryDoc>;
	seedPhysical(input: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
		onHand: number;
	}): Promise<void>;
	seedDigital(input: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
	}): Promise<void>;
	/** Edit a product's price + title through the CMS sync path. */
	editProduct(input: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
	}): Promise<void>;
	/** A cart with the given lines, built through the real add-to-cart use-case. */
	cartWith(
		specs: { sku: string; productId: string; qty: number; kind: FulfillmentKind }[],
	): Promise<string>;
	onHand(sku: string): Promise<number>;
	/** A reservation's observable state: its terminal record, else its live hold. */
	reservationState(reservationId: string): Promise<string | undefined>;
	/** Drive the cart's held-scoped hold sweep past the TTL. */
	sweepHeldHolds(): Promise<number>;
	advance(ms: number): void;
	/** Seed a bare order document (no lines) — the admin list's `seedOrder`. */
	seedOrder(row: SeedOrderSummaryRow): Promise<void>;
	/** Pass to `makeOrderHarness` to build a fault-injected twin of this harness. */
	readonly shared: OrderHarnessShared;
}

/** One fresh set of shared collaborators, all driven by ONE fixed clock. */
function buildShared(): OrderHarnessShared {
	const clock = new FixedClock(new Date(ORDER_EPOCH.getTime()));
	return {
		clock,
		productCommerce: new InMemoryProductCommerceStore({ clock }),
		couponStore: new InMemoryCouponStore({ idGen: uuidIdGen, clock }),
		entitlementStore: new InMemoryEntitlementStore({ idGen: uuidIdGen, clock }),
		paymentEventStore: new InMemoryPaymentEventStore(),
		notesStore: new InMemoryOrderNotesStore({ idGen: new CountingIdGen("note"), clock }),
		emailSender: new FakeEmailSender(),
		stripeGateway: new FakePaymentGateway({ id: "stripe" }),
		x402Gateway: new FakePaymentGateway({ id: "x402" }),
		shippingRules: new InMemoryShippingRulesStore(),
		taxRules: new InMemoryTaxRulesStore(),
	};
}

/** Build an order harness over an already-bound `StorageAccess`. */
export function makeOrderHarness(
	storage: StorageAccess,
	options: OrderHarnessOptions = {},
): OrderHarness {
	const shared: OrderHarnessShared = options.share ?? buildShared();
	const clock = shared.clock;
	const idGen = options.countingIds === true ? new CountingIdGen("oi") : uuidIdGen;
	const retry = {
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
	};
	const inventory = new EmdashInventoryStore({
		storage: options.storageForInventory ?? storage,
		idGen: uuidIdGen,
		clock,
		...retry,
	});
	const cartStore = new EmdashCartStore({
		storage: options.storageForCart ?? storage,
		inventory,
		idGen: uuidIdGen,
		clock,
		...retry,
	});
	const store = new EmdashOrderStore({
		storage: options.storageForOrders ?? storage,
		inventory,
		idGen,
		clock,
		...retry,
		...(options.reporting === undefined ? {} : { reporting: options.reporting }),
	});
	const {
		notesStore,
		productCommerce,
		couponStore,
		entitlementStore,
		paymentEventStore,
		emailSender,
		stripeGateway,
		x402Gateway,
	} = shared;
	let seq = 0;

	const cartDeps: CartDeps = { cartStore, inventoryStore: inventory, clock };
	const createDeps: CreateOrderDeps = {
		orderStore: store,
		cartStore,
		inventoryStore: inventory,
		productCommerce,
		shippingRules: shared.shippingRules,
		taxRules: shared.taxRules,
		couponStore,
		clock,
		idGen: uuidIdGen,
		gateways: { stripe: stripeGateway, x402: x402Gateway },
	};
	const settleDeps: SettleDeps = {
		orderStore: store,
		entitlementStore,
		paymentEventStore,
		inventoryStore: inventory,
		couponStore,
		clock,
	};
	const expireDeps: ExpireOrdersDeps = {
		orderStore: store,
		inventoryStore: inventory,
		couponStore,
		clock,
	};

	const orders = collectionOf<OrderDoc>(options.storageForOrders ?? storage, ORDERS_COLLECTION);
	const orderKeys = collectionOf<OrderKeyDoc>(
		options.storageForOrders ?? storage,
		ORDER_KEYS_COLLECTION,
	);
	const inventoryDocs = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	const reservationIndex = collectionOf<ReservationIndexDoc>(storage, RESERVATION_INDEX_COLLECTION);

	return {
		shared,
		clock,
		store,
		cartStore,
		inventory,
		notesStore,
		entitlementStore,
		paymentEventStore,
		emailSender,
		stripeGateway,
		x402Gateway,
		cartDeps,
		createDeps,
		settleDeps,
		expireDeps,
		orders,
		orderKeys,
		carts: collectionOf<CartDoc>(options.storageForCart ?? storage, CARTS_COLLECTION),
		inventoryDocs,
		async seedPhysical(input) {
			await productCommerce.upsert(
				{
					productId: brandProductId(input.productId),
					sku: brandSku(input.sku),
					price: money(cents(input.priceCents), USD),
					title: input.title,
					productKind: "physical",
				},
				idempotencyKey(`seed-${String(seq++)}`),
			);
			await inventory.seedOnHand(input.sku, input.onHand);
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
				idempotencyKey(`seed-${String(seq++)}`),
			);
		},
		async editProduct(input) {
			await productCommerce.upsert(
				{
					productId: brandProductId(input.productId),
					sku: brandSku(input.sku),
					price: money(cents(input.priceCents), USD),
					title: input.title,
				},
				idempotencyKey(`edit-${String(seq++)}`),
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
					idempotencyKey(`add-${String(seq++)}`),
					spec.kind,
				);
				if (!res.ok) throw new Error(`seed addLine failed: ${res.reason}`);
			}
			return cartId;
		},
		async onHand(sku) {
			const doc = await inventoryDocs.get(sku);
			return doc?.onHand ?? 0;
		},
		async reservationState(reservationId) {
			// The terminal record outlives the hold and is written BEFORE the prune, so
			// it is authoritative; a live reservation has none and its hold answers.
			const index = await reservationIndex.get(reservationId);
			if (index === null) return undefined;
			if (index.terminalState !== undefined) return index.terminalState;
			const doc = await inventoryDocs.get(index.sku);
			if (doc === null) return undefined;
			return normalizeInventoryDoc(doc).holds[index.idempotencyKey]?.state;
		},
		async sweepHeldHolds() {
			const { expireHolds } = await import("@otta-sh/domain");
			clock.advance(16 * 60 * 1000);
			return expireHolds(cartDeps);
		},
		advance(ms) {
			clock.advance(ms);
		},
		async seedOrder(row) {
			// A bare order document: header + totals, no lines — the document analogue
			// of the SQL harness's direct `orders` + `order_totals` insert, so the
			// admin-list cases (INC-B4) can pin an EXACT createdAt/state/buyerRef/total.
			const created = row.createdAt;
			await orders.compareAndSet(row.id, null, {
				orderId: row.id,
				cartId: null,
				currency: currency(row.currency),
				state: row.state,
				idempotencyKey: idempotencyKey(`seed-${row.id}`),
				holdExpiresAt: created,
				paymentMethod: row.paymentMethod ?? null,
				buyerRef: row.buyerRef,
				customerId: row.customerId ?? null,
				customerKey: customerKeyFor(row.customerId ?? null, row.buyerRef),
				buyerRefLower: foldBuyerRef(row.buyerRef),
				// The same denormalization `#prepare` writes — a seeded order is searchable
				// by its id prefix exactly as a checked-out one is. A bare seed has no lines,
				// so it owes no `order_sku_index` documents.
				searchKey: searchKeyFor(row.id),
				emailDueAt: null,
				items: [],
				totals: {
					currency: currency(row.currency),
					subtotal: cents(row.totalCents),
					discount: cents(0),
					shipping: cents(0),
					tax: cents(0),
					total: cents(row.totalCents),
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
				reconciliationFlag: row.reconciliationFlag ?? null,
				reconciliationResolution: null,
				fulfillment: null,
				cancellation: null,
				createdAt: created,
				updatedAt: created,
			});
		},
	};
}

/** The `orderStoreContract` harness shape, over a fresh order harness. */
export function orderStoreHarness(harness: OrderHarness): OrderStoreHarness {
	return { store: harness.store, seedOrder: (row) => harness.seedOrder(row) };
}

/** The `orderTransitionContract` harness shape.
 *
 *  `forceFailedTransition` is deliberately ABSENT: there is no transaction to roll
 *  back on a document store, so the case it drives cannot be reproduced by
 *  aborting one. The property it proves — the flip, the audit event and the outbox
 *  entry are ONE write, all or nothing — is pinned instead in
 *  `order-crash-seams.dialects.test.ts`, which PARKS the single compare-and-set and
 *  asserts none of the three has landed, then releases it and asserts all three
 *  have. That is a stronger statement on this store than a rollback would be. */
export function orderTransitionHarness(harness: OrderHarness): OrderTransitionHarness {
	return { store: harness.store, emailSender: harness.emailSender, clock: harness.clock };
}

/** The `orderTimelineContract` harness shape. */
export function orderTimelineHarness(harness: OrderHarness): OrderTimelineHarness {
	return {
		orderStore: harness.store,
		orderNotesStore: harness.notesStore,
		tick: (ms: number) => harness.advance(ms),
	};
}
