/**
 * The Block Kit admin pages (src/admin-page.ts, src/health.ts): block shape
 * (validated with EmDash's own validateBlockResponse, the check the host runs
 * on every sandboxed admin response), actions wired to the existing handlers,
 * the accept rule, and bridge calls per render.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { adminMessage, attentionWords, canAccept } from "../src/admin-page.js";
import { ordersResolve } from "../src/admin.js";
import { placeOrder } from "../src/checkout.js";
import type { OrderDoc } from "../src/model.js";
import plugin from "../src/plugin.js";
import {
	callRoute,
	deliver,
	linesFor,
	makeShop,
	nProducts,
	orderKey,
	type Shop,
} from "./fixtures.js";

// @emdash-cms/blocks is EmDash's dependency, not Core's: resolve it through emdash.
const blocksServer = createRequire(fileURLToPath(import.meta.resolve("emdash"))).resolve(
	"@emdash-cms/blocks/server",
);
const { validateBlockResponse } = (await import(blocksServer)) as {
	validateBlockResponse(
		r: unknown,
		p: { pluginPagePaths: string[]; allowedImageHosts: string[] },
	): { valid: boolean; errors: unknown[] };
};
const POLICY = { pluginPagePaths: ["/orders", "/setup"], allowedImageHosts: [] };

type B = Record<string, any>;
interface Resp {
	blocks: B[];
	toast?: { message: string; type: string };
}

const open: Shop[] = [];
const shop = async (...a: Parameters<typeof makeShop>) => {
	const s = await makeShop(...a);
	open.push(s);
	return s;
};
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
});

/** Call the `admin` route like EmDash does; assert the response passes the host's validation; count calls. */
async function admin(s: Shop, body: Record<string, unknown>): Promise<Resp & { calls: number }> {
	s.resetCalls();
	const r = (await callRoute(s.ctx, "admin", body)) as Resp;
	const calls = s.calls().total;
	const v = validateBlockResponse(r, POLICY);
	expect(v.errors).toEqual([]);
	expect(v.valid).toBe(true);
	return { ...r, calls };
}
const load = (s: Shop, page = "/orders") => admin(s, { type: "page_load", page });
const act = (s: Shop, action_id: string, value?: unknown, page = "/orders") =>
	admin(s, { type: "block_action", action_id, value, page });
const submit = (s: Shop, action_id: string, values: Record<string, unknown>, page = "/orders") =>
	admin(s, { type: "form_submit", action_id, values, page });

/** Every block and element, depth first. */
function walk(blocks: B[]): B[] {
	const out: B[] = [];
	const go = (x: unknown) => {
		if (Array.isArray(x)) return x.forEach(go);
		if (x && typeof x === "object") {
			const o = x as B;
			if (typeof o["type"] === "string") out.push(o);
			for (const v of Object.values(o)) if (v && typeof v === "object") go(v);
		}
	};
	go(blocks);
	return out;
}
const buttons = (r: Resp, id: string) =>
	walk(r.blocks).filter((b) => b["type"] === "button" && b["action_id"] === id);
const table = (r: Resp, id: string) =>
	r.blocks.find((b) => b["type"] === "table" && b["block_id"] === id)!;
const fieldMap = (r: Resp) =>
	Object.fromEntries(
		r.blocks
			.filter((b) => b["type"] === "fields")
			.flatMap((b) => b["fields"].map((f: B) => [f["label"], f["value"]])),
	);

/** A real order in review: Stripe charged 1 cent instead of the order total (paymentIntentId and amountPaid recorded). */
async function reviewShop(stock = 3) {
	const s = await shop(nProducts(1, stock));
	await placeOrder({ key: orderKey(1), lines: linesFor(1, 2) }, s.ctx);
	const cs = s.stripe.only();
	s.stripe.complete(cs.id, { amount_total: 1 });
	await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
	expect((await s.order(orderKey(1))).status).toBe("review");
	return s;
}
/** A paid order (key n). */
async function pay(s: Shop, n: number) {
	await placeOrder({ key: orderKey(n), lines: linesFor(1, 1) }, s.ctx);
	const cs = s.stripe.forOrder(orderKey(n))!;
	s.stripe.complete(cs.id);
	await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
	expect((await s.order(orderKey(n))).status).toBe("paid");
}
const patch = async (s: Shop, id: string, over: Partial<OrderDoc>) =>
	s.raw("orders").put(id, { ...(await s.order(id)), ...over });

describe("wiring", () => {
	it("one private POST JSON `admin` route (the literal name EmDash dispatches to)", () => {
		const r = (plugin.routes as Record<string, any>)["admin"];
		expect(r).toBeTruthy();
		expect(r.public).not.toBe(true);
		expect(r.methods).toEqual(["POST"]);
		expect(r.request.body).toBe("json");
		expect(r.permission).toBe("plugins:manage");
	});
	it("an unknown interaction returns an empty tree", async () => {
		const s = await shop([]);
		expect((await callRoute(s.ctx, "admin", { type: "nope" })).blocks).toEqual([]);
	});
});

describe("orders list", () => {
	it("shape: filter with every status, newest first, total/status/attention, review flagged; 1 call", async () => {
		const s = await reviewShop(10);
		await pay(s, 2);
		await placeOrder({ key: orderKey(3), lines: linesFor(1, 1) }, s.ctx); // pending
		const r = await load(s);
		expect(r.calls).toBe(1);
		expect(r.blocks[0]).toEqual({ type: "header", text: "Orders" });
		const menu = walk(r.blocks).find((b) => b["type"] === "menu")!;
		expect(menu["items"].map((i: B) => i["value"]).toSorted()).toEqual([
			"all",
			"canceled",
			"expired",
			"fulfilled",
			"paid",
			"pending",
			"review",
		]);
		const t = table(r, "orders");
		expect(t["columns"].map((c: B) => c["key"])).toEqual([
			"id",
			"created",
			"status",
			"total",
			"attention",
			"email",
			"open",
		]);
		expect(t["rows"].map((x: B) => x["id"])).toEqual([orderKey(3), orderKey(2), orderKey(1)]);
		const rev = t["rows"][2];
		expect(rev).toMatchObject({
			status: "REVIEW: needs a decision",
			attention: "Amount differs",
			total: "USD 25.00",
		});
		expect(rev["open"]).toMatchObject({
			type: "button",
			action_id: "open",
			label: "Review",
			style: "primary",
			value: { id: orderKey(1) },
		});
		expect(t["rows"][1]).toMatchObject({
			status: "paid",
			total: "USD 15.00",
			email: "buyer@example.com",
		});
		expect(
			r.blocks.some(
				(b) => b["type"] === "banner" && /1 order on this page needs review/.test(b["title"]),
			),
		).toBe(true);
	});
	it("status filter (review) re-renders only those orders; 1 call", async () => {
		const s = await reviewShop();
		await pay(s, 2);
		const r = await act(s, "status", "review");
		expect(r.calls).toBe(1);
		expect(table(r, "orders")["rows"].map((x: B) => x["id"])).toEqual([orderKey(1)]);
		expect(walk(r.blocks).find((b) => b["type"] === "menu")!["label"]).toBe("Status: review");
		const all = await act(s, "status", "all");
		expect(table(all, "orders")["rows"]).toHaveLength(2);
	});
	it("pages: next, previous, newest; the filter survives paging", async () => {
		const s = await shop(nProducts(1, 50));
		await placeOrder({ key: orderKey(1), lines: linesFor(1, 1) }, s.ctx);
		const base = await s.order(orderKey(1));
		for (let n = 2; n <= 25; n++)
			await s.raw("orders").put(orderKey(n), {
				...base,
				createdAt: new Date(Date.parse(base.createdAt) + n * 1000).toISOString(),
			});
		const p1 = await load(s);
		expect(table(p1, "orders")["rows"]).toHaveLength(20);
		expect(table(p1, "orders")["rows"][0]["id"]).toBe(orderKey(25));
		const next = buttons(p1, "list").find((b) => b["label"] === "Next page")!;
		const p2 = await act(s, "list", next["value"]);
		expect(p2.calls).toBe(1);
		expect(table(p2, "orders")["rows"].map((x: B) => x["id"])).toEqual(
			[5, 4, 3, 2, 1].map(orderKey),
		);
		expect(buttons(p2, "list").some((b) => b["label"] === "Next page")).toBe(false);
		const prev = buttons(p2, "list").find((b) => b["label"] === "Previous")!;
		expect(table(await act(s, "list", prev["value"]), "orders")["rows"][0]["id"]).toBe(
			orderKey(25),
		);
		// filtered paging keeps the status in the button value
		const f1 = await act(s, "status", "pending");
		const fn = buttons(f1, "list").find((b) => b["label"] === "Next page")!;
		expect(fn["value"]["s"]).toBe("pending");
	});
	it("store setup shows the plugin's own id (ctx.plugin.id) and route base, at no extra call", async () => {
		const s = await shop([]);
		const r = await load(s);
		expect(r.calls).toBe(1);
		expect(fieldMap(r)).toMatchObject({
			"Plugin id": "otta",
			"Route base": "/_emdash/api/plugins/otta",
		});
		expect(table(r, "orders")["rows"]).toEqual([]);
	});
});

describe("order detail", () => {
	it("shape: items, amounts, address, email, attention, status, Stripe ids; 1 call", async () => {
		const s = await reviewShop();
		await patch(s, orderKey(1), {
			discount: 0,
			refundedAmount: 1,
			shippingAddress: {
				name: "Ada",
				address: { line1: "1 Main St", city: "Springfield", postal_code: "12345", country: "US" },
			},
		});
		const r = await act(s, "open", { id: orderKey(1) });
		expect(r.calls).toBe(1);
		expect(r.blocks[0]).toEqual({ type: "header", text: `Order ${orderKey(1)}` });
		const f = fieldMap(r);
		const o = await s.order(orderKey(1));
		expect(f).toMatchObject({
			Status: "review",
			Email: "buyer@example.com",
			"Shipping address": "Ada, 1 Main St, Springfield, 12345, US",
			Attention: "AMOUNT_MISMATCH:1 USD",
			"Stripe session": o.stripeSessionId,
			"Stripe payment": o.paymentIntentId,
			Subtotal: "USD 20.00",
			Shipping: "USD 5.00",
			Total: "USD 25.00",
			Discount: "USD 0.00",
			"Amount paid": "USD 0.01",
			Refunded: "USD 0.01",
		});
		expect(o.paymentIntentId).toMatch(/^pi_/);
		expect(table(r, "items")["rows"]).toEqual([
			{
				title: "Product p1",
				sku: "",
				qty: 2,
				unit: "USD 10.00",
				line: "USD 20.00",
				stock: expect.objectContaining({ action_id: "stock_edit", value: { productId: "p1" } }),
			},
		]);
		expect(
			r.blocks.some(
				(b) =>
					b["type"] === "banner" &&
					b["title"] === "Needs a decision" &&
					/Stripe charged USD 0\.01, total is USD 25\.00/.test(b["description"]),
			),
		).toBe(true);
		expect(JSON.stringify(r.blocks)).not.toContain(o.orderKey);
		// review: accept (payment recorded) and release, both confirmed
		const res = buttons(r, "resolve");
		expect(res.map((b) => b["value"]["action"])).toEqual(["accept", "release"]);
		expect(res.every((b) => b["confirm"])).toBe(true);
		// no fulfil form while in review
		expect(walk(r.blocks).some((b) => b["type"] === "form")).toBe(false);
	});
	it("a paid order offers fulfil with optional tracking, and no resolve", async () => {
		const s = await shop(nProducts(1));
		await pay(s, 1);
		const r = await act(s, "open", { id: orderKey(1) });
		const form = r.blocks.find((b) => b["type"] === "form")!;
		expect(form["submit"]["action_id"]).toBe(`fulfil:${orderKey(1)}`);
		expect(form["fields"]).toEqual([
			expect.objectContaining({ type: "text_input", action_id: "tracking" }),
		]);
		expect(buttons(r, "resolve")).toEqual([]);
	});
	it("an unknown order shows the handler's error", async () => {
		const s = await shop([]);
		const r = await act(s, "open", { id: "ord_nope" });
		expect(r.blocks[0]).toMatchObject({
			type: "banner",
			variant: "error",
			description: "ORDER_NOT_FOUND",
		});
		expect(r.toast?.type).toBe("error");
	});
});

describe("accept is only offered with a recorded payment (admin.ts rule)", () => {
	it("no payment recorded: release only, and the handler agrees (NO_PAYMENT)", async () => {
		const s = await reviewShop();
		await patch(s, orderKey(1), {
			paymentIntentId: null,
			amountPaid: null,
			attention: "SESSION_UNREACHABLE",
		});
		const r = await act(s, "open", { id: orderKey(1) });
		expect(buttons(r, "resolve").map((b) => b["value"]["action"])).toEqual(["release"]);
		expect(JSON.stringify(r.blocks)).toContain("cannot be accepted: release it.");
		expect(((await ordersResolve({ id: orderKey(1), action: "accept" }, s.ctx)) as any).code).toBe(
			"NO_PAYMENT",
		);
	});
	it("amountPaid recorded but no PaymentIntent (not a promo order): not offered", async () => {
		const s = await reviewShop();
		await patch(s, orderKey(1), { paymentIntentId: null });
		expect(
			buttons(await act(s, "open", { id: orderKey(1) }), "resolve").map(
				(b) => b["value"]["action"],
			),
		).toEqual(["release"]);
		expect(((await ordersResolve({ id: orderKey(1), action: "accept" }, s.ctx)) as any).code).toBe(
			"NO_PAYMENT",
		);
	});
	it("free promo order (paid 0, no PaymentIntent): offered, and the handler accepts", async () => {
		const s = await reviewShop();
		await patch(s, orderKey(1), { promoCodes: true, paymentIntentId: null, amountPaid: 0 });
		const r = await act(s, "open", { id: orderKey(1) });
		const accept = buttons(r, "resolve").find((b) => b["value"]["action"] === "accept")!;
		expect(accept).toBeTruthy();
		const done = await act(s, "resolve", accept["value"]);
		expect(done.toast).toEqual({ message: "Accepted as a sale", type: "success" });
		expect((await s.order(orderKey(1))).status).toBe("paid");
	});
	it("canAccept matches ordersResolve on every payment combination", async () => {
		for (const [promoCodes, paidAt, amountPaid, paymentIntentId] of [
			[false, null, null, null],
			[false, "t", 1, "pi_1"],
			[false, "t", null, "pi_1"],
			[false, "t", 0, null],
			[true, "t", 0, null],
			[true, null, 0, null],
			[true, "t", 5, null],
		] as const) {
			const s = await reviewShop();
			const over = { promoCodes, paidAt, amountPaid, paymentIntentId } as Partial<OrderDoc>;
			await patch(s, orderKey(1), over);
			const r = (await ordersResolve({ id: orderKey(1), action: "accept" }, s.ctx)) as {
				ok: boolean;
			};
			expect([
				over,
				canAccept({ ...(await s.order(orderKey(1))), ...over, status: "review" }),
			]).toEqual([over, r.ok]);
			await s.close();
			open.splice(open.indexOf(s), 1);
		}
	});
});

describe("actions call the existing handlers", () => {
	it("accept -> ordersResolve: paid, stock committed; rendered from the handler's reply", async () => {
		const s = await reviewShop();
		const r = await act(s, "resolve", { id: orderKey(1), action: "accept" });
		expect(r.toast?.type).toBe("success");
		expect(await s.order(orderKey(1))).toMatchObject({ status: "paid", stock: "committed" });
		expect(await s.stock("p1")).toMatchObject({ onHand: 1, holds: {} });
		expect(fieldMap(r)["Status"]).toBe("paid");
		// ordersResolve's own calls (2 + 2 per tracked line + 1) and nothing more
		expect(r.calls).toBe(5);
		expect(r.calls).toBeLessThanOrEqual(30);
	});
	it("release -> ordersResolve: canceled, holds returned", async () => {
		const s = await reviewShop();
		const r = await act(s, "resolve", { id: orderKey(1), action: "release" });
		expect(r.toast?.message).toMatch(/Released/);
		expect(await s.order(orderKey(1))).toMatchObject({ status: "canceled", stock: "released" });
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(r.calls).toBe(5);
	});
	it("resolve on a non-review order shows the handler's refusal", async () => {
		const s = await shop(nProducts(1));
		await pay(s, 1);
		const r = await act(s, "resolve", { id: orderKey(1), action: "release" });
		expect(r.blocks[0]).toMatchObject({
			type: "banner",
			variant: "error",
			description: "ORDER_NOT_IN_REVIEW",
		});
		expect((await s.order(orderKey(1))).status).toBe("paid");
		expect(r.calls).toBe(2); // the handler's read + the detail re-read
	});
	it("fulfil -> ordersFulfil, with and without tracking", async () => {
		const s = await shop(nProducts(1));
		await pay(s, 1);
		await pay(s, 2);
		const a = await submit(s, `fulfil:${orderKey(1)}`, { tracking: "  TRK-1 " });
		expect(a.toast).toEqual({ message: "Marked fulfilled", type: "success" });
		expect(await s.order(orderKey(1))).toMatchObject({ status: "fulfilled", tracking: "TRK-1" });
		expect(fieldMap(a)).toMatchObject({ Status: "fulfilled", Tracking: "TRK-1" });
		expect(a.calls).toBe(2);
		await submit(s, `fulfil:${orderKey(2)}`, {});
		expect(await s.order(orderKey(2))).toMatchObject({ status: "fulfilled", tracking: null });
	});
	it("fulfil refused for an unpaid order", async () => {
		const s = await shop(nProducts(1));
		await placeOrder({ key: orderKey(1), lines: linesFor(1, 1) }, s.ctx);
		const r = await submit(s, `fulfil:${orderKey(1)}`, { tracking: "x" });
		expect(r.blocks[0]).toMatchObject({ variant: "error", description: "ORDER_NOT_PAYABLE" });
		expect((await s.order(orderKey(1))).status).toBe("pending");
	});
});

describe("stock", () => {
	it("list shows onHand, held, available; 2 calls", async () => {
		const s = await shop([...nProducts(2, 5), { id: "free", price: 1 }]);
		await placeOrder({ key: orderKey(1), lines: [{ productId: "p1", qty: 2 }] }, s.ctx);
		const r = await act(s, "stock");
		expect(r.calls).toBe(2);
		const rows = table(r, "stock")["rows"];
		expect(rows.find((x: B) => x["title"] === "Product p1")).toMatchObject({
			onHand: "5",
			held: "2",
			available: "3",
		});
		expect(rows.find((x: B) => x["title"] === "Product free")).toMatchObject({
			onHand: "unlimited",
		});
	});
	it("set stock sends expectedOnHand (the on-hand shown) through stockSet", async () => {
		const s = await shop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: [{ productId: "p1", qty: 2 }] }, s.ctx);
		const f = await act(s, "stock_edit", { productId: "p1" });
		expect(f.calls).toBe(2);
		expect(fieldMap(f)).toMatchObject({ "On hand": "5", Held: "2", Available: "3" });
		const form = f.blocks.find((b) => b["type"] === "form")!;
		const aid: string = form["submit"]["action_id"];
		expect(aid).toMatch(/^stock_set:p1:5:[0-9a-f]+$/);
		const r = await submit(s, aid, { onHand: 9 });
		expect(r.toast?.type).toBe("success");
		expect(await s.stock("p1")).toMatchObject({ onHand: 9, holds: { [orderKey(1)]: 2 } });
		expect(fieldMap(r)).toMatchObject({ "On hand": "9", Available: "7" });
		expect(r.calls).toBe(4); // stockSet 2 + re-read 2
		// the same submit again (same key) is a no-op, not a second set
		await s.raw("stock").put("p1", { ...(await s.stock("p1")) });
		const again = await submit(s, aid, { onHand: 9 });
		expect(again.toast?.type).toBe("success");
	});
	it("a stale screen is refused (STOCK_CHANGED) and the form refreshes with the current on-hand", async () => {
		const s = await shop(nProducts(1, 5));
		const f = await act(s, "stock_edit", { productId: "p1" });
		const aid: string = f.blocks.find((b) => b["type"] === "form")!["submit"]["action_id"];
		await s.raw("stock").put("p1", { ...(await s.stock("p1")), onHand: 4 }); // a sale elsewhere
		const r = await submit(s, aid, { onHand: 10 });
		expect(r.blocks[0]).toMatchObject({
			type: "banner",
			variant: "error",
			description: "STOCK_CHANGED",
		});
		expect((await s.stock("p1")).onHand).toBe(4);
		expect(r.blocks.find((b) => b["type"] === "form")!["submit"]["action_id"]).toMatch(
			/^stock_set:p1:4:/,
		);
		expect(r.calls).toBeLessThanOrEqual(5);
	});
});

describe("resync", () => {
	it("one resyncProducts step per click, Continue carries phase and cursor until complete", async () => {
		const s = await shop(nProducts(2));
		for (const id of ["p1", "p2"])
			s.content.put("products", {
				id,
				status: "published",
				data: { title: `Product ${id}`, price: 10, stock: 5 },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
		let r = await act(s, "resync");
		const seen: number[] = [r.calls];
		for (let n = 0; n < 10 && buttons(r, "resync").length; n++) {
			const c = buttons(r, "resync")[0]!;
			expect(c["label"]).toBe("Continue");
			expect(c["value"]).toMatchObject({ phase: expect.stringMatching(/^(content|orphans)$/) });
			r = await act(s, "resync", c["value"]);
			seen.push(r.calls);
		}
		expect(r.blocks.some((b) => b["type"] === "banner" && b["title"] === "Resync complete")).toBe(
			true,
		);
		expect(r.toast?.type).toBe("success");
		expect(fieldMap(r)["Steps"]).toBe(String(seen.length));
		expect(Math.max(...seen)).toBeLessThanOrEqual(30);
	});
});

const fresh = () => new Date(Date.now() - 60_000).toISOString();

const msg = (when: string) =>
	when === "yet"
		? "Not run yet. It starts within a few minutes of install; if this stays, check your site's cron trigger."
		: "Cleanup has not run for over 15 minutes: check your site's cron trigger.";

describe("setup & health", () => {
	const PROBE = "https://api.stripe.com/v1/checkout/sessions?limit=1";
	const rows = (r: Resp) =>
		Object.fromEntries(table(r, "checks")["rows"].map((x: B) => [x["check"], x]));

	it("all PASS when configured; copy-ready values filled in; the key is never shown; <= 30 calls", async () => {
		const s = await shop(nProducts(2));
		s.http.on("GET", PROBE, { status: 200, json: { data: [] } });
		s.kv.seedSettings({});
		await s.ctx.kv.set("health:lastWebhook", fresh());
		await s.ctx.kv.set("health:lastSweep", fresh());
		const r = await load(s, "/setup");
		const c = rows(r);
		expect(Object.values(c).map((x: any) => [x.check, x.status])).toEqual([
			["Stripe key", "PASS"],
			["Accepted by Stripe", "PASS"],
			["Webhook secret", "PASS"],
			["Last verified webhook", "PASS"],
			["Products collection", "PASS"],
			["Shop address", "PASS"],
			["Flat shipping", "PASS"],
			["Currency", "PASS"],
			["Sweep", "PASS"],
		]);
		expect(c["Stripe key"].detail).toBe("Present, test mode.");
		expect(c["Products collection"].detail).toBe(
			'"products": 2 synced, 2 for sale, 0 not for sale.',
		);
		expect(c["Currency"].detail).toBe("USD");
		const req = s.http.requests.find((q) => q.url === PROBE)!;
		expect(req.method).toBe("GET");
		expect(req.headers["authorization"]).toBe("Bearer sk_test_flow");
		expect(req.headers["stripe-version"]).toBeTruthy();
		const text = JSON.stringify(r.blocks);
		expect(text).not.toContain("sk_test_flow");
		expect(text).not.toContain("whsec_flow");
		const codes = r.blocks.filter((b) => b["type"] === "code").map((b) => b["code"]);
		expect(codes[0]).toBe("https://shop.test/_emdash/api/plugins/otta/stripe/webhook");
		expect(codes[1].split("\n")).toEqual([
			"checkout.session.completed",
			"checkout.session.expired",
			"refund.created",
			"refund.updated",
			"refund.failed",
		]);
		expect(codes[2]).toContain('createCart({ api: "/_emdash/api/plugins/otta" })');
		expect(codes[2]).not.toContain("PLUGIN_ID");
		expect(fieldMap(r)).toMatchObject({
			"Plugin id": "otta",
			"Route base": "/_emdash/api/plugins/otta",
		});
		expect(buttons(r, "resync")).toHaveLength(1);
		// settings 1 + stamps 1 + probe 1 + count 1 + one products page = 5
		expect(r.calls).toBe(6); // settings, stamps, probe, count, one products page, + recording the shop address once
	});
	it("Stripe key: absent (no probe), live mode, 401 rejected, 403 forbidden", async () => {
		const s = await shop([]);
		s.kv.seedSettings({ stripeSecretKey: "" });
		let c = rows(await load(s, "/setup"));
		expect(c["Stripe key"]).toMatchObject({
			status: "FIX",
			detail: "Enter the Stripe secret key in the plugin settings.",
		});
		expect(c["Accepted by Stripe"]).toBeUndefined();
		expect(s.http.requests).toEqual([]);
		s.kv.seedSettings({ stripeSecretKey: "rk_live_abc" });
		s.http.on("GET", PROBE, { status: 401, json: {} });
		c = rows(await load(s, "/setup"));
		expect(c["Stripe key"]).toMatchObject({ status: "PASS", detail: "Present, live mode." });
		expect(c["Accepted by Stripe"]).toMatchObject({
			status: "FIX",
			detail: expect.stringContaining("rejected the key (401)"),
		});
		s.http.on("GET", PROBE, { status: 403, json: {} });
		c = rows(await load(s, "/setup"));
		expect(c["Accepted by Stripe"]).toMatchObject({
			status: "FIX",
			detail: expect.stringContaining("Checkout Sessions permission (403)"),
		});
	});
	it("webhook: secret absent; no stamp yet gives the exact message", async () => {
		const s = await shop(nProducts(1), { secrets: false });
		s.http.on("GET", PROBE, { status: 200, json: {} });
		const c = rows(await load(s, "/setup"));
		expect(c["Webhook secret"].status).toBe("FIX");
		expect(c["Last verified webhook"]).toEqual({
			check: "Last verified webhook",
			status: "WAIT",
			detail:
				"None yet. This turns green after your first test payment; until then orders still settle, up to 5 minutes late.",
		});
	});
	it("products: counts active vs not sellable; none synced", async () => {
		const s = await shop(nProducts(3));
		s.http.on("GET", PROBE, { status: 200, json: {} });
		await s
			.raw("products")
			.put("p3", { ...((await s.raw("products").get("p3")) as object), active: false });
		let c = rows(await load(s, "/setup"));
		expect(c["Products collection"]).toMatchObject({
			status: "PASS",
			detail: '"products": 3 synced, 2 for sale, 1 not for sale.',
		});
		const e = await shop([]);
		e.kv.seedSettings({ productsCollection: "items" });
		e.http.on("GET", PROBE, { status: 200, json: {} });
		c = rows(await load(e, "/setup"));
		expect(c["Products collection"]).toMatchObject({
			status: "FIX",
			detail: expect.stringContaining('No products synced from "items"'),
		});
	});
	it("products: paging is capped within the budget", async () => {
		const s = await shop([]);
		s.http.on("GET", PROBE, { status: 200, json: {} });
		const base = {
			v: 1,
			title: "x",
			sku: null,
			price: 100,
			currency: "USD",
			active: true,
			trackStock: false,
			contentAt: null,
			appliedContentStock: null,
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		await s.raw("products").putMany(
			Array.from({ length: 520 }, (_, i) => ({
				id: `q${i}`,
				data: { ...base, productId: `q${i}` },
			})),
		);
		const r = await load(s, "/setup");
		expect(rows(r)["Products collection"].detail).toBe(
			'"products": 520 synced, 500+ for sale, 0+ not for sale (first 500 checked).',
		);
		expect(r.calls).toBe(10); // settings, stamps, probe, count, 5 pages, + recording the shop address once
	});
	it("currency: Settings.problem shown verbatim", async () => {
		const s = await shop([]);
		s.kv.seedSettings({ currency: "XYZ" });
		s.http.on("GET", PROBE, { status: 200, json: {} });
		let c = rows(await load(s, "/setup"));
		expect(c["Currency"]).toMatchObject({
			status: "FIX",
			detail:
				'"XYZ" is not a currency Otta Core can sell in. Enter a supported 3-letter code such as USD, EUR or GBP.',
		});
		s.kv.seedSettings({ currency: "USD", flatShipping: -1 });
		c = rows(await load(s, "/setup"));
		expect(c["Currency"].status).toBe("PASS");
		expect(c["Settings"]).toMatchObject({
			status: "FIX",
			detail: "flat shipping (minor units) must be a whole number from 0 to 10000000.",
		});
	});
	it("sweep: never run is WAIT, older than 15 minutes is a fix, fresh passes", async () => {
		const s = await shop([]);
		s.http.on("GET", PROBE, { status: 200, json: {} });
		expect(rows(await load(s, "/setup"))["Sweep"]).toMatchObject({
			status: "WAIT",
			detail: msg("yet"),
		});
		await s.ctx.kv.set("health:lastSweep", new Date(Date.now() - 16 * 60_000).toISOString());
		expect(rows(await load(s, "/setup"))["Sweep"]).toMatchObject({
			status: "FIX",
			detail: msg("lately"),
		});
		const t = fresh();
		await s.ctx.kv.set("health:lastSweep", t);
		expect(rows(await load(s, "/setup"))["Sweep"]).toMatchObject({
			status: "PASS",
			detail: expect.stringMatching(
				new RegExp(`^Last run ${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+ min ago\\)\\.$`),
			),
		});
		// a garbage stamp counts as absent
		await s.ctx.kv.set("health:lastSweep", 42);
		expect(rows(await load(s, "/setup"))["Sweep"].status).toBe("WAIT");
	});
	it("Re-check from the setup page re-renders it", async () => {
		const s = await shop([]);
		s.http.on("GET", PROBE, { status: 200, json: {} });
		const r = await act(s, "setup", undefined, "/setup");
		expect(r.blocks[0]).toEqual({ type: "header", text: "Setup & health" });
	});
});

describe("attention in plain words", () => {
	const o = { currency: "USD", total: 2500, amountPaid: 1999 };
	const cases: Array<[string, string, RegExp]> = [
		[
			"AMOUNT_MISMATCH:1999 USD",
			"Amount differs",
			/Stripe charged USD 19\.99, total is USD 25\.00/,
		],
		["AMOUNT_MISMATCH:? USD", "Amount differs", /charged an unknown amount/],
		["AMOUNT_MISMATCH:5000 JPY", "Amount differs", /charged JPY 50\.00|charged JPY 5000/],
		["FOREIGN_SESSION:cs_live_Abc", "Unknown session", /Session cs_live_Abc is not this order's/],
		["PAID_WHILE_EXPIRED", "Paid late", /expired or was cancelled/],
		["PAID_WHILE_CANCELED", "Paid late", /expired or was cancelled/],
		["SESSION_UNREACHABLE:404", "Session missing", /no record of this checkout/],
		["COMPLETE_UNPAID:unpaid", "Unpaid in Stripe", /payment is "unpaid"/],
		["REVIEW PAID", "Review payment", /USD 19\.99 arrived in review/],
		["SESSION_UNREACHABLE:404 PAID", "Session missing, Review payment", /USD 19\.99 arrived/],
		["OVERSOLD", "Oversold", /Sold more than in stock/],
		["REFUND_CURRENCY:EUR", "Check refunds", /Refunded may be wrong/],
		["REFUNDS_TRUNCATED", "Check refunds", /Refunded may be wrong/],
		[
			"PAID_WHILE_EXPIRED AMOUNT_MISMATCH:5000 USD",
			"Paid late, Amount differs",
			/expired or was cancelled.*charged USD 50\.00/,
		],
	];
	it.each(cases)("%s -> label and sentence", (att, label, re) => {
		const w = attentionWords(att, o)!;
		expect(w.label).toBe(label);
		expect(w.text).toMatch(re);
		// plain words: no raw token and no underscore-code in either
		expect(w.label + w.text).not.toMatch(/[A-Z]{3,}_[A-Z]/);
		expect(w.text).not.toMatch(/\$./);
	});
	it("an unknown value is not rewritten (null), and the pages fall back to it", async () => {
		expect(attentionWords("SOMETHING_NEW", o)).toBeNull();
		expect(attentionWords(null, o)).toBeNull();
	});
	it("the Orders list shows the label, the order page shows label-free sentence plus raw token field", async () => {
		const s = await reviewShop(10);
		const r = await load(s);
		expect(table(r, "orders")["rows"][0]["attention"]).toBe("Amount differs");
		const d = await act(s, "open", { id: orderKey(1) });
		const text = JSON.stringify(d.blocks);
		expect(text).toContain("Stripe charged USD 0.01, total is USD 25.00");
		expect(d.blocks.find((b) => b["type"] === "banner")!["description"]).not.toMatch(
			/AMOUNT_MISMATCH/,
		);
	});
	it("a non-review order with attention gets an Attention banner in words", async () => {
		const s = await shop(nProducts(1));
		await pay(s, 1);
		await patch(s, orderKey(1), { attention: "OVERSOLD" });
		const d = await act(s, "open", { id: orderKey(1) });
		expect(d.blocks.find((b) => b["type"] === "banner")).toMatchObject({
			title: "Attention",
			description: expect.stringContaining("Sold more than in stock"),
		});
	});
});

const bad = (message: string, code = "BAD_INPUT") => adminMessage({ ok: false, code, message });

describe("one-word admin errors get a clear page message", () => {
	it.each([
		["status", /^status must be pending, paid, fulfilled, review, expired or canceled\.$/],
		["limit", /^limit must be a whole number, 1 to 50\.$/],
		["id", /^id must be an order id\.$/],
		["tracking", /^tracking must be up to 200 characters\.$/],
	])("%s", (word, re) => expect(bad(word)).toMatch(re));
	it("stock input and anything else", () => {
		expect(bad("productId, onHand and expectedOnHand are required")).toMatch(/whole number/);
		expect(bad("action must be accept or release")).toBe("action must be accept or release");
		expect(bad("No such order", "ORDER_NOT_FOUND")).toBe("No such order");
	});
	it("shows on the page: a bad order id on open and a long tracking on fulfil", async () => {
		const s = await shop([]);
		const r = await act(s, "open", { id: 5 });
		expect(r.blocks[0]).toMatchObject({
			type: "banner",
			variant: "error",
			title: expect.stringMatching(/^id must be an order id/),
		});
		expect(r.toast).toMatchObject({ type: "error", message: expect.stringMatching(/^id must be/) });
		const p = await shop(nProducts(1));
		await pay(p, 1);
		const t = await submit(p, `fulfil:${orderKey(1)}`, { tracking: "x".repeat(300) });
		expect(t.blocks[0]).toMatchObject({
			type: "banner",
			variant: "error",
			title: expect.stringMatching(/^tracking must be/),
		});
	});
});

describe("the buy-button snippet on Setup", () => {
	it("never shows the server message to a buyer", async () => {
		const s = await shop([]);
		s.http.on("GET", "https://api.stripe.com/v1/checkout/sessions?limit=1", {
			status: 200,
			json: {},
		});
		const r = await load(s, "/setup");
		const snippet = walk(r.blocks)
			.map((b) => b["code"])
			.find((c) => typeof c === "string" && c.includes("data-otta-buy"))!;
		expect(snippet).not.toMatch(/alert\(out\.message/);
		expect(snippet).not.toMatch(/message:/);
		expect(snippet).toMatch(/buyerMessage\(out\.code\)/);
		expect(snippet).toContain('<script is:inline type="module">');
	});
});
