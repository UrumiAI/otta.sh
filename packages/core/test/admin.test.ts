import { afterEach, describe, expect, it } from "vitest";
import {
	MCP_TOOLS,
	availability,
	ordersFulfil,
	ordersGet,
	ordersList,
	stockSet,
} from "../src/admin.js";
import { makeShop, type ProductSeed, type Shop } from "./fixtures.js";

const open: Shop[] = [];
const shop = async (products: ProductSeed[] = []) => {
	const s = await makeShop(products);
	open.push(s);
	return s;
};
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
});

const order = (status: string, extra: Record<string, unknown> = {}) => ({
	v: 1,
	orderKey: "k".repeat(32),
	status,
	currency: "USD",
	total: 100,
	createdAt: "2026-01-01",
	paidAt: null,
	attention: null,
	email: "a@b.c",
	...extra,
});

const P = (id: string, trackStock: boolean) => ({
	productId: id,
	title: id,
	price: 100,
	currency: "USD",
	active: true,
	trackStock,
});

describe("admin", () => {
	it("lists orders, filters, hides nothing secret", async () => {
		const s = await shop();
		await s.raw("orders").put("a", order("paid", { createdAt: "1" }));
		await s.raw("orders").put("b", order("pending", { createdAt: "2" }));
		const r: any = await ordersList({ status: "paid" }, s.ctx);
		expect(r.orders.map((o: any) => o.id)).toEqual(["a"]);
		expect(r.orders[0].orderKey).toBeUndefined();
		expect(((await ordersList({ limit: 99 }, s.ctx)) as any).code).toBe("BAD_INPUT");
	});
	it("gets order without orderKey", async () => {
		const s = await shop();
		await s.raw("orders").put("a", order("paid"));
		const r: any = await ordersGet({ id: "a" }, s.ctx);
		expect(r.order.id).toBe("a");
		expect(r.order.orderKey).toBeUndefined();
		expect(((await ordersGet({ id: "zz" }, s.ctx)) as any).code).toBe("ORDER_NOT_FOUND");
	});
	it("fulfils only paid, idempotent", async () => {
		const s = await shop();
		await s.raw("orders").put("p", order("pending"));
		await s.raw("orders").put("a", order("paid"));
		expect(((await ordersFulfil({ id: "p" }, s.ctx)) as any).code).toBe("ORDER_NOT_PAYABLE");
		expect(((await ordersFulfil({ id: "x" }, s.ctx)) as any).code).toBe("ORDER_NOT_FOUND");
		const r: any = await ordersFulfil({ id: "a", tracking: "T1" }, s.ctx);
		expect(r.order).toMatchObject({ status: "fulfilled", tracking: "T1" });
		expect(r.order.fulfilledAt).toBeTruthy();
		const again: any = await ordersFulfil({ id: "a" }, s.ctx);
		expect(again.ok).toBe(true);
		expect(((await s.raw("orders").get("a")) as any).tracking).toBe("T1");
	});
	it("lost race re-reads instead of trusting applied:false", async () => {
		const s = await shop();
		await s.raw("orders").put("a", order("paid"));
		// a concurrent writer fulfils between our read and CAS
		s.raceOnce("orders", "a", order("fulfilled", { tracking: "other" }));
		s.resetCalls();
		const r: any = await ordersFulfil({ id: "a", tracking: "mine" }, s.ctx);
		expect(r.ok).toBe(true);
		// The reply comes from the RE-READ (the rival's fulfilment), not from our lost write.
		expect(r.order.tracking).toBe("other");
		expect(((await s.raw("orders").get("a")) as any).tracking).toBe("other");
		expect(s.calls().total).toBe(3); // read, lost CAS, re-read
		expect(s.casLost()["orders"]).toBe(1);
		const g = await shop();
		await g.raw("orders").put("a", order("paid"));
		g.raceOnce("orders", "a", order("canceled"));
		expect(((await ordersFulfil({ id: "a" }, g.ctx)) as any).code).toBe("ORDER_NOT_PAYABLE");
	});
	it("stockSet", async () => {
		const s = await shop();
		s.resetCalls();
		const r: any = await stockSet({ productId: "p1", onHand: 7, expectedOnHand: 0 }, s.ctx);
		expect(r).toEqual({ ok: true, stock: { productId: "p1", onHand: 7, held: 0, available: 7 } });
		expect(s.calls().total).toBe(2);
		expect(
			((await stockSet({ productId: "p1", onHand: -1, expectedOnHand: 7 }, s.ctx)) as any).ok,
		).toBe(false);
		expect(
			((await stockSet({ productId: "p1", onHand: 1_000_001, expectedOnHand: 7 }, s.ctx)) as any)
				.ok,
		).toBe(false);
	});
	it("availability caps ids, null for untracked, subtracts holds", async () => {
		const s = await shop();
		for (let i = 0; i < 15; i++) await s.raw("products").put("p" + i, P("p" + i, i === 1));
		await s.raw("stock").put("p1", { onHand: 5, holds: { o: 2 } });
		const ids = Array.from({ length: 15 }, (_, i) => "p" + i).join(",");
		s.resetCalls();
		const r: any = await availability({ ids }, s.ctx);
		expect(Object.keys(r.products)).toHaveLength(8);
		expect(r.products.p0.available).toBeNull();
		expect(r.products.p1.available).toBe(3);
		expect(s.calls().total).toBe(2);
	});
	it("exposes seven MCP tools", () => {
		expect(MCP_TOOLS.map((t) => t.name)).toEqual([
			"list_orders",
			"get_order",
			"fulfil_order",
			"resolve_order",
			"set_stock",
			"resync_products",
			"export_data",
		]);
	});
});
