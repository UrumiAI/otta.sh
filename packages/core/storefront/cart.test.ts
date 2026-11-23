import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without types
import {
	buyerMessage,
	clickGuard,
	createCart,
	formatMoney,
	lineStock,
	orderReference,
	refusalText,
} from "./cart.js";

const API = "/_emdash/api/plugins/r_0123456789abcdef";

function fakeStorage() {
	const m = new Map<string, string>();
	return {
		get length() {
			return m.size;
		},
		key: (i: number) => [...m.keys()][i] ?? null,
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		keys: () => [...m.keys()].filter((k) => k.startsWith("otta-key:")),
	};
}

/** Fake fetch: answers checkout calls from a queue ("network" throws) and records bodies. */
function setup(answers: Array<unknown>, clock = { t: 1_000_000 }) {
	const storage = fakeStorage();
	const sleeps: number[] = [];
	const bodies: Array<{ key: string; lines: unknown; email?: string }> = [];
	const headers: Array<Record<string, string> | undefined> = [];
	const fetch = async (
		_url: string,
		init?: { body?: string; headers?: Record<string, string> },
	) => {
		bodies.push(JSON.parse(init?.body ?? "{}"));
		headers.push(init?.headers);
		const a = answers.shift();
		if (a === "network") throw new TypeError("failed to fetch");
		return { json: async () => ({ success: true, data: a }) };
	};
	const sleep = async (ms: number) => void sleeps.push(ms);
	return {
		cart: createCart({ api: API, storage, fetch, sleep, now: () => clock.t }),
		storage,
		bodies,
		headers,
		sleeps,
		clock,
	};
}

const fail = (code: string) => ({ ok: false, code, message: code });
const ok = { ok: true, orderId: "ord_x", url: "https://checkout.stripe.com/c/1" };

describe("cart", () => {
	it("adds, merges, sets, removes and clears", () => {
		const { cart } = setup([]);
		cart.add("a");
		cart.add("a", 2);
		cart.add("b");
		expect(cart.lines()).toEqual([
			{ productId: "a", qty: 3 },
			{ productId: "b", qty: 1 },
		]);
		cart.setQty("a", 5);
		cart.setQty("b", 0);
		expect(cart.lines()).toEqual([{ productId: "a", qty: 5 }]);
		cart.remove("a");
		expect(cart.lines()).toEqual([]);
		cart.add("a");
		cart.clear();
		expect(cart.lines()).toEqual([]);
	});
});

describe("checkout key rules", () => {
	it("sends a well-formed key and reuses it when retrying the same lines after PAYMENT_UNAVAILABLE", async () => {
		const { cart, bodies } = setup([fail("PAYMENT_UNAVAILABLE"), fail("PAYMENT_UNAVAILABLE"), ok]);
		cart.add("a", 2);
		expect((await cart.checkout()).code).toBe("PAYMENT_UNAVAILABLE");
		expect((await cart.checkout()).ok).toBe(true);
		expect(bodies[0].key).toMatch(/^ord_[0-9a-f]{32}$/);
		expect(bodies.map((b) => b.key)).toEqual([bodies[0].key, bodies[0].key, bodies[0].key]);
	});

	it("retries PAYMENT_UNAVAILABLE once, after about 1.5 s, with the same key and lines", async () => {
		const { cart, bodies, sleeps } = setup([fail("PAYMENT_UNAVAILABLE"), ok]);
		cart.add("a", 2);
		const out = await cart.checkout();
		expect(out.ok).toBe(true);
		expect(sleeps).toEqual([1500]);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toEqual(bodies[0]);
	});

	it("shows the message only after the single retry also fails", async () => {
		const { cart, bodies, sleeps, storage } = setup([
			fail("PAYMENT_UNAVAILABLE"),
			fail("PAYMENT_UNAVAILABLE"),
			ok,
		]);
		cart.add("a");
		const out = await cart.checkout();
		expect(out.code).toBe("PAYMENT_UNAVAILABLE");
		expect(out.text).toBe(buyerMessage("PAYMENT_UNAVAILABLE"));
		expect(bodies).toHaveLength(2); // one retry, not more
		expect(sleeps).toEqual([1500]);
		expect(storage.keys()).toHaveLength(1); // kept
	});

	it("does not retry other failures, or a network error", async () => {
		for (const a of [fail("OUT_OF_STOCK"), "network", ok]) {
			const { cart, bodies, sleeps } = setup([a, ok]);
			cart.add("a");
			await cart.checkout();
			expect(bodies).toHaveLength(1);
			expect(sleeps).toEqual([]);
		}
	});

	it("sends only productId and qty, even when a line carries a title", async () => {
		const { cart, bodies } = setup([ok]);
		cart.add("a", 1, "Blue mug");
		expect(cart.lines()).toEqual([{ productId: "a", qty: 1, title: "Blue mug" }]);
		await cart.checkout();
		expect(bodies[0].lines).toEqual([{ productId: "a", qty: 1 }]);
	});

	it("keeps the key on a network error", async () => {
		const { cart, bodies } = setup(["network", ok]);
		cart.add("a");
		expect((await cart.checkout()).code).toBe("NETWORK");
		await cart.checkout();
		expect(bodies[1].key).toBe(bodies[0].key);
	});

	it.each([
		"INVALID_LINES",
		"PRODUCT_UNAVAILABLE",
		"OUT_OF_STOCK",
		"NOT_CONFIGURED",
		"BUSY",
		"FREE_ORDER",
		"KEY_REUSED",
		"ORDER_CLOSED",
	])("drops the key after %s", async (code) => {
		const { cart, bodies, storage } = setup([fail(code), ok]);
		cart.add("a");
		await cart.checkout();
		expect(storage.keys()).toEqual([]);
		await cart.checkout();
		expect(bodies[1].key).not.toBe(bodies[0].key);
	});

	it("keeps the key after an ok answer, so coming back from Stripe and paying again reuses the same order", async () => {
		const { cart, bodies, storage } = setup([ok, ok]);
		cart.add("a");
		expect((await cart.checkout()).ok).toBe(true);
		expect(storage.keys()).toHaveLength(1);
		expect((await cart.checkout()).url).toBe(ok.url);
		expect(bodies[1].key).toBe(bodies[0].key);
	});

	it("done() empties the cart and forgets every key, so the next purchase is a new order", async () => {
		// The second checkout's different lines first try to release the first (refused here, so it stays).
		const { cart, bodies, storage } = setup([ok, fail("NOT_RELEASABLE"), ok, ok]);
		cart.add("a");
		await cart.checkout();
		await cart.checkout({ lines: [{ productId: "b", qty: 1 }] });
		expect(storage.keys()).toHaveLength(2);
		cart.done();
		expect(storage.keys()).toEqual([]);
		expect(cart.lines()).toEqual([]);
		cart.add("a");
		await cart.checkout();
		expect(bodies[3].key).not.toBe(bodies[0].key);
	});

	it("done() also clears key slots it has no record of (written by an older kit)", () => {
		const { cart, storage } = setup([]);
		storage.setItem('otta-key:[[["a",1]],""]', "ord_" + "0".repeat(32));
		storage.setItem("unrelated", "x");
		cart.done();
		expect(storage.keys()).toEqual([]);
		expect(storage.getItem("unrelated")).toBe("x");
	});

	it("after an ok answer, different lines get a new key (no KEY_REUSED)", async () => {
		const { cart, bodies } = setup([ok, { ok: true, released: true }, ok]);
		cart.add("a");
		await cart.checkout();
		cart.add("b");
		await cart.checkout();
		expect(bodies[2].key).not.toBe(bodies[0].key);
	});

	it("sends the x-otta-checkout header the route requires", async () => {
		const { cart, headers } = setup([ok]);
		cart.add("a");
		await cart.checkout();
		expect(headers[0]?.["x-otta-checkout"]).toBe("1");
		expect(headers[0]?.["content-type"]).toBe("application/json");
	});

	it("uses a different key for different lines, and the old key still serves the old lines", async () => {
		const PU = fail("PAYMENT_UNAVAILABLE");
		const { cart, bodies } = setup([PU, PU, PU, PU, ok]);
		cart.add("a");
		await cart.checkout(); // lines {a:1}, two calls (one retry)
		cart.add("a"); // {a:2}
		await cart.checkout();
		expect(bodies[2].key).not.toBe(bodies[0].key);
		cart.setQty("a", 1); // back to {a:1}
		await cart.checkout();
		expect(bodies[4].key).toBe(bodies[0].key);
	});

	it("treats the same lines in another order as the same purchase, and a different email as another", async () => {
		const { cart, bodies } = setup(Array.from({ length: 6 }, () => fail("PAYMENT_UNAVAILABLE")));
		await cart.checkout({
			lines: [
				{ productId: "a", qty: 1 },
				{ productId: "b", qty: 2 },
			],
		});
		await cart.checkout({
			lines: [
				{ productId: "b", qty: 2 },
				{ productId: "a", qty: 1 },
			],
		});
		await cart.checkout({
			lines: [
				{ productId: "a", qty: 1 },
				{ productId: "b", qty: 2 },
			],
			email: "x@example.com",
		});
		expect(bodies[2].key).toBe(bodies[0].key);
		expect(bodies[4].key).not.toBe(bodies[0].key);
		expect(bodies[4].email).toBe("x@example.com");
	});

	it("does not call the server for an empty cart", async () => {
		const { cart, bodies } = setup([]);
		expect((await cart.checkout()).code).toBe("INVALID_LINES");
		expect(bodies).toEqual([]);
	});
});

const fmt = (m: number, c: string) => formatMoney(m, c, "en-US").replace(/\u00a0/g, " "); // Intl uses a no-break space

describe("formatMoney", () => {
	it("uses the currency's own fraction digits", () => {
		expect(formatMoney(1999, "USD", "en-US")).toBe("$19.99");
		expect(formatMoney(1500, "JPY", "en-US")).toBe("¥1,500");
		// Core prices HUF/IDR/COP/PKR in hundredths (ISO); the browser would show them with no decimals.
		expect(fmt(150000, "HUF").replace(/\s/g, "")).toMatch(/1,500\.00/);
		expect(fmt(1234, "KWD").replace(/\s/g, "")).toMatch(/1\.234/);
		expect(fmt(1500, "KWD")).toBe("KWD 1.500");
		expect(fmt(2345, "BHD")).toBe("BHD 2.345");
	});
});

describe("limits", () => {
	it("refuses more than 8 distinct products without calling the server", async () => {
		const { cart, bodies } = setup([]);
		const lines = Array.from({ length: 9 }, (_, i) => ({ productId: `p${i}`, qty: 1 }));
		expect((await cart.checkout({ lines })).code).toBe("INVALID_LINES");
		expect(bodies).toEqual([]);
	});
});

const CODES = [
	"INVALID_KEY",
	"INVALID_EMAIL",
	"INVALID_LINES",
	"PRODUCT_UNAVAILABLE",
	"OUT_OF_STOCK",
	"STOCK_BUSY",
	"NOT_CONFIGURED",
	"BUSY",
	"BUSY_BUYER",
	"FREE_ORDER",
	"KEY_REUSED",
	"PAYMENT_UNAVAILABLE",
	"ORDER_CLOSED",
	"CANCELED",
	"STRIPE_REFUSED",
	"CONFLICT",
	"NETWORK",
];
const plain = (t: string) =>
	typeof t === "string" &&
	t.length > 10 &&
	t.length < 130 &&
	/[a-z]/.test(t) &&
	!/[A-Z]{2,}_[A-Z]|\b[A-Z]{4,}\b|_/.test(t);

describe("buyerMessage", () => {
	it.each(CODES)("%s maps to short plain words with no code in them", (code) => {
		const m = buyerMessage(code);
		expect(plain(m)).toBe(true);
		expect(m).not.toContain(code);
		expect(buyerMessage({ ok: false, code })).toBe(m);
	});
	it("tells the buyer what to do (every message carries an instruction or a plain fact)", () => {
		expect(buyerMessage("INVALID_EMAIL")).toMatch(/leave it blank/);
		expect(buyerMessage("OUT_OF_STOCK")).toMatch(/Lower the quantity/);
		expect(buyerMessage("ORDER_CLOSED")).toMatch(/do not need to pay again/);
		expect(buyerMessage("BUSY_BUYER")).toBe(
			"You already have a checkout waiting for payment. Finish it, or try again in about 40 minutes.",
		);
	});
	it("never promises a Stripe receipt email", () => {
		for (const c of [...CODES, "ORDER_NOT_FOUND", "INVALID_INPUT"])
			expect(buyerMessage(c)).not.toMatch(/receipt/i);
	});
	it("unknown, missing and odd codes get the safe generic message", () => {
		const g = buyerMessage("NO_SUCH_CODE_123");
		expect(plain(g)).toBe(true);
		for (const x of [undefined, null, 42, {}, "", "constructor", "__proto__", "toString"])
			expect(buyerMessage(x as never)).toBe(g);
	});
	it("a cancelled order replayed with its cancel reason as the code never leaks it", () => {
		for (const reason of [
			"AMOUNT_MISMATCH:1999 USD",
			"RELEASED_FROM_REVIEW",
			"SESSION_UNREACHABLE:404",
			"PAID_WHILE_EXPIRED AMOUNT_MISMATCH:5000 USD",
			"COMPLETE_UNPAID:unpaid",
		]) {
			const m = buyerMessage(reason);
			expect(plain(m)).toBe(true);
			expect(m).toBe("We could not place this order. Please start again.");
		}
	});
});

const notFoundFetch = async () => ({
	json: async () => ({
		success: true,
		data: { ok: false, code: "ORDER_NOT_FOUND", message: "order not found" },
	}),
});

describe("failed answers carry buyer text, never the server message", () => {
	it.each(CODES)("checkout %s: text is the mapped words", async (code) => {
		const answer = { ok: false, code, message: "store settings: currency XYZ, merchant words" };
		const { cart } = setup([answer, answer]);
		cart.add("a");
		const out = await cart.checkout();
		expect(out.text).toBe(buyerMessage(code));
		expect(out.text).not.toContain("merchant words");
	});
	it("kit-made failures: empty cart, too many products, bad shape, network", async () => {
		const a = setup([]);
		const e = await a.cart.checkout();
		expect(e.text).toBe("Your cart is empty.");
		expect(e.message).toBe(e.text);
		const many = await a.cart.checkout({
			lines: Array.from({ length: 9 }, (_, i) => ({ productId: `p${i}`, qty: 1 })),
		});
		expect(many.text).toMatch(/more than 8 different items.*8 or fewer/);
		const b = setup([{ nonsense: true }, "network"]);
		b.cart.add("a");
		const odd = await b.cart.checkout();
		expect(odd.code).toBe("ERROR");
		expect(odd.text).toBe(buyerMessage("anything-else"));
		expect(odd.message).not.toMatch(/Unexpected/);
		expect((await b.cart.checkout()).text).toBe(buyerMessage("NETWORK"));
	});
	it("order poll failures carry text too", async () => {
		const storage = fakeStorage();
		const cart = createCart({ api: API, storage, fetch: notFoundFetch });
		const out = await cart.order("ord_x", "k");
		expect(out.text).toMatch(/could not find this order/);
		const down = createCart({
			api: API,
			storage,
			fetch: async () => {
				throw new TypeError("x");
			},
		});
		expect((await down.order("ord_x", "k")).text).toBe(buyerMessage("NETWORK"));
	});
});

describe("successParams", () => {
	it("reads the key from the fragment and removes it from the address bar", async () => {
		const { successParams } = await import("./cart.js");
		const calls: string[] = [];
		const loc = { search: "?order=ord_1", hash: "#key=abc", pathname: "/checkout/success" };
		const r = successParams(
			loc as never,
			{ state: null, replaceState: (_s: unknown, _t: string, u: string) => calls.push(u) } as never,
		);
		expect(r).toEqual({ id: "ord_1", key: "abc" });
		expect(calls).toEqual(["/checkout/success?order=ord_1"]);
	});
	it("still reads an older link with the key in the query, and cleans it", async () => {
		const { successParams } = await import("./cart.js");
		const calls: string[] = [];
		const r = successParams(
			{ search: "?order=ord_1&key=abc", hash: "", pathname: "/s" } as never,
			{ state: null, replaceState: (_s: unknown, _t: string, u: string) => calls.push(u) } as never,
		);
		expect(r).toEqual({ id: "ord_1", key: "abc" });
		expect(calls).toEqual(["/s?order=ord_1"]);
	});
});

describe("lineStock (the cart page's stock label)", () => {
	it("says Sold out at 0, never 'only 0 left', and sets no max", () => {
		expect(lineStock(0, 1)).toEqual({ label: "Sold out", short: true, max: null });
		expect(lineStock(0, 1).label).not.toMatch(/only 0/);
	});
	it("says only N left for low stock or a shortfall, and caps the input at what is left", () => {
		expect(lineStock(3, 1)).toEqual({ label: "only 3 left", short: false, max: 3 });
		expect(lineStock(7, 1)).toEqual({ label: "", short: false, max: 7 });
		expect(lineStock(7, 8)).toEqual({ label: "only 7 left", short: true, max: 7 });
	});
	it("treats 10 as '10 or more' and null as unlimited", () => {
		expect(lineStock(10, 25)).toEqual({ label: "", short: false, max: 99 });
		expect(lineStock(null, 50, 20)).toEqual({ label: "", short: false, max: 20 });
	});
});

const refuse = (code: string, productId: string) => ({ ok: false, code, message: "x", productId });

describe("per-line refusals", () => {
	it("names the product", () => {
		expect(refusalText("OUT_OF_STOCK", "Blue mug")).toBe("Sorry, Blue mug is sold out.");
		expect(refusalText("PRODUCT_UNAVAILABLE", "blue mug")).toBe("Blue mug is no longer for sale.");
		expect(refusalText("OUT_OF_STOCK", "Blue mug", 3)).toMatch(/not enough of Blue mug left/);
		expect(refusalText("OUT_OF_STOCK", undefined)).toBe("Sorry, this item is sold out.");
		expect(refusalText("BUSY", "Blue mug")).toBe(buyerMessage("BUSY"));
	});

	it("stores the refusal on THAT line, named from the cart's data, and keeps it across a reload", async () => {
		const { cart, storage } = setup([refuse("OUT_OF_STOCK", "b")]);
		cart.add("a", 1, "Red cup");
		cart.add("b", 1, "Blue mug");
		const out = await cart.checkout();
		expect(out.text).toBe("Sorry, Blue mug is sold out.");
		expect(cart.refusals()).toEqual({
			b: { code: "OUT_OF_STOCK", text: "Sorry, Blue mug is sold out." },
		});
		const reloaded = createCart({
			api: API,
			storage,
			fetch: async () => ({ json: async () => ({}) }),
		});
		expect(reloaded.refusals().b.text).toBe("Sorry, Blue mug is sold out.");
	});

	it("uses the title from the availability reply when the line had none", async () => {
		const products = {
			b: { title: "Blue mug", price: 500, currency: "USD", active: true, available: 1 },
		};
		const { cart } = setup([{ ok: true, products }, refuse("PRODUCT_UNAVAILABLE", "b")]);
		cart.add("b");
		await cart.availability(["b"]);
		await cart.checkout();
		expect(cart.refusals().b.text).toBe("Blue mug is no longer for sale.");
	});

	it("clears the refusal when that line changes or is removed", async () => {
		const { cart } = setup([
			refuse("OUT_OF_STOCK", "a"),
			refuse("OUT_OF_STOCK", "a"),
			refuse("OUT_OF_STOCK", "a"),
		]);
		cart.add("a", 2, "Blue mug");
		await cart.checkout();
		expect(Object.keys(cart.refusals())).toEqual(["a"]);
		cart.setQty("a", 1);
		expect(cart.refusals()).toEqual({});
		await cart.checkout();
		cart.add("a");
		expect(cart.refusals()).toEqual({});
		await cart.checkout();
		cart.remove("a");
		expect(cart.refusals()).toEqual({});
	});

	it("clears every refusal when a checkout succeeds", async () => {
		const { cart } = setup([refuse("OUT_OF_STOCK", "b"), ok]);
		cart.add("a");
		cart.add("b");
		await cart.checkout();
		expect(Object.keys(cart.refusals())).toEqual(["b"]);
		await cart.checkout({ lines: [{ productId: "a", qty: 1 }] });
		expect(cart.refusals()).toEqual({});
	});

	it("a buy-now refusal names the product but is not stored on the cart", async () => {
		const { cart } = setup([refuse("OUT_OF_STOCK", "b")]);
		const out = await cart.checkout({ lines: [{ productId: "b", qty: 1, title: "Blue mug" }] });
		expect(out.text).toBe("Sorry, Blue mug is sold out.");
		expect(cart.refusals()).toEqual({});
	});

	it("a refusal without productId keeps the general message and stores nothing", async () => {
		const { cart } = setup([fail("OUT_OF_STOCK")]);
		cart.add("a", 1, "Blue mug");
		expect((await cart.checkout()).text).toBe(buyerMessage("OUT_OF_STOCK"));
		expect(cart.refusals()).toEqual({});
	});

	it("done() and clear() forget refusals", async () => {
		const a = setup([refuse("OUT_OF_STOCK", "a")]);
		a.cart.add("a");
		await a.cart.checkout();
		a.cart.done();
		expect(a.storage.getItem("otta-refusals")).toBeNull();
		const b = setup([refuse("OUT_OF_STOCK", "a")]);
		b.cart.add("a");
		await b.cart.checkout();
		b.cart.clear();
		expect(b.storage.getItem("otta-refusals")).toBeNull();
	});
});

describe("pending: a stored key for the cart's exact lines", () => {
	it("is null without a key, and reserved after Core opened a Checkout", async () => {
		const { cart } = setup([ok]);
		cart.add("a");
		expect(cart.pending()).toBeNull();
		await cart.checkout();
		expect(cart.pending()).toEqual({ email: "", reserved: true });
	});

	it("a stored key bypasses the client stock check, and the replay reuses the open Checkout", async () => {
		const { cart, bodies } = setup([ok, ok]);
		cart.add("a");
		await cart.checkout();
		// Back from Stripe: availability shows 0 left because this buyer holds the last unit.
		const stock = lineStock(0, 1);
		const blocked = stock.short && !cart.pending(); // the cart page's rule
		expect(blocked).toBe(false);
		expect((await cart.checkout()).url).toBe(ok.url);
		expect(bodies[1].key).toBe(bodies[0].key);
	});

	it("without a stored key, the client stock check still blocks", () => {
		const { cart } = setup([]);
		cart.add("a");
		expect(lineStock(0, 1).short && !cart.pending()).toBe(true);
	});

	it("is for the exact lines only: another quantity has no key", async () => {
		const { cart } = setup([ok]);
		cart.add("a");
		await cart.checkout();
		cart.add("a");
		expect(cart.pending()).toBeNull();
		cart.setQty("a", 1);
		expect(cart.pending()?.reserved).toBe(true);
	});

	it("a key kept after a network error is pending but not reserved", async () => {
		const { cart } = setup(["network"]);
		cart.add("a");
		await cart.checkout();
		expect(cart.pending()).toEqual({ email: "", reserved: false });
	});

	it("stops being reserved 40 minutes after the first ok answer (a replay does not restart it)", async () => {
		const clock = { t: 0 };
		const { cart } = setup([ok, ok], clock);
		cart.add("a");
		await cart.checkout();
		clock.t = 30 * 60_000;
		await cart.checkout();
		expect(cart.pending()?.reserved).toBe(true);
		clock.t = 41 * 60_000;
		expect(cart.pending()).toEqual({ email: "", reserved: false });
	});

	it("matches the email, or finds the key whatever the email with anyEmail", async () => {
		const { cart } = setup([ok]);
		cart.add("a");
		await cart.checkout({ email: "x@example.com" });
		expect(cart.pending()).toBeNull();
		expect(cart.pending({ email: "x@example.com" })?.reserved).toBe(true);
		expect(cart.pending({ anyEmail: true })).toEqual({ email: "x@example.com", reserved: true });
	});

	it("is gone once the key is dropped or done() runs", async () => {
		const { cart } = setup([ok, fail("ORDER_CLOSED")]);
		cart.add("a");
		await cart.checkout();
		await cart.checkout();
		expect(cart.pending()).toBeNull();
		const b = setup([ok]);
		b.cart.add("a");
		await b.cart.checkout();
		b.cart.done();
		b.cart.add("a");
		expect(b.cart.pending()).toBeNull();
	});
});

describe("orderReference", () => {
	it("is the order id's last 8 characters, uppercased", () => {
		expect(orderReference("ord_0123456789abcdef0123456789abcdef")).toBe("89ABCDEF");
		expect(orderReference("01JABCDEFGHJKMNPQRSTvwxyz9")).toBe("STVWXYZ9");
		expect(orderReference("")).toBe("");
		expect(orderReference(undefined)).toBe("");
	});
});

describe("clickGuard (add to cart double-click)", () => {
	it("accepts the first click and ignores another within 500 ms", () => {
		let t = 0;
		const accept = clickGuard(500, () => t);
		expect(accept()).toBe(true);
		t = 120;
		expect(accept()).toBe(false);
		t = 499;
		expect(accept()).toBe(false);
		t = 700;
		expect(accept()).toBe(true);
	});
	it("a double-click adds one unit", () => {
		const { cart } = setup([]);
		let t = 0;
		const accept = clickGuard(500, () => t);
		const click = () => accept() && cart.add("a");
		click();
		t = 80;
		click();
		expect(cart.lines()).toEqual([{ productId: "a", qty: 1 }]);
	});
});

describe("a changed cart releases this browser's earlier open checkout (checkout/release)", () => {
	it("at Pay with different lines: releases the earlier key first, then checks out with a new key", async () => {
		const { cart, bodies } = setup([ok, { ok: true, released: true }, ok]);
		cart.add("a", 1);
		await cart.checkout();
		const first = bodies[0]!.key;
		cart.setQty("a", 2);
		await cart.checkout();
		expect(bodies).toHaveLength(3);
		expect(bodies[1]).toEqual({ key: first });
		expect(bodies[2]!.key).not.toBe(first);
	});
	it("paying again with the SAME lines releases nothing (the open checkout is reused)", async () => {
		const { cart, bodies } = setup([ok, ok]);
		cart.add("a", 1);
		await cart.checkout();
		await cart.checkout();
		expect(bodies).toHaveLength(2);
		expect(bodies[1]!.key).toBe(bodies[0]!.key);
	});
	it("an earlier checkout older than its 40 minutes is not released (it has ended)", async () => {
		const clock = { t: 1_000_000 };
		const { cart, bodies } = setup([ok, ok], clock);
		cart.add("a", 1);
		await cart.checkout();
		clock.t += 41 * 60_000;
		cart.setQty("a", 2);
		await cart.checkout();
		expect(bodies).toHaveLength(2);
	});
});

describe("hasOpenCheckout", () => {
	it("is true while a checkout this browser started is within its 40 minutes, false after", async () => {
		const clock = { t: 1_000_000 };
		const { cart } = setup([ok], clock);
		expect(cart.hasOpenCheckout()).toBe(false);
		cart.add("a", 1);
		await cart.checkout();
		cart.setQty("a", 2);
		expect(cart.hasOpenCheckout()).toBe(true);
		clock.t += 41 * 60_000;
		expect(cart.hasOpenCheckout()).toBe(false);
	});
});
