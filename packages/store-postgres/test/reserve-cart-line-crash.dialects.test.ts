import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	idempotencyKey,
	sku,
} from "@urumi/domain";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CartDialectHarness,
	makePgCartHarness,
	makeSqliteCartHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// C4 (required, §7/§8 Risk 2) — the reserve↔cart-line crash window against real
// stores. Seed a held reservation with no cart line (a real process kill is not
// reproducible in CI) and assert idempotent-replay healing + TTL/sweep reclaim.
afterEach(teardownDialects);

const USD = currency("USD");

/** Insert a `held` reservation and apply its decrement — the state after a
 *  reserve that finalized but whose cart-line write never landed. */
async function seedCrashedHold(
	h: CartDialectHarness,
	opts: {
		id: string;
		sku: string;
		qty: number;
		key: string;
		createdAt: string;
		onHandAfter: number;
	},
): Promise<void> {
	await h.db
		.insertInto("reservations")
		.values({
			id: opts.id,
			sku: opts.sku,
			qty: opts.qty,
			state: "held",
			idempotency_key: opts.key,
			created_at: opts.createdAt,
			expires_at: null,
		})
		.execute();
	await h.db
		.updateTable("inventory")
		.set({ on_hand: opts.onHandAfter })
		.where("sku", "=", opts.sku)
		.execute();
}

function runCrashWindow(make: () => Promise<CartDialectHarness>, dialect: string): void {
	describe(`reserve ↔ cart-line crash window [${dialect}]`, () => {
		test("a replayed add heals the missing line without a second decrement", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			await seedCrashedHold(h, {
				id: "res-crash-1",
				sku: "SKU-1",
				qty: 2,
				key: "k1",
				createdAt: h.clock.now().toISOString(),
				onHandAfter: 3,
			});
			const cartId = await createCart(h.deps, USD);

			const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			expect(replay.line.reservationId).toBe("res-crash-1");
			expect(await h.onHand("SKU-1")).toBe(3); // still exactly one decrement
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
		});

		test("an unreplayed dangling hold is reclaimed by the sweep once its TTL passes", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			// created_at older than the TTL so the NULL-expires fallback reaps it.
			const stale = new Date(h.clock.now().getTime() - 20 * 60 * 1000).toISOString();
			await seedCrashedHold(h, {
				id: "res-crash-2",
				sku: "SKU-1",
				qty: 2,
				key: "k1",
				createdAt: stale,
				onHandAfter: 3,
			});

			expect(await expireHolds(h.deps)).toBe(1);
			expect(await h.onHand("SKU-1")).toBe(5);
			const res = await h.db
				.selectFrom("reservations")
				.select("state")
				.where("id", "=", "res-crash-2")
				.executeTakeFirst();
			expect(res?.state).toBe("released");
		});
	});
}

runCrashWindow(makeSqliteCartHarness, "sqlite");
describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	runCrashWindow(makePgCartHarness, "pg");
});
