import {
	addLine,
	createCart,
	currency,
	getCart,
	idempotencyKey,
	removeLine,
	sku,
	updateLine,
} from "@otta-sh/domain";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CartDialectHarness,
	makePgCartHarness,
	makeSqliteCartHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// C5 (required, §4/§7) — cart-mutation fences against real stores: a cart-initiated
// release/adjust on a non-`held` (adopted) hold matches 0 rows → LINE_CHECKED_OUT
// with no stock moved; a mutation on a `checked_out` cart is CART_CHECKED_OUT.
afterEach(teardownDialects);

const USD = currency("USD");

function runFence(make: () => Promise<CartDialectHarness>, dialect: string): void {
	describe(`cart-mutation fences [${dialect}]`, () => {
		// Adoption is Phase 4; here we flip the hold to `committed` to take it out
		// of the cart's `held`-only ownership.
		async function cartWithAdoptedLine(h: CartDialectHarness) {
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("add must succeed");
			await h.db
				.updateTable("reservations")
				.set({ state: "committed" })
				.where("id", "=", add.line.reservationId ?? "")
				.execute();
			return { cartId, lineId: add.line.lineId };
		}

		test("adjust on an adopted hold is LINE_CHECKED_OUT and moves no stock", async () => {
			const h = await make();
			const { cartId, lineId } = await cartWithAdoptedLine(h);
			expect(await h.onHand("SKU-1")).toBe(3);
			const res = await updateLine(h.deps, cartId, lineId, 4, idempotencyKey("k2"));
			expect(res).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
			expect(await h.onHand("SKU-1")).toBe(3);
			expect((await getCart(h.deps, cartId))?.lines[0]?.qty).toBe(2);
		});

		test("remove on an adopted hold is LINE_CHECKED_OUT and releases nothing", async () => {
			const h = await make();
			const { cartId, lineId } = await cartWithAdoptedLine(h);
			const res = await removeLine(h.deps, cartId, lineId, idempotencyKey("k2"));
			expect(res).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
			expect(await h.onHand("SKU-1")).toBe(3);
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
		});

		test("any mutation on a checked_out cart is CART_CHECKED_OUT", async () => {
			const h = await make();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("add must succeed");
			await h.db
				.updateTable("carts")
				.set({ state: "checked_out" })
				.where("id", "=", cartId)
				.execute();

			const up = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k2"));
			const rm = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k3"));
			expect(up).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
			expect(rm).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
			expect(await h.onHand("SKU-1")).toBe(3); // nothing moved
		});
	});
}

runFence(makeSqliteCartHarness, "sqlite");
describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	runFence(makePgCartHarness, "pg");
});
