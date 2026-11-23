/** Resync products: repairs lost hooks and orphans through the hooks' own step. */
import { describe, expect, it } from "vitest";
import type { ProductDoc, StockDoc } from "../src/model.js";
import { onAfterDelete, onAfterPublish, onAfterSave, onAfterUnpublish } from "../src/products.js";
import { resyncProducts, BRIDGE_LIMIT } from "../src/resync.js";
import { applyStock } from "../src/stock.js";
import type { FakeContentItem } from "./harness.js";
import { makeShop, nextUpdatedAt, type Shop } from "./fixtures.js";

const COLL = "products";

/** A content item as the host stores it; `hook` = whether its hook reached Core (false = lost). */
async function put(
	s: Shop,
	id: string,
	o: {
		status?: string;
		data?: Record<string, unknown>;
		at?: string;
		createdAt?: string;
		draft?: string | null;
	},
	hook: "publish" | "save" | "unpublish" | false,
) {
	const prev = (await s.ctx.content!.get(COLL, id).catch(() => null)) as FakeContentItem | null;
	const item: FakeContentItem = {
		id,
		status: o.status ?? "published",
		data: o.data ?? prev?.data ?? { title: `Product ${id}`, price: 10 },
		createdAt: o.createdAt ?? prev?.createdAt ?? nextUpdatedAt(),
		updatedAt: o.at ?? nextUpdatedAt(),
		liveRevisionId: "live",
		draftRevisionId: o.draft ?? null,
	};
	s.content.put(COLL, item);
	const ev = { content: item as unknown as Record<string, unknown>, collection: COLL };
	if (hook === "publish") await onAfterPublish(ev, s.ctx);
	else if (hook === "save") await onAfterSave(ev, s.ctx);
	else if (hook === "unpublish") await onAfterUnpublish(ev, s.ctx);
	return item;
}

const prod = async (s: Shop, id: string) => (await s.raw("products").get(id)) as ProductDoc | null;

/** Run one call, measuring bridge calls (logs count in production, so add them). */
async function call(s: Shop, input: Record<string, unknown>) {
	s.resetCalls();
	const logsBefore = s.logs.length;
	const r = (await resyncProducts(input, s.ctx)) as any;
	const used = s.calls().total + (s.logs.length - logsBefore);
	expect(used).toBeLessThanOrEqual(BRIDGE_LIMIT);
	return { r, used };
}

/** The whole resync, as an MCP client would drive it. */
async function runAll(s: Shop) {
	let input: Record<string, unknown> = {};
	const out = { synced: 0, deactivated: 0, calls: 0, maxUsed: 0 };
	for (let n = 0; n < 200; n++) {
		const { r, used } = await call(s, input);
		expect(r.ok).toBe(true);
		out.synced += r.synced;
		out.deactivated += r.deactivated;
		out.calls++;
		out.maxUsed = Math.max(out.maxUsed, used);
		if (r.nextPhase === null) return out;
		input = { phase: r.nextPhase, ...(r.nextCursor ? { cursor: r.nextCursor } : {}) };
	}
	throw new Error("resync did not finish");
}

describe("resync products", () => {
	it("repairs a lost unpublish hook", async () => {
		const s = await makeShop([]);
		await put(s, "p1", {}, "publish");
		expect((await prod(s, "p1"))!.active).toBe(true);
		const off = await put(s, "p1", { status: "draft" }, false);
		const r = await runAll(s);
		expect(r).toMatchObject({ synced: 1, deactivated: 1 });
		expect(await prod(s, "p1")).toMatchObject({ active: false, contentAt: off.updatedAt });
	});

	it("repairs a lost price change (and its stock), not over sales", async () => {
		const s = await makeShop([]);
		await put(s, "p1", { data: { title: "Mug", price: 10, stock: 5 } }, "publish");
		await applyStock(s.ctx, "p1", { kind: "reserve", orderId: "o1", qty: 2 });
		await applyStock(s.ctx, "p1", { kind: "commit", orderId: "o1", qty: 2 });
		await put(s, "p1", { data: { title: "Mug", price: 12, stock: 5 } }, false);
		await runAll(s);
		expect(await prod(s, "p1")).toMatchObject({ price: 1200, active: true });
		// Same stock value as already applied: the sale stands.
		expect(((await s.raw("stock").get("p1")) as StockDoc).onHand).toBe(3);
	});

	it("never rolls back a newer hook-applied state", async () => {
		const s = await makeShop([]);
		const old = await put(s, "p1", { data: { title: "Mug", price: 10 } }, "publish");
		// A newer price reached Core by its hook while resync read the older item.
		await put(s, "p1", { data: { title: "Mug", price: 15 } }, "publish");
		s.content.put(COLL, old);
		await runAll(s);
		expect((await prod(s, "p1"))!.price).toBe(1500);
		// Nor resurrects a product unpublished later than the content it read.
		await put(s, "p1", { status: "draft" }, "unpublish");
		s.content.put(COLL, old);
		await runAll(s);
		expect((await prod(s, "p1"))!.active).toBe(false);
	});

	it("never resurrects a deleted product from a stale read", async () => {
		const s = await makeShop([]);
		await put(s, "p1", {}, "publish");
		await onAfterDelete({ id: "p1", collection: COLL, permanent: true }, s.ctx);
		// The read still shows the older published item (it raced the delete): it loses.
		await runAll(s);
		expect((await prod(s, "p1"))!.active).toBe(false);
	});

	it("does not apply a pending draft over a live item (applies the live data)", async () => {
		const s = await makeShop([]);
		await put(s, "p1", { data: { title: "Mug", price: 10 } }, "publish");
		// The publish of 12 was lost; then a draft edit to 99 (updatedAt unmoved, columns stay live).
		const live = await put(s, "p1", { data: { title: "Mug", price: 12 } }, false);
		await onAfterSave(
			{
				content: { ...live, data: { title: "Draft", price: 99 }, draftRevisionId: "d2" } as never,
				collection: COLL,
			},
			s.ctx,
		);
		s.content.put(COLL, { ...live, draftRevisionId: "d2" });
		await runAll(s);
		expect(await prod(s, "p1")).toMatchObject({
			price: 1200,
			title: "Mug",
			active: true,
			contentAt: live.updatedAt,
		});
		// And with nothing lost, the pending draft changes nothing.
		const { r } = await call(s, {});
		expect(r).toMatchObject({ synced: 0, deactivated: 0 });
	});

	it("deactivates an orphan whose content was deleted, or whose collection changed", async () => {
		const s = await makeShop([]);
		await put(s, "p1", {}, "publish");
		await put(s, "p2", {}, "publish");
		s.content.remove(COLL, "p1"); // the afterDelete hook was lost
		const r = await runAll(s);
		expect(r).toMatchObject({ synced: 1, deactivated: 1 });
		expect((await prod(s, "p1"))!.active).toBe(false);
		expect((await prod(s, "p2"))!.active).toBe(true);
		// Setting now names another (empty) collection: every product is an orphan.
		s.kv.seedSettings({ productsCollection: "items" });
		expect(await runAll(s)).toMatchObject({ deactivated: 1 });
		expect((await prod(s, "p2"))!.active).toBe(false);
	});

	it("an unpublished orphan is taken off at its own time", async () => {
		const s = await makeShop([]);
		await put(s, "p1", {}, "publish");
		const off = await put(s, "p1", { status: "draft" }, false);
		const { r } = await call(s, { phase: "orphans" });
		expect(r).toMatchObject({ ok: true, deactivated: 1, nextPhase: null, nextCursor: null });
		expect((await prod(s, "p1"))!.contentAt).toBe(off.updatedAt);
	});

	it("pages with a cursor and resumes correctly, within the bridge budget", async () => {
		const s = await makeShop([]);
		// 45 products, all hooks lost, half tracked: needs many calls and mid-page stops.
		for (let n = 1; n <= 45; n++)
			await put(
				s,
				`p${n}`,
				{ data: { title: `P${n}`, price: n, ...(n % 2 ? { stock: n } : {}) } },
				false,
			);
		const r = await runAll(s);
		expect(r.synced).toBe(45);
		expect(r.calls).toBeGreaterThan(3);
		expect(r.maxUsed).toBeLessThanOrEqual(28);
		for (let n = 1; n <= 45; n++) {
			const p = (await prod(s, `p${n}`))!;
			expect(p).toMatchObject({ active: true, price: n * 100 });
			if (n % 2) expect(((await s.raw("stock").get(`p${n}`)) as StockDoc).onHand).toBe(n);
		}
	});

	it("a cursor resumes mid-page after a budget stop, without skipping", async () => {
		const s = await makeShop([]);
		for (let n = 1; n <= 12; n++)
			await put(s, `p${n}`, { data: { title: `P${n}`, price: 1, stock: 1 } }, false);
		const first = await call(s, {});
		expect(first.r.nextPhase).toBe("content");
		expect(first.r.synced).toBeGreaterThan(0);
		expect(first.r.synced).toBeLessThan(12);
		// p12 (first in the list) was done by the first call; its hook then lands a newer price.
		expect((await prod(s, "p12"))!.price).toBe(100);
		await put(s, "p12", { data: { title: "P12", price: 7, stock: 1 } }, "publish");
		let input: Record<string, unknown> = { phase: "content", cursor: first.r.nextCursor };
		let synced = first.r.synced;
		for (;;) {
			const { r } = await call(s, input);
			synced += r.synced;
			if (r.nextPhase !== "content") break;
			input = { phase: "content", cursor: r.nextCursor };
		}
		// Every item exactly once, none skipped, and the newer hook state kept.
		expect(synced).toBe(12);
		expect((await prod(s, "p12"))!.price).toBe(700);
		for (let n = 1; n <= 12; n++) expect((await prod(s, `p${n}`))!.active).toBe(true);
	});

	it("re-running is a no-op (no writes, 3 calls per content page)", async () => {
		const s = await makeShop([]);
		for (let n = 1; n <= 5; n++)
			await put(
				s,
				`p${n}`,
				{ data: { title: `P${n}`, price: 5, stock: 2 } },
				n % 2 ? "publish" : false,
			);
		await put(s, "p6", { status: "draft" }, "save");
		await runAll(s);
		const before = (await s.raw("products").query({ limit: 100 })).items;
		const again = await runAll(s);
		expect(again).toMatchObject({ synced: 0, deactivated: 0, calls: 2 });
		s.resetCalls();
		await resyncProducts({}, s.ctx);
		expect(s.calls().byMethod).toEqual({
			"kv.list": 1,
			"content.list": 1,
			"storage.products.getMany": 1,
		});
		expect((await s.raw("products").query({ limit: 100 })).items).toEqual(before);
	});

	it("a lost race resumes at the item, never skipping it", async () => {
		const s = await makeShop([]);
		await put(s, "p1", { data: { title: "A", price: 1 } }, false);
		s.raceOnce("products", "p1");
		s.raceOnce("products", "p1");
		const { r } = await call(s, {});
		expect(r).toMatchObject({ ok: true, synced: 0, nextPhase: "content" });
		expect(await prod(s, "p1")).toBeNull();
		await runAll(s);
		expect((await prod(s, "p1"))!.active).toBe(true);
	});

	it("rejects bad input", async () => {
		const s = await makeShop([]);
		expect(await resyncProducts({ phase: "x" }, s.ctx)).toMatchObject({
			ok: false,
			code: "BAD_INPUT",
		});
		expect(await resyncProducts({ cursor: "nope" }, s.ctx)).toMatchObject({
			ok: false,
			code: "BAD_INPUT",
		});
		const { r } = await call(s, {});
		expect(r).toMatchObject({ ok: true, nextPhase: "orphans", nextCursor: null });
	});

	it("a bridge failure answers RESYNC_FAILED with the cursor to retry", async () => {
		const s = await makeShop([]);
		await put(s, "p1", {}, false);
		s.resetCalls();
		s.failAt(2);
		expect(await resyncProducts({}, s.ctx)).toMatchObject({
			ok: false,
			code: "RESYNC_FAILED",
			phase: "content",
			cursor: null,
		});
		await runAll(s);
		expect((await prod(s, "p1"))!.active).toBe(true);
	});
});
