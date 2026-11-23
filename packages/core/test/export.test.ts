/** Data export: paging, secrets stripped from orders, one bridge call per page. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { exportData } from "../src/export.js";
import { SCHEMA_VERSION } from "../src/model.js";
import { deliver, linesFor, makeShop, nProducts, orderKey, type Shop } from "./fixtures.js";

const SALT = { _ipSalt: "a".repeat(64) };

async function page(s: Shop, input: Record<string, unknown>) {
	s.resetCalls();
	const logs = s.logs.length;
	const r = (await exportData(input, s.ctx)) as any;
	expect(s.calls().total + (s.logs.length - logs)).toBe(1);
	return r;
}

async function all(s: Shop, kind: string, limit?: number) {
	const items: Array<{ id: string; data: any }> = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const r = await page(s, { kind, ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) });
		expect(r.ok).toBe(true);
		expect(r.schemaVersion).toBe(SCHEMA_VERSION);
		expect(r.kind).toBe(kind);
		items.push(...r.items);
		cursor = r.nextCursor ?? undefined;
		pages++;
	} while (cursor && pages < 100);
	return { items, pages };
}

describe("exportData", () => {
	it("pages through 120 products with a cursor, each exactly once, one call per page", async () => {
		const s = await makeShop(nProducts(120, 3));
		const { items, pages } = await all(s, "products", 25);
		expect(pages).toBe(5);
		expect(items).toHaveLength(120);
		expect(new Set(items.map((i) => i.id)).size).toBe(120);
		for (let n = 1; n <= 120; n++) expect(items.some((i) => i.id === `p${n}`)).toBe(true);
		expect(items[0]!.data).toMatchObject({
			v: SCHEMA_VERSION,
			productId: items[0]!.id,
			active: true,
		});
		// The last page has no cursor.
		const last = await page(s, {
			kind: "products",
			limit: 100,
			cursor: (await page(s, { kind: "products", limit: 100 })).nextCursor,
		});
		expect(last.items).toHaveLength(20);
		expect(last.nextCursor).toBeNull();
	});

	it("default limit is 50 and limit is clamped to 1..100", async () => {
		const s = await makeShop(nProducts(120, 3));
		expect((await page(s, { kind: "products" })).items).toHaveLength(50);
		expect((await page(s, { kind: "products", limit: 1000 })).items).toHaveLength(100);
		expect((await page(s, { kind: "products", limit: 0 })).items).toHaveLength(1);
		expect((await page(s, { kind: "products", limit: -5 })).items).toHaveLength(1);
	});

	it("exports stock documents", async () => {
		const s = await makeShop(nProducts(3, 7));
		const { items } = await all(s, "stock");
		expect(items.map((i) => i.id).toSorted()).toEqual(["p1", "p2", "p3"]);
		expect(items[0]!.data).toMatchObject({ v: SCHEMA_VERSION, onHand: 7 });
		expect(items[0]!.data.holds).toEqual({});
	});

	it("exports orders without orderKey and ipTag, everything else as stored", async () => {
		const s = await makeShop(nProducts(2, 50));
		s.kv.seedSettings(SALT);
		for (const n of [1, 2])
			await placeOrder({ key: orderKey(n), lines: linesFor(1), email: "a@b.co" }, s.ctx, {
				ip: "203.0.113.9",
			});
		// Pay order 1 so the export covers a settled order too.
		const sess = s.stripe.complete(s.stripe.forOrder(orderKey(1))!.id);
		expect(
			(await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id))).status,
		).toBe(200);

		const stored1 = await s.order(orderKey(1));
		const stored2 = await s.order(orderKey(2));
		expect(stored2.ipTag).toMatch(/^[0-9a-f]{16}$/); // there is something to strip
		expect(stored2.orderKey).toBeTruthy();

		const { items } = await all(s, "orders");
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.data).not.toHaveProperty("orderKey");
			expect(item.data).not.toHaveProperty("ipTag");
		}
		const text = JSON.stringify(items);
		expect(text).not.toContain(stored1.orderKey);
		expect(text).not.toContain(stored2.orderKey);
		expect(text).not.toContain(stored2.ipTag!);

		for (const [id, stored] of [
			[orderKey(1), stored1],
			[orderKey(2), stored2],
		] as const) {
			const { orderKey: k, ipTag: _t, ...expected } = stored;
			// The stored successUrl embeds the key; the export swaps it for the placeholder.
			expected.successUrl = expected.successUrl.split(k).join("{ORDER_KEY}");
			expect(expected.successUrl).toContain("key={ORDER_KEY}");
			expect(items.find((i) => i.id === id)!.data).toEqual(expected);
		}
		expect(items.find((i) => i.id === orderKey(1))!.data.status).toBe("paid");
	});

	it("refuses bad input", async () => {
		const s = await makeShop(nProducts(1));
		for (const input of [
			undefined,
			{},
			{ kind: "settings" },
			{ kind: 5 },
			{ kind: "orders", limit: "ten" },
			{ kind: "orders", limit: 1.5 },
			{ kind: "orders", cursor: 42 },
			{ kind: "orders", cursor: "" },
		]) {
			s.resetCalls();
			const r = (await exportData(input, s.ctx)) as any;
			expect(r).toMatchObject({ ok: false, code: "BAD_INPUT" });
			expect(typeof r.message).toBe("string");
			expect(s.calls().total).toBe(0);
		}
	});

	it("an empty shop exports an empty page", async () => {
		const s = await makeShop([]);
		expect(await page(s, { kind: "orders" })).toMatchObject({
			ok: true,
			items: [],
			nextCursor: null,
		});
	});
});
