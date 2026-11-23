/** Concurrent product events: lost writes retry and event order is respected. */
import { describe, expect, it } from "vitest";
import type { ProductDoc } from "../src/model.js";
import { onAfterPublish, onAfterSave, onAfterUnpublish } from "../src/products.js";
import { makeShop } from "./fixtures.js";

const ev = (at: string, data: Record<string, unknown>, status = "published") => ({
	content: { id: "p1", status, updatedAt: at, data: { title: "Mug", ...data } },
	collection: "products",
});
const off = (at: string) => ({
	content: { id: "p1", status: "draft", updatedAt: at, data: {} },
	collection: "products",
});
const T = (s: number) => `2026-11-21T10:00:0${s}.000Z`;

describe("a product event that loses its write re-reads and retries", () => {
	it("concurrent publish(t1) + unpublish(t2): the product is off sale", async () => {
		const s = await makeShop([]);
		await onAfterPublish(ev(T(0), { price: 10 }), s.ctx);
		await Promise.all([
			onAfterPublish(ev(T(1), { price: 10 }), s.ctx),
			onAfterUnpublish(off(T(2)), s.ctx),
		]);
		const p = (await s.raw("products").get("p1")) as ProductDoc;
		expect([p.active, p.contentAt]).toEqual([false, T(2)]);
	});
	it("concurrent price saves: the newer price wins", async () => {
		const s = await makeShop([]);
		await onAfterPublish(ev(T(0), { price: 10 }), s.ctx);
		await Promise.all([
			onAfterSave(ev(T(1), { price: 15 }), s.ctx),
			onAfterSave(ev(T(2), { price: 20 }), s.ctx),
		]);
		expect(((await s.raw("products").get("p1")) as ProductDoc).price).toBe(2000);
	});
	it("first-create race: save(draft, t1) + publish(t2) ends published", async () => {
		const s = await makeShop([]);
		await Promise.all([
			onAfterSave(ev(T(1), { price: 10 }, "draft"), s.ctx),
			onAfterPublish(ev(T(2), { price: 10 }), s.ctx),
		]);
		const p = (await s.raw("products").get("p1")) as ProductDoc;
		expect([p.active, p.contentAt]).toEqual([true, T(2)]);
	});
});

describe("an unpublish before the first publish is remembered", () => {
	it("a late older publish does not put it on sale", async () => {
		const s = await makeShop([]);
		await onAfterUnpublish(off(T(2)), s.ctx);
		await onAfterPublish(ev(T(1), { price: 10 }), s.ctx);
		expect(((await s.raw("products").get("p1")) as ProductDoc).active).toBe(false);
	});
});
