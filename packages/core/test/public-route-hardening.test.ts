/** Hardening of the public routes: abuse limits, required headers, error leaks, return URLs, refusals. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { readHealth } from "../src/health.js";
import plugin from "../src/plugin.js";
import { linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

const route = (name: string) =>
	(plugin.routes as Record<string, { handler: (r: unknown, c: unknown) => Promise<any> }>)[name]!;

describe("refused-by-Stripe checkouts cannot be created without limit", () => {
	it("an email Stripe would refuse is refused first, with no Stripe call and no order", async () => {
		const s = await makeShop(nProducts(1, 5));
		for (const email of ["x@", "a b@c.d", "a@b", "@b.c", "a@b..c", "a@@b.c"]) {
			expect(
				await placeOrder({ key: orderKey(1), lines: linesFor(1), email }, s.ctx),
			).toMatchObject({ code: "INVALID_EMAIL" });
		}
		expect(s.http.requests.filter((r) => r.method === "POST")).toHaveLength(0);
		expect(await s.raw("orders").get(orderKey(1))).toBeNull();
		expect(
			(
				await placeOrder(
					{ key: orderKey(1), lines: linesFor(1), email: "buyer@example.co.uk" },
					s.ctx,
				)
			).ok,
		).toBe(true);
	});
	it("orders created recently are capped whatever became of them (closed ones count)", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.kv.seedSettings({ maxNewCheckouts: 2 });
		for (const n of [1, 2]) {
			s.stripe.failNextCreate(400); // refused: the order closes at once
			expect((await placeOrder({ key: orderKey(n), lines: linesFor(1) }, s.ctx)).ok).toBe(false);
		}
		expect(await placeOrder({ key: orderKey(3), lines: linesFor(1) }, s.ctx)).toMatchObject({
			code: "BUSY",
		});
		expect(await s.raw("orders").get(orderKey(3))).toBeNull();
	});
});

describe("checkout requires the storefront's header", () => {
	it("without x-otta-checkout: refused, nothing created", async () => {
		const s = await makeShop(nProducts(1, 5));
		const r = await route("checkout").handler(
			{ input: { key: orderKey(1), lines: linesFor(1) }, request: { headers: {} } },
			s.ctx,
		);
		expect(r).toMatchObject({ ok: false, code: "BAD_REQUEST" });
		expect(await s.raw("orders").get(orderKey(1))).toBeNull();
		expect(s.http.requests).toHaveLength(0);
	});
});

describe("buyer text in a Stripe error cannot raise the card-payment alarm", () => {
	it("a refusal about the email (param customer_email) is not a card problem", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.http.on("POST", "https://api.stripe.com/v1/checkout/sessions", {
			status: 400,
			json: {
				error: {
					type: "invalid_request_error",
					param: "customer_email",
					message: "Invalid email address: no payment method@x.co",
				},
			},
		});
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "STRIPE_REFUSED" });
		expect((await readHealth(s.ctx)).cardProblem).toBeNull();
	});
});

describe("public routes never leak an internal error", () => {
	it("a storage failure in checkout is a plain answer, not a thrown error", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.failAt(3);
		const r = await route("checkout").handler(
			{
				input: { key: orderKey(1), lines: linesFor(1) },
				request: { headers: { "x-otta-checkout": "1" } },
			},
			s.ctx,
		);
		s.failAt(null);
		expect(r).toMatchObject({
			ok: false,
			code: "ERROR",
			message: "Something went wrong on our side. Please try again.",
		});
		expect(JSON.stringify(r)).not.toContain("injected");
	});
});

describe("merchant-reported setup problems (code side)", () => {
	it("relative return URLs are refused until the shop address is known (never taken from the request Host), then resolve against it", async () => {
		const s = await makeShop(nProducts(1, 5));
		(s.ctx as unknown as { site: { url: string } }).site.url = "";
		const req = (n: number) =>
			route("checkout").handler(
				{
					input: { key: orderKey(n), lines: linesFor(1) },
					request: {
						url: "https://shop.example/_emdash/api/plugins/otta-core/checkout",
						headers: { "x-otta-checkout": "1" },
					},
				},
				s.ctx,
			);
		expect(await req(1)).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
		s.kv.seedSettings({ _shopOrigin: "https://shop.example" });
		expect((await req(2)).ok).toBe(true);
		const body = new URLSearchParams(s.http.requests.find((q) => q.method === "POST")!.body);
		expect(body.get("success_url")).toMatch(
			/^https:\/\/shop\.example\/checkout\/success\?order=ord_/,
		);
		expect(body.get("cancel_url")).toBe("https://shop.example/cart");
	});
	it("a webhook event for another store does not count as this store's webhook working", async () => {
		const s = await makeShop(nProducts(1, 5));
		const { deliver } = await import("./fixtures.js");
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.complete(cs.id, {
			metadata: { order_id: "ord_" + "f".repeat(32), otta_store: "other" },
		});
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect(s.kv.dump()["health:lastWebhook"]).toBeUndefined();
	});
});

describe("Host-header phishing: the recorded shop address wins over the request's", () => {
	it("after an admin opened Setup, a forged Host cannot change where buyers return", async () => {
		const s = await makeShop(nProducts(1, 5));
		(s.ctx as unknown as { site: { url: string } }).site.url = "";
		const { adminPage } = await import("../src/admin-page.js");
		s.http.on("GET", "https://api.stripe.com/v1/checkout/sessions?limit=1", {
			status: 200,
			json: {},
		});
		await adminPage({ type: "page_load", page: "/setup" }, s.ctx, "https://real-shop.example");
		expect(s.kv.dump()["settings:_shopOrigin"]).toBe("https://real-shop.example");
		const r = await route("checkout").handler(
			{
				input: { key: orderKey(1), lines: linesFor(1) },
				request: {
					url: "https://evil.example/_emdash/api/plugins/otta-core/checkout",
					headers: { "x-otta-checkout": "1" },
				},
			},
			s.ctx,
		);
		expect(r.ok).toBe(true);
		const body = new URLSearchParams(s.http.requests.find((q) => q.method === "POST")!.body);
		expect(body.get("success_url")).toMatch(
			/^https:\/\/real-shop\.example\/checkout\/success\?order=ord_[0-9a-f]+#key=[0-9a-f]+$/,
		);
		expect(body.get("cancel_url")).toBe("https://real-shop.example/cart");
	});
});

describe("refusals name the product", () => {
	it("OUT_OF_STOCK and PRODUCT_UNAVAILABLE carry the productId", async () => {
		const s = await makeShop([
			{ id: "p1", price: 10, stock: 1 },
			{ id: "p2", price: 10, stock: 5 },
		]);
		expect(
			await placeOrder({ key: orderKey(1), lines: [{ productId: "p1", qty: 2 }] }, s.ctx),
		).toMatchObject({ code: "OUT_OF_STOCK", productId: "p1" });
		expect(
			await placeOrder({ key: orderKey(2), lines: [{ productId: "nope", qty: 1 }] }, s.ctx),
		).toMatchObject({ code: "PRODUCT_UNAVAILABLE", productId: "nope" });
	});
});

describe("Setup can replace the recorded shop address", () => {
	it("offers the admin's own address when it differs, and stores it on confirm", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.kv.seedSettings({ _shopOrigin: "https://preview.example" });
		s.http.on("GET", "https://api.stripe.com/v1/checkout/sessions?limit=1", {
			status: 200,
			json: {},
		});
		const { adminPage } = await import("../src/admin-page.js");
		const page = await adminPage(
			{ type: "page_load", page: "/setup" },
			s.ctx,
			"https://shop.example",
		);
		expect(JSON.stringify(page)).toContain("Use https://shop.example as the shop address");
		// The host validates every block reply; this one must pass too.
		const { createRequire } = await import("node:module");
		const { fileURLToPath } = await import("node:url");
		const server = createRequire(fileURLToPath(import.meta.resolve("emdash"))).resolve(
			"@emdash-cms/blocks/server",
		);
		const { validateBlockResponse } = (await import(server)) as {
			validateBlockResponse(r: unknown, p: unknown): { valid: boolean; errors: unknown[] };
		};
		expect(
			validateBlockResponse(page, { pluginPagePaths: ["/orders", "/setup"], allowedImageHosts: [] })
				.errors,
		).toEqual([]);
		await adminPage(
			{ type: "block_action", action_id: "shop_origin_here", page: "/setup" },
			s.ctx,
			"https://shop.example",
		);
		expect(s.kv.dump()["settings:_shopOrigin"]).toBe("https://shop.example");
	});
});

describe("the first checkout before Setup was opened", () => {
	it("tells the shop owner what to do, in plain words", async () => {
		const s = await makeShop(nProducts(1, 5));
		(s.ctx as unknown as { site: { url: string } }).site.url = "";
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
		expect((r as { message: string }).message).toContain("open Otta Core > Setup & health once");
	});
});
