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
} from "@urumi/domain";
import {
	CountingIdGen,
	type EntitlementStoreHarness,
	FakeEmailSender,
	FakePaymentGateway,
	FixedClock,
	type OrderNotesStoreHarness,
	type OrderStoreHarness,
	type OrderTimelineHarness,
	type OrderTransitionHarness,
} from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import {
	KyselyCartStore,
	KyselyCouponStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderNotesStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	KyselyShippingRulesStore,
	KyselyTaxRulesStore,
	makeSqliteDb,
	migrateToLatest,
	uuidIdGen,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const USD = currency("USD");
const cleanups: Array<() => Promise<void>> = [];

export async function teardownOrderFlow(): Promise<void> {
	const fns = cleanups.splice(0);
	for (const fn of fns) await fn();
}

export interface OrderFlowHarness {
	db: Kysely<Database>;
	clock: FixedClock;
	createDeps: CreateOrderDeps;
	settleDeps: SettleDeps;
	expireDeps: ExpireOrdersDeps;
	cartDeps: CartDeps;
	orderStore: KyselyOrderStore;
	entitlementStore: KyselyEntitlementStore;
	paymentEventStore: KyselyPaymentEventStore;
	couponStore: KyselyCouponStore;
	inventory: KyselyInventoryStore;
	cartStore: KyselyCartStore;
	stripeGw: FakePaymentGateway;
	x402Gw: FakePaymentGateway;
	seedPhysical(i: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
		onHand: number;
	}): Promise<void>;
	seedDigital(i: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
	}): Promise<void>;
	editProduct(i: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
	}): Promise<void>;
	cartWith(
		specs: { sku: string; productId: string; qty: number; kind: FulfillmentKind }[],
	): Promise<string>;
	onHand(sku: string): Promise<number>;
	reservationState(id: string): Promise<string | undefined>;
	sweepHeldHolds(): Promise<number>;
}

function build(db: Kysely<Database>): OrderFlowHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
	const productCommerce = new KyselyProductCommerceStore({ db, clock });
	const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
	const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
	const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });
	const stripeGw = new FakePaymentGateway({ id: "stripe" });
	const x402Gw = new FakePaymentGateway({ id: "x402" });
	let seq = 0;

	const couponStore = new KyselyCouponStore({ db, idGen: uuidIdGen });
	const cartDeps: CartDeps = { cartStore, inventoryStore: inventory, clock };
	const createDeps: CreateOrderDeps = {
		orderStore,
		cartStore,
		inventoryStore: inventory,
		productCommerce,
		shippingRules: new KyselyShippingRulesStore({ db }),
		taxRules: new KyselyTaxRulesStore({ db }),
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
		db,
		clock,
		createDeps,
		settleDeps,
		expireDeps,
		cartDeps,
		orderStore,
		entitlementStore,
		paymentEventStore,
		couponStore,
		inventory,
		cartStore,
		stripeGw,
		x402Gw,
		async seedPhysical(i) {
			await productCommerce.upsert(
				{
					productId: brandProductId(i.productId),
					sku: brandSku(i.sku),
					price: money(cents(i.priceCents), USD),
					title: i.title,
					productKind: "physical",
				},
				idempotencyKey(`seed-${seq++}`),
			);
			await inventory.seedOnHand(i.sku, i.onHand);
		},
		async seedDigital(i) {
			await productCommerce.upsert(
				{
					productId: brandProductId(i.productId),
					sku: brandSku(i.sku),
					price: money(cents(i.priceCents), USD),
					title: i.title,
					productKind: "digital",
				},
				idempotencyKey(`seed-${seq++}`),
			);
		},
		async editProduct(i) {
			// Edit the product's price + title via the Phase-1 sync path.
			await productCommerce.upsert(
				{
					productId: brandProductId(i.productId),
					sku: brandSku(i.sku),
					price: money(cents(i.priceCents), USD),
					title: i.title,
				},
				idempotencyKey(`edit-${seq++}`),
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
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async reservationState(id) {
			const row = await db
				.selectFrom("reservations")
				.select("state")
				.where("id", "=", id)
				.executeTakeFirst();
			return row?.state;
		},
		async sweepHeldHolds() {
			// Drive the Phase-3 reservation sweep directly (held-scoped) to prove an
			// adopted hold is invisible to it.
			const { expireHolds } = await import("@urumi/domain");
			clock.advance(16 * 60 * 1000);
			return expireHolds(cartDeps);
		},
	};
}

export async function makeSqliteOrderFlow(): Promise<OrderFlowHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return build(db);
}

export async function makePgOrderFlow(): Promise<OrderFlowHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 8 });
	cleanups.push(() => iso.teardown());
	return build(iso.db);
}

// -- store contract harnesses (order + entitlement) --------------------------

export function buildOrderStoreHarness(db: Kysely<Database>): OrderStoreHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return {
		store: new KyselyOrderStore({ db, idGen: new CountingIdGen("oi"), clock }),
		// Direct orders + order_totals insert (mirrors the reporting harness) so the
		// admin-list contract can pin an EXACT created_at/state/buyer_ref/total per
		// row — the fake, sqlite, and pg then exercise the identical spec (MOD-5).
		async seedOrder(row) {
			await db
				.insertInto("orders")
				.values({
					id: row.id,
					cart_id: null,
					currency: row.currency,
					state: row.state as Database["orders"]["state"],
					idempotency_key: `seed-${row.id}`,
					hold_expires_at: row.createdAt,
					payment_method: row.paymentMethod ?? null,
					buyer_ref: row.buyerRef,
					customer_id: row.customerId ?? null,
					reconciliation_flag: row.reconciliationFlag ?? null,
					created_at: row.createdAt,
					updated_at: row.createdAt,
				})
				.execute();
			await db
				.insertInto("order_totals")
				.values({
					order_id: row.id,
					currency: row.currency,
					subtotal_cents: row.totalCents,
					discount_cents: 0,
					shipping_cents: 0,
					tax_cents: 0,
					total_cents: row.totalCents,
					applied_coupon_code: null,
					shipping_method_snapshot: null,
					tax_breakdown: null,
				})
				.execute();
		},
	};
}

export function buildEntitlementHarness(db: Kysely<Database>): EntitlementStoreHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return {
		store: new KyselyEntitlementStore({ db, idGen: new CountingIdGen("ent"), clock }),
		async revoke(orderId: string) {
			await db
				.updateTable("entitlements")
				.set({ state: "revoked" })
				.where("order_id", "=", orderId)
				.execute();
		},
	};
}

export async function makeSqliteOrderStoreHarness(): Promise<OrderStoreHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildOrderStoreHarness(db);
}

export async function makePgOrderStoreHarness(): Promise<OrderStoreHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return buildOrderStoreHarness(iso.db);
}

export async function makeSqliteEntitlementHarness(): Promise<EntitlementStoreHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildEntitlementHarness(db);
}

export async function makePgEntitlementHarness(): Promise<EntitlementStoreHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return buildEntitlementHarness(iso.db);
}

// -- order transition + email outbox harness (Phase 5 §5) --------------------

export function buildOrderTransitionHarness(db: Kysely<Database>): OrderTransitionHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new KyselyOrderStore({ db, idGen: new CountingIdGen("oi"), clock });
	const emailSender = new FakeEmailSender();
	return {
		store,
		emailSender,
		clock,
		// The real transition transaction, force-rolled-back (§5 atomicity case).
		forceFailedTransition: (input) => store.transitionForTestRollback(input),
	};
}

export async function makeSqliteOrderTransitionHarness(): Promise<OrderTransitionHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildOrderTransitionHarness(db);
}

export async function makePgOrderTransitionHarness(): Promise<OrderTransitionHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return buildOrderTransitionHarness(iso.db);
}

// -- order notes harness (admin-UX Increment 0) ------------------------------

/** The concrete Kysely notes store + the FixedClock the contract's `tick()`
 *  advances — so sqlite, pg, and the fake exercise the identical append-order
 *  spec. `CountingIdGen("note")` gives lexically-increasing ids, so the
 *  `created_at ASC, id ASC` order the SQL emits IS append order under a fixed
 *  clock (mirrors `buildOrderStoreHarness`'s deterministic idGen). */
export function buildOrderNotesStoreHarness(
	db: Kysely<Database>,
): OrderNotesStoreHarness & { store: KyselyOrderNotesStore; clock: FixedClock } {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new KyselyOrderNotesStore({ db, idGen: new CountingIdGen("note"), clock });
	return { store, clock, tick: (ms: number) => clock.advance(ms) };
}

export async function makeSqliteOrderNotesStoreHarness(): Promise<OrderNotesStoreHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildOrderNotesStoreHarness(db);
}

export async function makePgOrderNotesStoreHarness(): Promise<
	OrderNotesStoreHarness & { store: KyselyOrderNotesStore }
> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	// poolMax ≥ N so the concurrent-replay race runs on independent connections.
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 8 });
	cleanups.push(() => iso.teardown());
	return buildOrderNotesStoreHarness(iso.db);
}

// -- order timeline / audit harness (admin-UX Increment 1, timeline slice) ----

/** An order store + a notes store over ONE db, sharing a FixedClock the
 *  contract's `tick()` advances — so the state-change audit (order_events) and
 *  the notes interleave on one merged timeline, and sqlite/pg/the fake exercise
 *  the identical spec. `CountingIdGen` gives lexically-increasing ids so `at ASC,
 *  id ASC` IS chronological under a fixed clock. */
export function buildOrderTimelineHarness(db: Kysely<Database>): OrderTimelineHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return {
		orderStore: new KyselyOrderStore({ db, idGen: new CountingIdGen("oi"), clock }),
		orderNotesStore: new KyselyOrderNotesStore({ db, idGen: new CountingIdGen("note"), clock }),
		tick: (ms: number) => clock.advance(ms),
	};
}

export async function makeSqliteOrderTimelineHarness(): Promise<OrderTimelineHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildOrderTimelineHarness(db);
}

export async function makePgOrderTimelineHarness(): Promise<OrderTimelineHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 8 });
	cleanups.push(() => iso.teardown());
	return buildOrderTimelineHarness(iso.db);
}
