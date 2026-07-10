import {
	addLine,
	type CartDeps,
	createCart,
	currency,
	idempotencyKey,
	sku,
	updateLine,
} from "@urumi/domain";
import { FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyCartStore, KyselyInventoryStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// B2 — adjust must be exactly-once under REAL concurrency (Postgres-required,
// independent connections; better-sqlite3 serializes on one connection and
// cannot race). The claim (`INSERT … ON CONFLICT`) + guarded CAS + movement
// commit in one tx, so a double-clicked PATCH moves stock once and racing
// different-key adjusts settle with no lost update and no over-return.

const PG = process.env.PG_CONNECTION_STRING;
const USD = currency("USD");

interface Fixture {
	deps: CartDeps;
	store: KyselyInventoryStore;
	db: Kysely<Database>;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
	reservationQty(id: string): Promise<number>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function freshFixture(poolMax: number): Promise<Fixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
	return {
		deps: { cartStore, inventoryStore: store, clock },
		store,
		db,
		async seed(s, qty) {
			await db
				.insertInto("inventory")
				.values({ sku: s, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(s) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", s)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async reservationQty(id) {
			const row = await db
				.selectFrom("reservations")
				.select("qty")
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
			return row.qty;
		},
	};
}

describe.skipIf(PG === undefined)("adjust concurrency [postgres]", () => {
	test("concurrent same-key adjusts move inventory exactly once and leave reservation and line consistent", async () => {
		const RACERS = 12;
		const LOOPS = 10;
		const h = await freshFixture(RACERS + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			const skuName = `SKU-${loop}`;
			await h.seed(skuName, 100);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(
				h.deps,
				cartId,
				sku(skuName),
				null,
				2,
				idempotencyKey(`add-${loop}`),
			);
			if (!add.ok) throw new Error("seed add must succeed");
			const lineId = add.line.lineId;
			const reservationId = add.line.reservationId ?? "";

			// A double-(×12)-clicked "set qty to 7": every racer shares ONE key.
			const key = idempotencyKey(`same-${loop}`);
			const results = await Promise.all(
				Array.from({ length: RACERS }, () => updateLine(h.deps, cartId, lineId, 7, key)),
			);

			for (const r of results) expect(r.ok, `loop ${loop}: all racers ok`).toBe(true);
			// The delta (7−2=5) applied EXACTLY once: 100 − 2 − 5 = 93.
			expect(await h.onHand(skuName), `loop ${loop}: on_hand`).toBe(93);
			expect(await h.reservationQty(reservationId), `loop ${loop}: reservation qty`).toBe(7);
			const line = await h.db
				.selectFrom("cart_lines")
				.select("qty")
				.where("id", "=", lineId)
				.executeTakeFirstOrThrow();
			expect(line.qty, `loop ${loop}: line qty`).toBe(7);
		}
	}, 120_000);

	test("concurrent different-key adjusts on one line settle consistently: no lost update, no over-return", async () => {
		const LOOPS = 10;
		const M = 100;
		const h = await freshFixture(12);

		for (let loop = 0; loop < LOOPS; loop++) {
			const skuName = `SKU-${loop}`;
			await h.seed(skuName, M);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(
				h.deps,
				cartId,
				sku(skuName),
				null,
				5,
				idempotencyKey(`add-${loop}`),
			);
			if (!add.ok) throw new Error("seed add must succeed");
			const lineId = add.line.lineId;
			const reservationId = add.line.reservationId ?? "";

			// Distinct user intents racing on one line: →2, →9, →4, →7.
			const targets = [2, 9, 4, 7];
			const results = await Promise.all(
				targets.map((t, i) =>
					updateLine(h.deps, cartId, lineId, t, idempotencyKey(`k-${loop}-${i}`)),
				),
			);
			for (const r of results) expect(r.ok, `loop ${loop}: all adjusts settle ok`).toBe(true);

			// CONSERVATION — the invariant that forbids both a lost update (stock
			// leaked to the shelf) and an over-return: whatever the serialization
			// order, held + on-hand must equal the seeded total, and the reservation
			// must have landed on one of the requested targets with the line synced.
			const resQty = await h.reservationQty(reservationId);
			expect(targets, `loop ${loop}: final qty is a requested target`).toContain(resQty);
			expect(await h.onHand(skuName), `loop ${loop}: conservation`).toBe(M - resQty);
			const line = await h.db
				.selectFrom("cart_lines")
				.select("qty")
				.where("id", "=", lineId)
				.executeTakeFirstOrThrow();
			expect(line.qty, `loop ${loop}: line mirrors the reservation`).toBe(resQty);
		}
	}, 120_000);
});
