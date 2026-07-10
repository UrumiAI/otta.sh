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
	});
}

runHoldExpiry(makeSqliteCartHarness, "sqlite");
describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	runHoldExpiry(makePgCartHarness, "pg");
});
