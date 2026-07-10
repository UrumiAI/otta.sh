import {
	addLine,
	createCart,
	currency,
	getCart,
	idempotencyKey,
	removeLine,
	sku,
	updateLine,
} from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { makeFakeCartHarness } from "./fake-harness.js";

const USD = currency("USD");

// B6 (required, §4 "Cart mutations are fenced") — the guards Phase 4 relies on
// to fence an adopted hold from the live cart.
describe("cart-mutation fences (fake)", () => {
	// A reservation the cart no longer owns (adopted/committed by a Phase-4 order)
	// is simulated by committing the hold, so its state is no longer `held`.
	async function cartWithNonHeldLine() {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		await h.inventory.commit(add.line.reservationId ?? "");
		return { h, cartId, lineId: add.line.lineId };
	}

	test("adjustLine on a non-held reservation is LINE_CHECKED_OUT and moves no stock", async () => {
		const { h, cartId, lineId } = await cartWithNonHeldLine();
		expect(await h.onHand("SKU-1")).toBe(3);
		const res = await updateLine(h.deps, cartId, lineId, 4, idempotencyKey("k2"));
		expect(res).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
		expect(await h.onHand("SKU-1")).toBe(3); // never touched inventory
		expect((await getCart(h.deps, cartId))?.lines[0]?.qty).toBe(2);
	});

	test("removeLine on a non-held reservation is LINE_CHECKED_OUT and releases nothing", async () => {
		const { h, cartId, lineId } = await cartWithNonHeldLine();
		const res = await removeLine(h.deps, cartId, lineId, idempotencyKey("k2"));
		expect(res).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
		expect(await h.onHand("SKU-1")).toBe(3); // adopted hold's stock stays committed
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
	});

	test("any mutation on a checked_out cart is CART_CHECKED_OUT before touching a reservation", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		await h.cartStore.checkout(cartId);

		const addAfter = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("k2"));
		const upAfter = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k3"));
		const rmAfter = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k4"));
		expect(addAfter).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect(upAfter).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect(rmAfter).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect(await h.onHand("SKU-1")).toBe(3); // nothing moved
	});
});
