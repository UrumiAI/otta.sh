import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Phase 6: thin pass/fail contract for the shipping/tax/coupon admin CRUD —
// 1:1 store reflections, so a create-then-read per resource plus an auth guard.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("rules admin CRUD HTTP contract", () => {
	let server: TestServer;
	let token: string;
	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	function post(path: string, body: unknown, withToken = true): Promise<Response> {
		return fetch(`${server.baseUrl}/admin${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(withToken ? { "X-Internal-Token": token } : {}),
			},
			body: JSON.stringify(body),
		});
	}
	function get(path: string): Promise<Response> {
		return fetch(`${server.baseUrl}/admin${path}`, { headers: { "X-Internal-Token": token } });
	}
	function send(method: string, path: string, body?: unknown, withToken = true): Promise<Response> {
		return fetch(`${server.baseUrl}/admin${path}`, {
			method,
			headers: {
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(withToken ? { "X-Internal-Token": token } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	}

	test("shipping: create zone → method → rate, then read back", async () => {
		expect((await post("/shipping/zones", { id: "z-us", name: "US" })).status).toBe(201);
		expect(
			(await post("/shipping/zones/z-us/methods", { id: "m", name: "Flat", type: "flat_rate" }))
				.status,
		).toBe(201);
		expect(
			(await post("/shipping/methods/m/rates", { currency: "USD", amountCents: 599 })).status,
		).toBe(201);

		const zones = await json(await get("/shipping/zones"));
		expect((zones.zones as unknown[]).length).toBe(1);
		const methods = await json(await get("/shipping/zones/z-us/methods"));
		expect((methods.methods as unknown[]).length).toBe(1);
		const rate = await json(await get("/shipping/methods/m/rates?currency=USD"));
		expect((rate.rate as Record<string, unknown>).amountCents).toBe(599);
	});

	test("tax: create class + rate, then read by zone", async () => {
		expect((await post("/tax/classes", { id: "standard", name: "Standard" })).status).toBe(201);
		expect(
			(await post("/tax/rates", { id: "t1", taxClassId: "standard", zoneId: "z-us", rateBps: 725 }))
				.status,
		).toBe(201);
		const classes = await json(await get("/tax/classes"));
		expect((classes.classes as unknown[]).length).toBe(1);
		const rates = await json(await get("/tax/rates?zoneId=z-us"));
		expect((rates.rates as Array<Record<string, unknown>>)[0]?.rateBps).toBe(725);
	});

	test("coupons: create + read by code round-trips money fields", async () => {
		expect(
			(
				await post("/coupons", {
					id: "cpn",
					code: "SAVE5",
					type: "fixed_amount",
					amountCents: 500,
					currency: "USD",
					maxUses: 10,
				})
			).status,
		).toBe(201);
		const coupon = await json(await get("/coupons/SAVE5"));
		const c = coupon.coupon as Record<string, unknown>;
		expect(c.amountCents).toBe(500);
		expect(c.usesCount).toBe(0);
		expect((await get("/coupons/NOPE")).status).toBe(404);
	});

	test("writes without the internal token are rejected 401", async () => {
		const res = await post("/shipping/zones", { id: "z", name: "Z" }, false);
		expect(res.status).toBe(401);
	});

	// -- UPDATE/DELETE (admin-UX Increment 3) ----------------------------------

	test("shipping: update zone (LWW), CAS-update rate, and referential delete guards", async () => {
		await post("/shipping/zones", { id: "z-us", name: "US" });
		await post("/shipping/zones/z-us/methods", { id: "m", name: "Flat", type: "flat_rate" });
		await post("/shipping/methods/m/rates", { currency: "USD", amountCents: 599 });

		// Zone LWW edit.
		const zoneUpd = await send("PUT", "/shipping/zones/z-us", { name: "United States" });
		expect(zoneUpd.status).toBe(200);
		expect(((await json(zoneUpd)).zone as Record<string, unknown>).name).toBe("United States");

		// Deleting a zone with a method is refused (409 IN_USE_BY_METHODS).
		const zoneDel = await send("DELETE", "/shipping/zones/z-us");
		expect(zoneDel.status).toBe(409);
		expect((await json(zoneDel)).reason).toBe("IN_USE_BY_METHODS");

		// Rate CAS: correct expected wins (200); a stale expected is 409 STALE.
		const okUpd = await send("PUT", "/shipping/methods/m/rates/USD", {
			amountCents: 699,
			expectedAmountCents: 599,
		});
		expect(okUpd.status).toBe(200);
		expect((await json(okUpd)).ok).toBe(true);
		const stale = await send("PUT", "/shipping/methods/m/rates/USD", {
			amountCents: 799,
			expectedAmountCents: 599, // still the old value
		});
		expect(stale.status).toBe(409);
		const staleBody = await json(stale);
		expect(staleBody.reason).toBe("STALE");
		expect((staleBody.current as Record<string, unknown>).amountCents).toBe(699);

		// Leaf rate delete, then a method delete now succeeds; deletes are idempotent.
		expect((await send("DELETE", "/shipping/methods/m/rates/USD")).status).toBe(200);
		expect((await send("DELETE", "/shipping/methods/m/rates/USD")).status).toBe(404);
		expect((await send("DELETE", "/shipping/methods/m")).status).toBe(200);
		expect((await send("DELETE", "/shipping/zones/z-us")).status).toBe(200);
	});

	test("tax: CAS-update rate (stale ⇒ 409) and leaf delete (idempotent 404)", async () => {
		await post("/tax/classes", { id: "standard", name: "Standard" });
		await post("/tax/rates", { id: "t1", taxClassId: "standard", zoneId: "z-us", rateBps: 725 });

		const ok = await send("PUT", "/tax/rates/t1", { rateBps: 825, expectedRateBps: 725 });
		expect(ok.status).toBe(200);
		expect(((await json(ok)).rate as Record<string, unknown>).rateBps).toBe(825);
		const stale = await send("PUT", "/tax/rates/t1", { rateBps: 900, expectedRateBps: 725 });
		expect(stale.status).toBe(409);
		expect((await json(stale)).reason).toBe("STALE");

		expect((await send("DELETE", "/tax/rates/t1")).status).toBe(200);
		expect((await send("DELETE", "/tax/rates/t1")).status).toBe(404);
	});

	test("coupons: update (LWW) and forbid-if-... delete semantics", async () => {
		await post("/coupons", {
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
			maxUses: 10,
		});
		const upd = await send("PUT", "/coupons/cpn", { amountCents: 750, maxUses: 20 });
		expect(upd.status).toBe(200);
		const c = (await json(upd)).coupon as Record<string, unknown>;
		expect(c.amountCents).toBe(750);
		expect(c.code).toBe("SAVE5"); // identity preserved

		expect((await send("PUT", "/coupons/missing", { amountCents: 1 })).status).toBe(404);
		// Unredeemed coupon deletes; replay is an idempotent 404.
		expect((await send("DELETE", "/coupons/cpn")).status).toBe(200);
		expect((await send("DELETE", "/coupons/cpn")).status).toBe(404);
	});

	test("UPDATE/DELETE without the internal token are rejected 401", async () => {
		await post("/shipping/zones", { id: "z-guard", name: "Z" });
		expect((await send("PUT", "/shipping/zones/z-guard", { name: "X" }, false)).status).toBe(401);
		expect((await send("DELETE", "/shipping/zones/z-guard", undefined, false)).status).toBe(401);
	});
});
