import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	idempotencyKey,
	sku,
	updateLine,
} from "@urumi/domain";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CartDialectHarness,
	makePgCartHarness,
	makeSqliteCartHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// C3 — hold expiry against real DBs via an injected Clock: released, stock
// returns, no double-release under a simulated lazy+sweep race.
afterEach(teardownDialects);

const USD = currency("USD");
const PAST_TTL_MS = 16 * 60 * 1000;

function runHoldExpiry(make: () => Promise<CartDialectHarness>, dialect: string): void {
	describe(`hold expiry [${dialect}]`, () => {
		test("an expired hold is released, its stock returns, and the reservation is 'released'", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("add must succeed");
			const reservationId = add.line.reservationId ?? "";
			expect(await h.onHand("SKU-1")).toBe(3);

			h.advance(PAST_TTL_MS);
			expect(await expireHolds(h.deps)).toBe(1);
			expect(await h.onHand("SKU-1")).toBe(5);

			const res = await h.db
				.selectFrom("reservations")
				.select("state")
				.where("id", "=", reservationId)
				.executeTakeFirst();
			expect(res?.state).toBe("released");
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
		});

		test("a lazy read racing the sweep returns stock exactly once", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("add must succeed");

			h.advance(PAST_TTL_MS);
			const lazy = await getCart(h.deps, cartId); // lazy-on-read reclaims
			const swept = await expireHolds(h.deps); // sweep sees nothing left
			expect(lazy?.lines).toHaveLength(0);
			expect(swept).toBe(0);
			expect(await h.onHand("SKU-1")).toBe(5); // returned once, not 7
		});

		test("expiry flip re-checks expires_at: a hold TTL-reset between listing and release is not reaped", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("add must succeed");
			const reservationId = add.line.reservationId ?? "";

			// Script the sweep's list→release window by hand: list at a `now` where
			// the hold looks expired…
			h.advance(PAST_TTL_MS);
			const staleNow = h.clock.now().toISOString();
			const listed = await h.deps.cartStore.listExpired(staleNow, staleNow);
			expect(listed).toEqual([{ reservationId }]);

			// …then an active shopper's mutation resets the hold before the release
			// lands. The guarded flip re-checks the deadline in the same conditional
			// statement: 0 rows, NOT reaped, no stock moved.
			const up = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k2"));
			if (!up.ok) throw new Error("adjust must succeed");
			const won = await h.deps.cartStore.expireHold(reservationId, staleNow, staleNow);
			expect(won).toBe(false);
			expect(await h.onHand("SKU-1")).toBe(2); // 5 − 3: the hold is intact
			const res = await h.db
				.selectFrom("reservations")
				.select("state")
				.where("id", "=", reservationId)
				.executeTakeFirst();
			expect(res?.state).toBe("held");
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
		});

		test("a raw non-cart hold older than the TTL is not reaped by the cart sweep", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			// A direct Phase-0 reserve: held, never stamped with expires_at, no
			// cart_mutations claim — an admin/API hold awaiting explicit
			// commit/release. The sweep's NULL-expires fallback is scoped to
			// cart-originated keys and must leave it alone forever.
			const raw = await h.deps.inventoryStore.reserve("SKU-1", 2, idempotencyKey("raw-1"));
			if (!raw.ok) throw new Error("raw reserve must succeed");
			expect(await h.onHand("SKU-1")).toBe(3);

			h.advance(PAST_TTL_MS * 10);
			expect(await expireHolds(h.deps)).toBe(0);
			expect(await h.onHand("SKU-1")).toBe(3); // still held
			const res = await h.db
				.selectFrom("reservations")
				.select("state")
				.where("id", "=", raw.reservationId)
				.executeTakeFirst();
			expect(res?.state).toBe("held");
		});
	});
}

runHoldExpiry(makeSqliteCartHarness, "sqlite");
describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	runHoldExpiry(makePgCartHarness, "pg");
});
