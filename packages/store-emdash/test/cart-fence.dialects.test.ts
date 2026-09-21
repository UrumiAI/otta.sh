/**
 * The cart-mutation fences against the document adapter. `@otta-sh/store-postgres`
 * is gone; this is the dialect coverage now, re-pointed at `EmdashCartStore`.
 *
 * The cases are unchanged: a cart-initiated adjust/remove on a hold that is no
 * longer the cart's is `LINE_CHECKED_OUT` with no stock moved, and any mutation on
 * a `checked_out` cart is `CART_CHECKED_OUT`.
 *
 * Two things the SQL version did with raw statements are done differently here,
 * and the difference is the point:
 *
 * - Taking a hold out of cart ownership was `UPDATE reservations SET
 *   state='committed'`. Here it goes through the inventory authority's own
 *   `commit`, so what the fence reads is a hold the real store really retired —
 *   the terminal state in `reservation_index` after the hold was pruned.
 * - Making a cart terminal without an order id was `UPDATE carts SET
 *   state='checked_out'`. That is still a deliberate RAW write, for the same
 *   reason: it builds a state the port itself cannot produce, keeping the state
 *   fence provably independent of the order-id column.
 */
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
import { expect, test } from "vitest";
import { normalizeCartDoc, normalizeInventoryDoc } from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const USD = currency("USD");

describeEachDialect("cart-mutation fences", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);
	const make = (): CartHarness => makeCartHarness(bound.storage);

	/** A cart whose line's hold has left the cart's `held`-only ownership. */
	async function cartWithAdoptedLine(h: CartHarness) {
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		// Adoption is Phase 4; committing the hold is the available way to take it
		// out of the cart's ownership, and it goes through the real authority.
		await h.inventory.commit(add.line.reservationId ?? "");
		return { cartId, lineId: add.line.lineId };
	}

	test("REGRESSION: a hold the cart attached is ADOPTABLE by an order, never lost", async () => {
		// This is the case that catches the deadline stamp going missing. `adopt` /
		// `adoptMany` are scoped `state='held' AND expires_at > :now`, so a hold whose
		// deadline the cart never wrote onto the INVENTORY document is classified
		// `lost` and checkout fails — even though the cart line looks perfectly
		// healthy. Nothing in the cart contract or the fences would notice; only this
		// does. `addLine` is the real production path, so the stamp is exercised
		// exactly as a shopper exercises it.
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";

		// The deadline really is on the hold, not only on the cart line.
		const doc = await h.inventoryDocs.get("SKU-1");
		if (doc === null) throw new Error("missing inventory document");
		expect(normalizeInventoryDoc(doc).holds[idempotencyKey("k1")]?.expiresAt).toBe(
			add.line.expiresAt,
		);

		const now = h.clock.now().toISOString();
		const adopted = await h.inventory.adoptMany({
			reservationIds: [reservationId],
			orderId: "order-1",
			holdExpiresAt: new Date(h.clock.now().getTime() + 30 * 60 * 1000).toISOString(),
			now,
		});
		expect(adopted.lost).toEqual([]);
		expect(adopted.adopted).toEqual([reservationId]);
		// And the cart now reads the hold as adopted, so the fence below applies.
		expect((await getCart(h.deps, cartId))?.lines[0]?.reservationState).toBe("adopted");
	});

	test("adjustLine on an ADOPTED hold does not throw — the port has no such failure", async () => {
		// At the PORT level, not through the use-case, because that is where the
		// regression would live. `updateLine` calls `adjustLine` outside any catch and
		// `HoldExpiredError` is documented as `upsertLine`'s failure, so a checkout or
		// the sweep taking the hold between `inventoryStore.adjust` returning and the
		// deadline re-stamp must NOT surface as a throw. The line already references
		// this hold, so there is no attach to guard: the refused stamp is ignored.
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";

		const now = h.clock.now().toISOString();
		const adopted = await h.inventory.adoptMany({
			reservationIds: [reservationId],
			orderId: "order-1",
			holdExpiresAt: new Date(h.clock.now().getTime() + 30 * 60 * 1000).toISOString(),
			now,
		});
		expect(adopted.adopted).toEqual([reservationId]);

		const line = await h.deps.cartStore.adjustLine({
			cartId,
			lineId: add.line.lineId,
			newQty: 4,
			expiresAt: new Date(h.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
			key: idempotencyKey("k2"),
		});
		// It resolves, and it moved no stock — the cart store never writes inventory.
		expect(line.lineId).toBe(add.line.lineId);
		expect(await h.onHand("SKU-1")).toBe(3);
		// The adopted hold keeps the ORDER's deadline: the refused stamp touched nothing.
		const doc = await h.inventoryDocs.get("SKU-1");
		if (doc === null) throw new Error("missing inventory document");
		const hold = normalizeInventoryDoc(doc).holds[idempotencyKey("k1")];
		expect(hold?.state).toBe("adopted");
		expect(hold?.expiresAt).toBe(new Date(h.clock.now().getTime() + 30 * 60 * 1000).toISOString());
	});

	test("adjust on an adopted hold is LINE_CHECKED_OUT and moves no stock", async () => {
		const h = make();
		const { cartId, lineId } = await cartWithAdoptedLine(h);
		expect(await h.onHand("SKU-1")).toBe(3);
		const res = await updateLine(h.deps, cartId, lineId, 4, idempotencyKey("k2"));
		expect(res).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
		expect(await h.onHand("SKU-1")).toBe(3);
		expect((await getCart(h.deps, cartId))?.lines[0]?.qty).toBe(2);
	});

	test("remove on an adopted hold is LINE_CHECKED_OUT and releases nothing", async () => {
		const h = make();
		const { cartId, lineId } = await cartWithAdoptedLine(h);
		const res = await removeLine(h.deps, cartId, lineId, idempotencyKey("k2"));
		expect(res).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
		expect(await h.onHand("SKU-1")).toBe(3);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
	});

	test("any mutation on a checked_out cart is CART_CHECKED_OUT", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");

		// The raw half-written flip, on purpose: `state` moves and `orderId` does
		// not, which `checkout` can never produce. The state fence must hold anyway.
		const current = await h.carts.getVersioned(cartId);
		if (current === null) throw new Error("missing cart document");
		await h.carts.compareAndSet(cartId, current.revision, {
			...normalizeCartDoc(current.value),
			state: "checked_out",
		});

		const up = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k2"));
		const rm = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k3"));
		expect(up).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect(rm).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect(await h.onHand("SKU-1")).toBe(3); // nothing moved
		expect((await h.carts.get(cartId))?.orderId).toBeNull();
	});
});
