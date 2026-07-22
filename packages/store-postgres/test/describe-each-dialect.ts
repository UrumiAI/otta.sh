import type {
	CartStoreHarness,
	CouponStoreHarness,
	InventoryStoreHarness,
	ProductCommerceStoreHarness,
	ReportingStoreHarness,
	SettingsStoreHarness,
	ShippingRulesStoreHarness,
	TaxRulesStoreHarness,
} from "@urumi/domain/testing";
import { idempotencyKey } from "@urumi/domain";
import { CountingIdGen, FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import {
	KyselyCartStore,
	KyselyCouponStore,
	KyselyInventoryStore,
	KyselyProductCommerceStore,
	KyselyReportingStore,
	KyselySettingsStore,
	KyselyShippingRulesStore,
	KyselyTaxRulesStore,
	makeSqliteDb,
	migrateToLatest,
	uuidIdGen,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

/** Postgres runs only when the connection string is present (§7 / DEVELOPMENT.md §2). */
export const PG_ENABLED = Boolean(process.env.PG_CONNECTION_STRING);

/** The dialect harness adds the W1 abandon-pending hook the contract case needs. */
export interface DialectHarness extends InventoryStoreHarness {
	abandonPending(sku: string, qty: number, key: string): Promise<void>;
}

// Resources created per test; torn down by `teardownDialects` (an afterEach).
const cleanups: Array<() => Promise<void>> = [];

export async function teardownDialects(): Promise<void> {
	const fns = cleanups.splice(0);
	for (const fn of fns) await fn();
}

function buildHarness(db: Kysely<Database>): DialectHarness {
	const idGen = new CountingIdGen("res");
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new KyselyInventoryStore({ db, idGen, clock });
	return {
		store,
		async seed(sku, qty) {
			await db
				.insertInto("inventory")
				.values({ sku, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async abandonPending(sku, qty, key) {
			// Crash window W1: a `pending` row with the finalize never run.
			await db
				.insertInto("reservations")
				.values({
					id: idGen.newId(),
					sku,
					qty,
					state: "pending",
					idempotency_key: key,
					created_at: clock.now().toISOString(),
				})
				.execute();
		},
		async holdWithExpiry(sku, qty, key, expiresAt) {
			// A held reservation with the cart's hold deadline stamped on it — the
			// precondition adoptMany's `expires_at > :now` guard needs (a bare
			// `reserve` leaves `expires_at` NULL). Mirrors the cart store's stamp.
			const r = await store.reserve(sku, qty, idempotencyKey(key));
			if (!r.ok) throw new Error(`holdWithExpiry reserve failed for ${sku}`);
			await db
				.updateTable("reservations")
				.set({ expires_at: expiresAt })
				.where("id", "=", r.reservationId)
				.execute();
			return r.reservationId;
		},
	};
}

/** Fresh, isolated in-memory SQLite db, migrated to latest. */
export async function makeSqliteHarness(): Promise<DialectHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildHarness(db);
}

/** Fresh, isolated Postgres schema per test (§8 R7) via the shared helper. */
export async function makePgHarness(): Promise<DialectHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return buildHarness(iso.db);
}

// -- Phase 1: ProductCommerceStore harness ----------------------------------

function buildProductCommerceHarness(db: Kysely<Database>): ProductCommerceStoreHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return {
		store: new KyselyProductCommerceStore({ db, clock }),
		// Phase 2 (`listCommerceByIds`): seed the REAL inventory table the
		// store's single-statement inStock join reads.
		async seedStock(sku, qty) {
			await db
				.insertInto("inventory")
				.values({ sku, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		// Admin-UX Increment 2: a direct `product_commerce` insert (mirrors
		// `buildOrderStoreHarness.seedOrder`) so the admin-list contract can pin
		// an EXACT `created_at` per row — the fake, sqlite, and pg then exercise
		// the identical `listProducts` spec.
		async seedProduct(row) {
			await db
				.insertInto("product_commerce")
				.values({
					product_id: row.id,
					sku: row.sku ?? null,
					price_cents: row.priceCents ?? null,
					price_currency:
						row.priceCents !== undefined && row.priceCents !== null
							? (row.currency ?? "USD")
							: null,
					title: row.title ?? null,
					tax_class: null,
					weight_grams: null,
					length_mm: null,
					width_mm: null,
					height_mm: null,
					product_kind: row.productKind ?? "physical",
					active: (row.active ?? false) ? 1 : 0,
					deleted_at: row.deletedAt ?? null,
					idempotency_key: `seed-${row.id}`,
					content_updated_at: null,
					active_updated_at: null,
					created_at: row.createdAt,
					updated_at: row.createdAt,
				})
				.execute();
		},
	};
}

/** Fresh, isolated in-memory SQLite db, migrated to latest. */
export async function makeSqliteProductCommerceHarness(): Promise<ProductCommerceStoreHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildProductCommerceHarness(db);
}

/** Fresh, isolated Postgres schema per test (§8 R7) via the shared helper. */
export async function makePgProductCommerceHarness(): Promise<ProductCommerceStoreHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return buildProductCommerceHarness(iso.db);
}

// -- cart harness ------------------------------------------------------------

export interface CartDialectHarness extends CartStoreHarness {
	db: Kysely<Database>;
	clock: FixedClock;
}

function buildCartHarness(db: Kysely<Database>): CartDialectHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
	return {
		deps: { cartStore, inventoryStore: inventory, clock },
		db,
		clock,
		async seedStock(sku, qty) {
			await db
				.insertInto("inventory")
				.values({ sku, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		advance(ms) {
			clock.advance(ms);
		},
	};
}

export async function makeSqliteCartHarness(): Promise<CartDialectHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return buildCartHarness(db);
}

export async function makePgCartHarness(): Promise<CartDialectHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return buildCartHarness(iso.db);
}

// -- Phase 6: shipping / tax / coupon harnesses ------------------------------

async function makeSqliteDbMigrated(): Promise<Kysely<Database>> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return db;
}

async function makePgDbMigrated(poolMax = 4): Promise<Kysely<Database>> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax });
	cleanups.push(() => iso.teardown());
	return iso.db;
}

export async function makeSqliteShippingHarness(): Promise<ShippingRulesStoreHarness> {
	return { store: new KyselyShippingRulesStore({ db: await makeSqliteDbMigrated() }) };
}
export async function makePgShippingHarness(): Promise<ShippingRulesStoreHarness> {
	return { store: new KyselyShippingRulesStore({ db: await makePgDbMigrated() }) };
}

export async function makeSqliteTaxHarness(): Promise<TaxRulesStoreHarness> {
	return { store: new KyselyTaxRulesStore({ db: await makeSqliteDbMigrated() }) };
}
export async function makePgTaxHarness(): Promise<TaxRulesStoreHarness> {
	return { store: new KyselyTaxRulesStore({ db: await makePgDbMigrated() }) };
}

export async function makeSqliteCouponHarness(): Promise<CouponStoreHarness> {
	return {
		store: new KyselyCouponStore({
			db: await makeSqliteDbMigrated(),
			idGen: new CountingIdGen("red"),
		}),
	};
}
export async function makePgCouponHarness(): Promise<CouponStoreHarness> {
	return { store: new KyselyCouponStore({ db: await makePgDbMigrated(), idGen: uuidIdGen }) };
}

// -- Phase 7: reporting + settings harnesses ---------------------------------

function buildReportingHarness(
	db: Kysely<Database>,
	dialect: "sqlite" | "postgres",
): ReportingStoreHarness {
	return {
		store: new KyselyReportingStore({ db, dialect }),
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
					payment_method: null,
					buyer_ref: "seed",
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
		async seedOrderItem(row) {
			await db
				.insertInto("order_items")
				.values({
					id: `${row.orderId}-${row.productId}`,
					order_id: row.orderId,
					product_id: row.productId,
					sku: `sku-${row.productId}`,
					title: row.title,
					unit_price_cents: row.unitPriceCents,
					currency: "USD",
					quantity: row.quantity,
					fulfillment_kind: "physical",
					reservation_id: null,
				})
				.execute();
		},
		async seedInventory(row) {
			await db
				.insertInto("inventory")
				.values({ sku: row.sku, on_hand: row.onHand })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: row.onHand }))
				.execute();
		},
	};
}

export async function makeSqliteReportingHarness(): Promise<ReportingStoreHarness> {
	return buildReportingHarness(await makeSqliteDbMigrated(), "sqlite");
}
export async function makePgReportingHarness(): Promise<ReportingStoreHarness> {
	return buildReportingHarness(await makePgDbMigrated(), "postgres");
}

export async function makeSqliteSettingsHarness(): Promise<SettingsStoreHarness> {
	return {
		store: new KyselySettingsStore({
			db: await makeSqliteDbMigrated(),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		}),
	};
}
export async function makePgSettingsHarness(): Promise<SettingsStoreHarness> {
	return {
		store: new KyselySettingsStore({
			db: await makePgDbMigrated(),
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		}),
	};
}
