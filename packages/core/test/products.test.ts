import { afterEach, describe, expect, it } from "vitest";
import { onAfterDelete, onAfterPublish, onAfterSave, onAfterUnpublish } from "../src/products.js";
import { applyStock } from "../src/stock.js";
import { makeShop, type Shop } from "./fixtures.js";

const open: Shop[] = [];
/** An empty installed shop on real storage; `settings` override the defaults. */
const shop = async (settings: Record<string, unknown> = {}) => {
	const s = await makeShop([]);
	s.kv.seedSettings(settings);
	open.push(s);
	return s;
};
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
});

const content = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	id: "p1",
	status: "published",
	updatedAt: "t1",
	data: { title: "Mug", price: 9.5, ...data },
	...extra,
});
const prod = async (f: Shop): Promise<any> => (await f.raw("products").get("p1")) ?? undefined;
const stk = async (f: Shop): Promise<any> => (await f.raw("stock").get("p1")) ?? undefined;

// EmDash sends ISO updatedAt, bumped by every save, publish and unpublish.
const at = (n: number) => ({ updatedAt: `2026-11-21T10:00:0${n}.000Z` });

describe("product sync", () => {
	it("saves live content with minor-unit price, call count 3", async () => {
		const f = await shop({ currency: "eur" });
		await onAfterSave(
			{ content: content({ sku: "M" }), collection: "products", isNew: true },
			f.ctx,
		);
		expect(await prod(f)).toMatchObject({
			v: 1,
			title: "Mug",
			price: 950,
			currency: "EUR",
			active: true,
			trackStock: false,
			sku: "M",
		});
		expect(f.calls().total).toBe(3);
	});
	it("ignores a pending draft over live content", async () => {
		const f = await shop();
		await onAfterSave({ content: content({}), collection: "products" }, f.ctx);
		await onAfterSave(
			{
				content: content({ title: "New", price: 1 }, { draftRevisionId: "d", liveRevisionId: "l" }),
				collection: "products",
			},
			f.ctx,
		);
		expect((await prod(f)).title).toBe("Mug");
	});
	it("publish activates; unpublish and delete deactivate", async () => {
		const f = await shop();
		await onAfterSave(
			{ content: content({}, { status: "draft", ...at(1) }), collection: "products" },
			f.ctx,
		);
		expect((await prod(f)).active).toBe(false);
		await onAfterPublish({ content: content({}, at(2)), collection: "products" }, f.ctx);
		expect((await prod(f)).active).toBe(true);
		await onAfterUnpublish({ content: content({}, at(3)), collection: "products" }, f.ctx);
		expect((await prod(f)).active).toBe(false);
		await onAfterPublish({ content: content({}, at(4)), collection: "products" }, f.ctx);
		await onAfterDelete({ id: "p1", collection: "products", permanent: true }, f.ctx);
		expect((await prod(f)).active).toBe(false);
	});
	it("applies stock only on change; re-save keeps sold stock", async () => {
		const f = await shop();
		const save = (stock: number, u: string) =>
			onAfterSave({ content: content({ stock }, { updatedAt: u }), collection: "products" }, f.ctx);
		await save(5, "t1");
		expect((await stk(f)).onHand).toBe(5);
		expect(await prod(f)).toMatchObject({ trackStock: true, appliedContentStock: 5 });
		// A sale: reserve, then commit (a sale always converts its hold).
		await applyStock(f.ctx, "p1", { kind: "reserve", orderId: "o1", qty: 2 });
		await applyStock(f.ctx, "p1", { kind: "commit", orderId: "o1", qty: 2 });
		const before = f.calls().total;
		await save(5, "t2");
		expect((await stk(f)).onHand).toBe(3);
		// settings, product get, stock read + CAS (records the newer content time), product put
		expect(f.calls().total - before).toBe(5);
		await save(8, "t3");
		expect((await stk(f)).onHand).toBe(8);
	});
	it("stock from a non-live save is not applied", async () => {
		const f = await shop();
		await onAfterSave(
			{ content: content({ stock: 4 }, { status: "draft" }), collection: "products" },
			f.ctx,
		);
		expect(await stk(f)).toBeUndefined();
		expect((await prod(f)).appliedContentStock).toBeNull();
	});
	it("invalid price => inactive", async () => {
		const f = await shop();
		await onAfterSave({ content: content({ price: "abc" }), collection: "products" }, f.ctx);
		expect(await prod(f)).toMatchObject({ price: null, active: false });
	});
	it("wrong collection ignored", async () => {
		const f = await shop();
		await onAfterSave({ content: content({}), collection: "posts" }, f.ctx);
		expect(await prod(f)).toBeUndefined();
		const g = await shop({ productsCollection: "items" });
		await onAfterSave({ content: content({}), collection: "items" }, g.ctx);
		expect(await prod(g)).toBeDefined();
	});
	it("never throws", async () => {
		await expect(
			onAfterSave({ content: content({}), collection: "products" }, {} as any),
		).resolves.toBeUndefined();
	});
});
