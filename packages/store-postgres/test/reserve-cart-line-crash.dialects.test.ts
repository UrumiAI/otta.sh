import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	idempotencyKey,
	removeLine,
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

/** Insert a `held` reservation and apply its decrement — the state after an
 *  add-to-cart that claimed its mutation key, reserved, and crashed before the
 *  cart-line write. The `cart_mutations` claim row (written BEFORE the reserve
 *  in the ledger-first choreography) is what marks the dangling hold
 *  cart-originated, so the sweep may reap it; a raw reserve has no claim and is
 *  never reaped (see hold-expiry.dialects.test.ts). */
async function seedCrashedHold(
	h: CartDialectHarness,
	opts: {
		id: string;
		cartId: string;
		sku: string;
		qty: number;
		key: string;
		createdAt: string;
		onHandAfter: number;
	},
): Promise<void> {
	await h.db
		.insertInto("cart_mutations")
		.values({
			idempotency_key: opts.key,
			cart_id: opts.cartId,
			line_id: null,
			kind: "add",
			resulting_qty: null,
			completed: 0,
			created_at: opts.createdAt,
		})
		.execute();
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
			const cartId = await createCart(h.deps, USD);
			await seedCrashedHold(h, {
				id: "res-crash-1",
				cartId,
				sku: "SKU-1",
				qty: 2,
				key: "k1",
				createdAt: h.clock.now().toISOString(),
				onHandAfter: 3,
			});

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
			const cartId = await createCart(h.deps, USD);
			// created_at older than the TTL so the NULL-expires fallback reaps it.
			const stale = new Date(h.clock.now().getTime() - 20 * 60 * 1000).toISOString();
			await seedCrashedHold(h, {
				id: "res-crash-2",
				cartId,
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

		test("a late add replay after the sweep reaped its crashed hold does not resurrect a line (HOLD_EXPIRED)", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			// Crashed add: claim + held reservation, no cart line; TTL long past.
			const stale = new Date(h.clock.now().getTime() - 20 * 60 * 1000).toISOString();
			await seedCrashedHold(h, {
				id: "res-crash-3",
				cartId,
				sku: "SKU-1",
				qty: 2,
				key: "k1",
				createdAt: stale,
				onHandAfter: 3,
			});

			// The sweep reaps the dangling hold and returns its stock.
			expect(await expireHolds(h.deps)).toBe(1);
			expect(await h.onHand("SKU-1")).toBe(5);

			// The ORIGINAL key finally replays: reserve resolves the released hold
			// as ok (Phase-0 replay-by-state), but the `state='held'`-scoped attach
			// guard matches 0 rows — no visible line over dead stock, typed failure.
			const late = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			expect(late).toEqual({ ok: false, reason: "HOLD_EXPIRED" });
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
			expect(await h.onHand("SKU-1")).toBe(5); // stock unchanged
			const res = await h.db
				.selectFrom("reservations")
				.select("state")
				.where("id", "=", "res-crash-3")
				.executeTakeFirst();
			expect(res?.state).toBe("released");
		});

		test("a remove that crashed after release is healed on replay: line removed, stock returned exactly once", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("add must succeed");
			const reservationId = add.line.reservationId ?? "";
			expect(await h.onHand("SKU-1")).toBe(3);

			// Crash simulation: the remove's `release` landed (stock returned,
			// reservation `released`) but the line delete never ran.
			await h.deps.inventoryStore.release(reservationId);
			expect(await h.onHand("SKU-1")).toBe(5);
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);

			// The replay finds the line with a `released` reservation and COMPLETES
			// the removal — never a spurious LINE_CHECKED_OUT, never a second return.
			const replay = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k2"));
			expect(replay).toEqual({ ok: true });
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
			expect(await h.onHand("SKU-1")).toBe(5); // returned exactly once
		});
	});
}

runCrashWindow(makeSqliteCartHarness, "sqlite");
describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	runCrashWindow(makePgCartHarness, "pg");
});
