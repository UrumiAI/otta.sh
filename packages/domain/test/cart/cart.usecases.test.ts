import { addLine, createCart, removeLine, updateLine } from "@otta-sh/domain";
import { currency, idempotencyKey, sku } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { makeFakeCartHarness } from "./fake-harness.js";

const USD = currency("USD");

// B1 extras beyond the shared contract: the not-found guards the HTTP layer
// reflects and the price-free line shape.
describe("cart use-cases (fake)", () => {
	test("a mutation on an unknown cart is CART_NOT_FOUND", async () => {
		const h = makeFakeCartHarness();
		const res = await addLine(h.deps, "no-such-cart", sku("SKU-1"), null, 1, idempotencyKey("k1"));
		expect(res).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
	});

	test("updating an unknown line is LINE_NOT_FOUND", async () => {
		const h = makeFakeCartHarness();
		const cartId = await createCart(h.deps, USD);
		const res = await updateLine(h.deps, cartId, "no-such-line", 2, idempotencyKey("k1"));
		expect(res).toEqual({ ok: false, reason: "LINE_NOT_FOUND" });
	});

	test("removing an unknown line is an idempotent no-op", async () => {
		const h = makeFakeCartHarness();
		const cartId = await createCart(h.deps, USD);
		const res = await removeLine(h.deps, cartId, "no-such-line", idempotencyKey("k1"));
		expect(res).toEqual({ ok: true });
	});

	test("a line snapshots no price and carries its live reservation state", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const res = await addLine(h.deps, cartId, sku("SKU-1"), "prod-1", 3, idempotencyKey("k1"));
		if (!res.ok) throw new Error("add must succeed");
		expect(res.line).toMatchObject({ sku: "SKU-1", productId: "prod-1", qty: 3 });
		expect(res.line.reservationState).toBe("held");
		expect(res.line).not.toHaveProperty("price");
		expect(res.line).not.toHaveProperty("unitPriceCents");
	});
});
