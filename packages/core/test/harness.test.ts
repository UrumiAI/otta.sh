import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/settings.js";
import { coll } from "../src/util.js";
import { createTestContext } from "./harness.js";

type T = Awaited<ReturnType<typeof createTestContext>>;
const open: T[] = [];
async function make() {
	const t = await createTestContext();
	open.push(t);
	return t;
}
afterEach(async () => {
	await Promise.all(open.splice(0).map((t) => t.close()));
});

interface Doc {
	status: string;
	n: number;
	productId?: string;
}

describe("storage CAS", () => {
	it("null revision creates only when absent; stale revision is rejected", async () => {
		const { ctx } = await make();
		const c = coll<Doc>(ctx, "orders");
		const first = await c.compareAndSet("a", null, { status: "pending", n: 1 });
		expect(first.applied).toBe(true);
		expect(await c.compareAndSet("a", null, { status: "pending", n: 2 })).toEqual({
			applied: false,
		});
		const v = (await c.getVersioned("a"))!;
		expect(v.value.n).toBe(1);
		const second = await c.compareAndSet("a", v.revision, { status: "paid", n: 3 });
		expect(second.applied).toBe(true);
		// v.revision is now stale
		expect(await c.compareAndSet("a", v.revision, { status: "x", n: 4 })).toEqual({
			applied: false,
		});
		expect((await c.get("a"))!.n).toBe(3);
	});

	it("query supports `in` on an indexed field and rejects non-indexed fields", async () => {
		const { ctx } = await make();
		const c = coll<Doc>(ctx, "orders");
		for (const [id, status] of [
			["1", "pending"],
			["2", "paid"],
			["3", "expired"],
		] as const)
			await c.put(id, { status, n: 0 });
		const r = await c.query({ where: { status: { in: ["pending", "paid"] } } });
		expect(r.items.map((i) => i.id).toSorted()).toEqual(["1", "2"]);
		await expect(c.query({ where: { n: 0 } })).rejects.toThrow(/non-indexed/);
		// declared composite index members are queryable
		expect((await c.query({ where: { expiresAt: { lt: "z" } } })).items).toEqual([]);
	});

	it("updateIf, compareAndDelete and count work", async () => {
		const { ctx } = await make();
		const c = coll<Doc>(ctx, "orders") as unknown as {
			put(id: string, d: Doc): Promise<void>;
			updateIf(id: string, a: unknown): Promise<{ applied: boolean }>;
			compareAndDelete(id: string, r: string): Promise<{ applied: boolean }>;
			getVersioned(id: string): Promise<{ revision: string }>;
			count(w?: unknown): Promise<number>;
		};
		await c.put("a", { status: "pending", n: 5 });
		expect(
			(await c.updateIf("a", { where: { n: { gte: 5 } }, delta: { n: { dec: 2 } } })).applied,
		).toBe(true);
		expect(
			(await c.updateIf("a", { where: { n: { gte: 5 } }, delta: { n: { dec: 2 } } })).applied,
		).toBe(false);
		expect(await c.count({ status: "pending" })).toBe(1);
		expect((await c.compareAndDelete("a", "stale")).applied).toBe(false);
		expect((await c.compareAndDelete("a", (await c.getVersioned("a")).revision)).applied).toBe(
			true,
		);
	});
});

describe("kv settings", () => {
	it("list('settings:') returns prefixed keys and loadSettings reads them in one call", async () => {
		const { ctx, kv, calls, resetCalls } = await make();
		kv.seedSettings({ currency: "eur", flatShipping: 500, stripeSecretKey: "sk_test" });
		await ctx.kv.set("state:x", 1);
		expect((await ctx.kv.list("settings:")).map((e) => e.key).toSorted()).toEqual([
			"settings:currency",
			"settings:flatShipping",
			"settings:stripeSecretKey",
		]);
		resetCalls();
		const s = await loadSettings(ctx);
		expect(s).toMatchObject({ currency: "EUR", flatShipping: 500, stripeSecretKey: "sk_test" });
		expect(calls()).toMatchObject({ total: 1, byMethod: { "kv.list": 1 } });
	});
});

describe("http fake", () => {
	it("routes by method and longest prefix, logs requests, response shape", async () => {
		const { ctx, http } = await make();
		http.on("*", "https://api.stripe.com/", { status: 500 });
		http.on("POST", "https://api.stripe.com/v1/checkout/sessions", { json: { id: "cs_1" } });
		const res = await ctx.http!.fetch("https://api.stripe.com/v1/checkout/sessions", {
			method: "POST",
			headers: { Authorization: "Bearer k" },
			body: "a=1",
		});
		expect(res.ok).toBe(true);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: "cs_1" });
		expect(http.requests[0]).toEqual({
			url: "https://api.stripe.com/v1/checkout/sessions",
			method: "POST",
			headers: { authorization: "Bearer k" },
			body: "a=1",
		});
		const other = await ctx.http!.fetch("https://api.stripe.com/v1/x");
		expect(other.ok).toBe(false);
		await expect(ctx.http!.fetch("https://nowhere.test/")).rejects.toThrow(/no fake http handler/);
	});
});

describe("call counting", () => {
	it("counts every storage/kv/http/cron call, not log/site/url", async () => {
		const { ctx, http, calls, resetCalls, cron } = await make();
		http.on("GET", "https://x.test", { body: "ok" });
		const c = coll<Doc>(ctx, "stock");
		await c.put("p", { status: "", n: 1 });
		await c.get("p");
		await c.getVersioned("p");
		await ctx.kv.get("k");
		await ctx.http!.fetch("https://x.test/");
		await ctx.cron!.schedule("sweep", { schedule: "*/5 * * * *" });
		await ctx.cron!.cancel("sweep");
		ctx.log.info("hi");
		void ctx.site.url;
		ctx.url("/a");
		const r = calls();
		expect(r.total).toBe(7);
		expect(r.byMethod).toEqual({
			"storage.stock.put": 1,
			"storage.stock.get": 1,
			"storage.stock.getVersioned": 1,
			"kv.get": 1,
			"http.fetch": 1,
			"cron.schedule": 1,
			"cron.cancel": 1,
		});
		expect(cron.scheduled).toEqual([{ name: "sweep", schedule: "*/5 * * * *" }]);
		expect(cron.canceled).toEqual(["sweep"]);
		resetCalls();
		expect(calls().total).toBe(0);
	});

	it("raw() and seedSettings do not count", async () => {
		const { raw, kv, calls } = await make();
		await raw("stock").put("p", { n: 1 });
		kv.seedSettings({ a: 1 });
		expect(calls().total).toBe(0);
	});
});

describe("fault injection", () => {
	it("failAt(n) throws at the nth call without applying it, once", async () => {
		const { ctx, failAt, raw, calls } = await make();
		const c = coll<Doc>(ctx, "stock");
		failAt(2);
		await c.put("a", { status: "", n: 1 });
		await expect(c.put("b", { status: "", n: 2 })).rejects.toThrow(
			/injected failure at bridge call #2/,
		);
		expect(await raw("stock").get("b")).toBeNull();
		await c.put("b", { status: "", n: 2 }); // armed once only
		expect(calls().total).toBe(3);
	});

	it("failAt(n,{after:true}) applies the effect then throws (crash after write)", async () => {
		const { ctx, failAt, raw } = await make();
		failAt(1, { after: true });
		await expect(coll<Doc>(ctx, "stock").put("a", { status: "", n: 1 })).rejects.toThrow(
			/after bridge call/,
		);
		expect(await raw("stock").get("a")).toEqual({ status: "", n: 1 });
	});

	it("raceOnce makes one compareAndSet lose to a rival write", async () => {
		const { ctx, raceOnce, raw } = await make();
		const c = coll<Doc>(ctx, "stock");
		await c.put("p", { status: "", n: 1 });
		const v = (await c.getVersioned("p"))!;
		raceOnce("stock", "p", { status: "", n: 99 });
		expect(await c.compareAndSet("p", v.revision, { status: "", n: 2 })).toEqual({
			applied: false,
		});
		expect(await raw("stock").get("p")).toEqual({ status: "", n: 99 });
		const v2 = (await c.getVersioned("p"))!;
		expect((await c.compareAndSet("p", v2.revision, { status: "", n: 3 })).applied).toBe(true);
	});
});
