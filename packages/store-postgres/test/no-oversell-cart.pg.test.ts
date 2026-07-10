import { addLine, type CartDeps, createCart, currency, idempotencyKey, sku } from "@urumi/domain";
import { FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyCartStore, KyselyInventoryStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// F1 — THE Phase-3 acceptance gate (Postgres-required, skipped without
// PG_CONNECTION_STRING). N concurrent add-to-cart requests across stock M (N>M),
// each on an INDEPENDENT connection, must never oversell: exactly M carts get a
// line, N−M get OUT_OF_STOCK, and final on_hand == 0. The guarantee must survive
// the cart layer, not just the raw reserve endpoint. Looped like Phase-0's gate.

const PG = process.env.PG_CONNECTION_STRING;
const USD = currency("USD");

interface CartFixture {
	deps: CartDeps;
	db: Kysely<Database>;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
	reset(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function freshCartFixture(poolMax: number): Promise<CartFixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
	const inventoryStore = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	return {
		deps: { cartStore, inventoryStore, clock },
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
		async reset() {
			await db.deleteFrom("cart_mutations").execute();
			await db.deleteFrom("cart_lines").execute();
			await db.deleteFrom("carts").execute();
			await db.deleteFrom("reservations").execute();
		},
	};
}

describe.skipIf(PG === undefined)("no oversell through a cart [postgres]", () => {
	test("N concurrent add-to-carts at stock M (M<N) never oversell", async () => {
		const M = 5;
		const N = 50;
		const LOOPS = 15;
		const h = await freshCartFixture(N + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.reset();
			await h.seed("SKU-1", M);

			// Each request is its own cart; the concurrent adds race the same stock.
			const cartIds = await Promise.all(Array.from({ length: N }, () => createCart(h.deps, USD)));
			const results = await Promise.all(
				cartIds.map((cartId, i) =>
					addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey(`k-${loop}-${i}`)),
				),
			);

			const ok = results.filter((r) => r.ok).length;
			const oos = results.filter((r) => !r.ok && r.reason === "OUT_OF_STOCK").length;
			expect(ok, `loop ${loop}: carts with a line`).toBe(M);
			expect(oos, `loop ${loop}: OUT_OF_STOCK count`).toBe(N - M);
			expect(await h.onHand("SKU-1"), `loop ${loop}: final on_hand`).toBe(0);

			const lineCount = await h.db
				.selectFrom("cart_lines")
				.select((eb) => eb.fn.countAll<number>().as("n"))
				.executeTakeFirstOrThrow();
			expect(Number(lineCount.n), `loop ${loop}: cart_lines written`).toBe(M);
		}
	}, 180_000);
});
