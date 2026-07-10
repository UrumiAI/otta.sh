import type { InventoryStoreHarness } from "@urumi/domain/testing";
import { CountingIdGen, FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import {
	KyselyInventoryStore,
	makePostgresDb,
	makePostgresPool,
	makeSqliteDb,
	migrateToLatest,
} from "../src/index.js";
import type { Database } from "../src/schema.js";

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

/**
 * Fresh, isolated Postgres schema per test (§8 R7): `CREATE SCHEMA test_<rand>`
 * + every pooled connection pinned to it via `search_path`, migrated to latest,
 * dropped on teardown.
 */
export async function makePgHarness(): Promise<DialectHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const schema = `test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

	const admin = makePostgresPool({ connectionString, max: 1 });
	await admin.query(`CREATE SCHEMA "${schema}"`);

	const pool = makePostgresPool({
		connectionString,
		max: 4,
		options: `-c search_path=${schema}`,
	});
	const db = makePostgresDb(pool);
	await migrateToLatest(db);

	cleanups.push(async () => {
		await db.destroy();
		await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
		await admin.end();
	});
	return buildHarness(db);
}
