/** Regression tests: resync orphans, free promo orders, buyer tag and stamp lifetimes, install secret. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import type { ProductDoc } from "../src/model.js";
import { onAfterPublish } from "../src/products.js";
import { resyncProducts } from "../src/resync.js";
import { sweep } from "../src/sweep.js";
import { buyerAddress } from "../src/util.js";
import {
	callRoute,
	deliver,
	linesFor,
	makeShop,
	nextUpdatedAt,
	nProducts,
	orderKey,
} from "./fixtures.js";

async function resyncAll(s: Awaited<ReturnType<typeof makeShop>>) {
	let input: Record<string, unknown> = {};
	for (let n = 0; n < 50; n++) {
		const r = (await resyncProducts(input, s.ctx)) as {
			ok: boolean;
			nextPhase: string | null;
			nextCursor: string | null;
		};
		expect(r.ok).toBe(true);
		if (r.nextPhase === null) return;
		input = { phase: r.nextPhase, ...(r.nextCursor ? { cursor: r.nextCursor } : {}) };
	}
	throw new Error("resync did not finish");
}

describe("resync can undo its own orphan deactivation", () => {
	it("a wrong products collection, then the right one: products come back on sale", async () => {
		const s = await makeShop([]);
		const item = {
			id: "m1",
			status: "published",
			data: { title: "Mug", price: 10 },
			createdAt: nextUpdatedAt(),
			updatedAt: nextUpdatedAt(),
			liveRevisionId: "live",
			draftRevisionId: null,
		};
		s.content.put("products", item);
		await onAfterPublish(
			{ content: item as unknown as Record<string, unknown>, collection: "products" },
			s.ctx,
		);
		s.kv.seedSettings({ productsCollection: "productz" });
		await resyncAll(s);
		expect(((await s.raw("products").get("m1")) as ProductDoc).active).toBe(false);
		s.kv.seedSettings({ productsCollection: "products" });
		await resyncAll(s);
		const p = (await s.raw("products").get("m1")) as ProductDoc;
		expect([p.active, p.orphaned]).toEqual([true, undefined]);
	});
});

describe("a fully discounted promo order in review can be accepted", () => {
	it("accept works with a recorded payment of 0 and no PaymentIntent", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.kv.seedSettings({ allowPromotionCodes: true });
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const o = await s.order(orderKey(1));
		const cs = s.stripe.only();
		// Off by one cent in the discount: review, with the (free) payment recorded.
		s.stripe.complete(cs.id, {
			payment_status: "no_payment_required",
			payment_intent: null,
			amount_subtotal: o.subtotal,
			amount_total: 0,
			total_details: { amount_discount: o.total - 1, amount_shipping: o.shipping, amount_tax: 0 },
		});
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect((await s.order(orderKey(1))).status).toBe("review");
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "accept" })).ok,
		).toBe(true);
		expect((await s.stock("p1")).onHand).toBe(4);
	});
});

describe("buyer tag lifetime and lookup stamps", () => {
	it("the buyer tag is cleared when the order closes", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.kv.seedSettings({ _ipSalt: "b".repeat(64) });
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx, { ip: "203.0.113.7" });
		expect((await s.order(orderKey(1))).ipTag).toMatch(/^[0-9a-f]{16}$/);
		const cs = s.stripe.only();
		s.stripe.complete(cs.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		const o = await s.order(orderKey(1));
		expect([o.status, o.open, o.ipTag]).toEqual(["paid", 0, null]);
	});
	it("the sweep deletes lookup stamps older than an hour, and keeps fresh ones", async () => {
		const s = await makeShop(nProducts(1, 5));
		await s.ctx.kv.set("chk:old", Date.now() - 2 * 3_600_000);
		await s.ctx.kv.set("chk:new", Date.now());
		await sweep(s.ctx);
		const kv = s.kv.dump();
		expect(["chk:old" in kv, "chk:new" in kv]).toEqual([false, true]);
	});
	it("the sweep creates a missing salt (an install upgraded without a hook)", async () => {
		const s = await makeShop([]);
		await s.ctx.kv.delete("settings:_ipSalt");
		expect(s.kv.dump()["settings:_ipSalt"]).toBeUndefined();
		await sweep(s.ctx);
		expect(s.kv.dump()["settings:_ipSalt"]).toMatch(/^[0-9a-f]{64}$/);
	});
	it("carrier-grade NAT addresses are not buyer addresses", () => {
		expect([
			buyerAddress("100.64.0.1"),
			buyerAddress("100.127.255.255"),
			buyerAddress("100.128.0.1"),
		]).toEqual([null, null, "100.128.0.1"]);
	});
});
