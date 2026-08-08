import { idempotencyKey, productId, sku } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyProductCommerceStore, makeSqliteDb, migrateToLatest } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

/**
 * The sku-rename carry's AUDIT TRAIL — the pair of `inventory_stock_movements`
 * rows a rename writes for the units it moved.
 *
 * This lives outside `productCommerceStoreContract` because the ledger is a
 * STORE table, not part of the `ProductCommerceStore` port: the fake has no
 * such table and nothing to say about it, so the contract suite cannot see
 * these rows. It runs per dialect all the same, because the trail is a
 * durability claim and only a real database can be asked whether it kept it.
 */

const PG_ENABLED = Boolean(process.env.PG_CONNECTION_STRING);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function makeSqliteRawDb(): Promise<Kysely<Database>> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return db;
}

async function makePgRawDb(): Promise<Kysely<Database>> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return iso.db;
}

/** Every ledger row for a sku, oldest first. */
async function movements(db: Kysely<Database>, s: string) {
	return db
		.selectFrom("inventory_stock_movements")
		.selectAll()
		.where("sku", "=", s)
		.orderBy("created_at")
		.execute();
}

/** A live product on `s`, its inventory row stocked at `onHand`; returns the
 *  `updatedAt` watermark its next guarded edit has to pass back. */
async function seedStocked(
	db: Kysely<Database>,
	store: KyselyProductCommerceStore,
	id: string,
	s: string,
	onHand: number,
): Promise<string> {
	const row = await store.upsert(
		{ productId: productId(id), sku: sku(s) },
		idempotencyKey(`seed-${id}`),
	);
	await db.insertInto("inventory").values({ sku: s, on_hand: onHand }).execute();
	return row.updatedAt.toISOString();
}

function renameLedgerSuite(makeDb: () => Promise<Kysely<Database>>, dialect: string): void {
	describe(`sku-rename audit trail [${dialect}]`, () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

		test("a rename writes one row OUT of the source and one INTO the target, with the moved quantity on both", async () => {
			const db = await makeDb();
			const store = new KyselyProductCommerceStore({ db, clock });
			const wm = await seedStocked(db, store, "prod-led", "SKU-LED-FROM", 40);

			const res = await store.updateCommerceFields(
				{ productId: productId("prod-led"), sku: sku("SKU-LED-TO") },
				idempotencyKey("led-rename"),
				wm,
			);
			expect(res.ok).toBe(true);

			const out = await movements(db, "SKU-LED-FROM");
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({
				sku: "SKU-LED-FROM",
				direction: "rename_out",
				qty: 40,
				outcome: "ok",
				// The source is left empty, so its resulting count is 0.
				result_on_hand: 0,
			});

			const into = await movements(db, "SKU-LED-TO");
			expect(into).toHaveLength(1);
			expect(into[0]).toMatchObject({
				sku: "SKU-LED-TO",
				direction: "rename_in",
				qty: 40,
				outcome: "ok",
				// The target ends holding exactly what arrived.
				result_on_hand: 40,
			});

			// The two rows are a PAIR: same quantity, opposite ends of one move, so
			// the ledger can be read as "40 left here, 40 arrived there" rather than
			// two unrelated adjustments.
			expect(out[0]?.qty).toBe(into[0]?.qty);
		});

		test("the trail commits WITH the move — a refused rename leaves no ledger row behind", async () => {
			const db = await makeDb();
			const store = new KyselyProductCommerceStore({ db, clock });
			const wm = await seedStocked(db, store, "prod-led-ref", "SKU-LEDR-FROM", 12);
			// An occupied target: the rename is refused after the source has been
			// read and locked, so the whole transaction rolls back.
			await db.insertInto("inventory").values({ sku: "SKU-LEDR-TAKEN", on_hand: 3 }).execute();

			await expect(
				store.updateCommerceFields(
					{ productId: productId("prod-led-ref"), sku: sku("SKU-LEDR-TAKEN") },
					idempotencyKey("ledr-rename"),
					wm,
				),
			).rejects.toMatchObject({ name: "SkuStockConflictError" });

			// No move, therefore no record of one — the trail can never claim units
			// travelled that did not.
			expect(await movements(db, "SKU-LEDR-FROM")).toHaveLength(0);
			expect(await movements(db, "SKU-LEDR-TAKEN")).toHaveLength(0);
		});

		test("an idempotent REPLAY of a rename writes no second pair", async () => {
			const db = await makeDb();
			const store = new KyselyProductCommerceStore({ db, clock });
			const wm = await seedStocked(db, store, "prod-led-rep", "SKU-LEDP-FROM", 25);
			const key = idempotencyKey("ledp-rename");
			const input = { productId: productId("prod-led-rep"), sku: sku("SKU-LEDP-TO") };

			await store.updateCommerceFields(input, key, wm);
			const replay = await store.updateCommerceFields(input, key, wm);
			expect(replay.ok).toBe(true);

			// A replay applies no update, so it never carries, so it records
			// nothing: the ledger counts MOVEMENTS, not attempts.
			expect(await movements(db, "SKU-LEDP-FROM")).toHaveLength(1);
			expect(await movements(db, "SKU-LEDP-TO")).toHaveLength(1);
		});

		test("a rename that carries NOTHING records nothing — an empty source is not a movement", async () => {
			const db = await makeDb();
			const store = new KyselyProductCommerceStore({ db, clock });
			const wm = await seedStocked(db, store, "prod-led-zero", "SKU-LEDZ-FROM", 0);

			const res = await store.updateCommerceFields(
				{ productId: productId("prod-led-zero"), sku: sku("SKU-LEDZ-TO") },
				idempotencyKey("ledz-rename"),
				wm,
			);
			expect(res.ok).toBe(true);

			// The rename happened and the target row was claimed, but zero units
			// moved. `qty > 0` is a column CHECK, so a zero-quantity entry could not
			// be written even if we wanted one — and it would be a lie regardless.
			expect(await movements(db, "SKU-LEDZ-FROM")).toHaveLength(0);
			expect(await movements(db, "SKU-LEDZ-TO")).toHaveLength(0);
		});

		test("a ledger key collision costs the audit row, never the merchant's rename", async () => {
			const db = await makeDb();
			const store = new KyselyProductCommerceStore({ db, clock });
			const wm = await seedStocked(db, store, "prod-led-col", "SKU-LEDC-FROM", 30);

			// These keys are derived from the CLIENT's idempotency key, so a caller
			// can occupy one — by reusing a key across two renames of the same
			// source sku, or by crafting a restock key that lands on the same
			// string. Squat on the "out" key with a real movement row.
			await db
				.insertInto("inventory_stock_movements")
				.values({
					idempotency_key: "ledc-rename:sku-rename:out:SKU-LEDC-FROM",
					sku: "SKU-LEDC-FROM",
					direction: "removal",
					qty: 1,
					outcome: "ok",
					result_on_hand: 29,
					created_at: "2026-07-09T00:00:00.000Z",
				})
				.execute();

			const res = await store.updateCommerceFields(
				{ productId: productId("prod-led-col"), sku: sku("SKU-LEDC-TO") },
				idempotencyKey("ledc-rename"),
				wm,
			);

			// The rename is legal and must not be aborted by a collision in its own
			// bookkeeping — a raw unique violation here would fail a correct write
			// on a key the operator never chose.
			expect(res.ok).toBe(true);
			expect(
				await db
					.selectFrom("inventory")
					.select("on_hand")
					.where("sku", "=", "SKU-LEDC-TO")
					.executeTakeFirst(),
			).toEqual({ on_hand: 30 });

			// The squatted row is left exactly as it was — the carry's own entry is
			// what gets dropped, and only that one.
			const out = await movements(db, "SKU-LEDC-FROM");
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ direction: "removal", qty: 1 });
		});
	});
}

renameLedgerSuite(makeSqliteRawDb, "sqlite");

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	renameLedgerSuite(makePgRawDb, "pg");
});
