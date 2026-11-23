/** Per-buyer cap (hashed, salted, IPv6 /64) and the order page's Stripe lookup cooldown. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { ensureIpSalt } from "../src/settings.js";
import { buyerAddress } from "../src/util.js";
import { callRoute, linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

describe("buyerAddress", () => {
	it.each([
		["203.0.113.9", "203.0.113.9"],
		["::ffff:203.0.113.9", "203.0.113.9"],
		["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
		["2001:db8:1:2::1", "2001:db8:1:2::/64"],
		["2001:DB8:0001:0002:0:0:0:9", "2001:db8:1:2::/64"],
		["10.1.2.3", null],
		["172.20.0.1", null],
		["192.168.1.1", null],
		["127.0.0.1", null],
		["::1", null],
		["fe80::1", null],
		["fd00::1", null],
		["", null],
		["not an ip", null],
		["300.1.1.1", null],
		[null, null],
	])("%s -> %s", (ip, want) => expect(buyerAddress(ip as string | null)).toBe(want));
});

describe("per-buyer open-checkout cap", () => {
	const SALT = { _ipSalt: "a".repeat(64) };
	it("one buyer is capped; another buyer is not; the same /64 counts as one buyer", async () => {
		const s = await makeShop(nProducts(1, 50));
		s.kv.seedSettings({ ...SALT, maxOpenPerBuyer: 2 });
		const buy = (n: number, ip: string) =>
			placeOrder({ key: orderKey(n), lines: linesFor(1) }, s.ctx, { ip });
		expect((await buy(1, "2001:db8:1:2::10")).ok).toBe(true);
		expect((await buy(2, "2001:db8:1:2::99")).ok).toBe(true);
		expect(await buy(3, "2001:db8:1:2:ffff::1")).toMatchObject({ ok: false, code: "BUSY_BUYER" });
		expect((await buy(4, "203.0.113.9")).ok).toBe(true);
		// A retry of an existing order is never refused by the cap.
		expect((await buy(1, "2001:db8:1:2::10")).ok).toBe(true);
	});
	it("stores a salted tag, never the address", async () => {
		const s = await makeShop(nProducts(1, 50));
		s.kv.seedSettings(SALT);
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx, { ip: "203.0.113.9" });
		const raw = JSON.stringify(await s.raw("orders").get(orderKey(1)));
		expect(raw).not.toContain("203.0.113");
		expect((await s.order(orderKey(1))).ipTag).toMatch(/^[0-9a-f]{16}$/);
	});
	it("no public address: the per-buyer cap is skipped (global cap only)", async () => {
		const s = await makeShop(nProducts(1, 50));
		s.kv.seedSettings({ ...SALT, maxOpenPerBuyer: 1 });
		for (const n of [1, 2])
			expect(
				(await placeOrder({ key: orderKey(n), lines: linesFor(1) }, s.ctx, { ip: "10.0.0.1" })).ok,
			).toBe(true);
		expect((await s.order(orderKey(1))).ipTag).toBeNull();
	});
	it("an install with no secret yet creates it on its first checkout, then tags buyers", async () => {
		const s = await makeShop(nProducts(1, 50));
		await s.ctx.kv.delete("settings:_ipSalt");
		s.kv.seedSettings({ maxOpenPerBuyer: 1 });
		expect(
			(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx, { ip: "203.0.113.9" })).ok,
		).toBe(true);
		expect(s.kv.dump()["settings:_ipSalt"]).toMatch(/^[0-9a-f]{64}$/);
		expect((await s.order(orderKey(1))).ipTag).toMatch(/^[0-9a-f]{16}$/);
		expect(
			await placeOrder({ key: orderKey(2), lines: linesFor(1) }, s.ctx, { ip: "203.0.113.9" }),
		).toMatchObject({ code: "BUSY_BUYER" });
	});
	it("ensureIpSalt creates the salt once and never replaces it", async () => {
		const s = await makeShop([]);
		await ensureIpSalt(s.ctx);
		const a = s.kv.dump()["settings:_ipSalt"];
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		await ensureIpSalt(s.ctx);
		expect(s.kv.dump()["settings:_ipSalt"]).toBe(a);
	});
});

describe("order page: at most one Stripe lookup per order per cooldown", () => {
	it("polling within the cooldown does not reach Stripe again", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const key = (await s.order(orderKey(1))).orderKey;
		const gets = () => s.http.requests.filter((q) => q.method === "GET").length;
		const before = gets();
		for (let i = 0; i < 5; i++) await callRoute(s.ctx, "order", { id: orderKey(1), key });
		expect(gets() - before).toBe(1);
	});
});
