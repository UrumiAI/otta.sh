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

		// Zone LWW edit — `regions` is a REQUIRED full-replace field.
		const zoneUpd = await send("PUT", "/shipping/zones/z-us", {
			name: "United States",
			regions: ["US", "PR"],
		});
		expect(zoneUpd.status).toBe(200);
		expect(((await json(zoneUpd)).zone as Record<string, unknown>).name).toBe("United States");

		// Deleting a zone with a method is refused (409 IN_USE_BY_METHODS).
		const zoneDel = await send("DELETE", "/shipping/zones/z-us");
		expect(zoneDel.status).toBe(409);
		expect((await json(zoneDel)).reason).toBe("IN_USE_BY_METHODS");

		// Rate CAS: correct expected wins (200); a stale expected is 409 STALE.
		const okUpd = await send("PUT", "/shipping/methods/m/rates/USD", {
			amountCents: 699,
			minSubtotalCents: null,
			expectedAmountCents: 599,
		});
		expect(okUpd.status).toBe(200);
		expect((await json(okUpd)).ok).toBe(true);
		const stale = await send("PUT", "/shipping/methods/m/rates/USD", {
			amountCents: 799,
			minSubtotalCents: null,
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

		const ok = await send("PUT", "/tax/rates/t1", {
			rateBps: 825,
			appliesToShipping: false,
			expectedRateBps: 725,
		});
		expect(ok.status).toBe(200);
		expect(((await json(ok)).rate as Record<string, unknown>).rateBps).toBe(825);
		const stale = await send("PUT", "/tax/rates/t1", {
			rateBps: 900,
			appliesToShipping: false,
			expectedRateBps: 725,
		});
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

	test("full-replace updates 400 on an OMITTED required field and write nothing (reviewer B finding 1)", async () => {
		await post("/shipping/zones", { id: "z-req", name: "US", regions: ["US"] });
		await post("/shipping/zones/z-req/methods", { id: "m-req", name: "Flat", type: "flat_rate" });
		await post("/shipping/methods/m-req/rates", {
			currency: "USD",
			amountCents: 599,
			minSubtotalCents: 5000,
		});
		await post("/tax/classes", { id: "std-req", name: "Standard" });
		await post("/tax/rates", {
			id: "t-req",
			taxClassId: "std-req",
			zoneId: "z-req",
			rateBps: 725,
			appliesToShipping: true,
		});

		// Omitted `regions` must be a 400 — never a silent wipe-to-null.
		expect((await send("PUT", "/shipping/zones/z-req", { name: "Renamed" })).status).toBe(400);
		const zone = (await json(await get("/shipping/zones"))).zones as Array<Record<string, unknown>>;
		const zreq = zone.find((z) => z.id === "z-req");
		expect(zreq?.name).toBe("US"); // nothing written
		expect(zreq?.regions).toEqual(["US"]); // regions NOT wiped

		// Omitted `minSubtotalCents` must be a 400 — never a silent threshold clear.
		expect(
			(
				await send("PUT", "/shipping/methods/m-req/rates/USD", {
					amountCents: 699,
					expectedAmountCents: 599,
				})
			).status,
		).toBe(400);
		const rate = (await json(await get("/shipping/methods/m-req/rates?currency=USD")))
			.rate as Record<string, unknown>;
		expect(rate.amountCents).toBe(599); // nothing written
		expect(rate.minSubtotalCents).toBe(5000); // threshold NOT cleared

		// Omitted `appliesToShipping` must be a 400 — never a silent flip to false.
		expect(
			(await send("PUT", "/tax/rates/t-req", { rateBps: 825, expectedRateBps: 725 })).status,
		).toBe(400);
		const rates = (await json(await get("/tax/rates?zoneId=z-req"))).rates as Array<
			Record<string, unknown>
		>;
		expect(rates[0]?.rateBps).toBe(725); // nothing written
		expect(rates[0]?.appliesToShipping).toBe(true); // flag NOT flipped
	});

	test("UPDATE/DELETE without the internal token are rejected 401", async () => {
		await post("/shipping/zones", { id: "z-guard", name: "Z" });
		expect((await send("PUT", "/shipping/zones/z-guard", { name: "X" }, false)).status).toBe(401);
		expect((await send("DELETE", "/shipping/zones/z-guard", undefined, false)).status).toBe(401);
	});

	// -- Increment 3 closeout: tax-class rename/delete wiring -----------------

	test("tax class: rename (LWW) round-trips; unknown id is 404", async () => {
		await post("/tax/classes", { id: "reduced", name: "Reduced" });
		const upd = await send("PUT", "/tax/classes/reduced", { name: "Reduced rate" });
		expect(upd.status).toBe(200);
		const cls = (await json(upd)).taxClass as Record<string, unknown>;
		expect(cls).toEqual({ id: "reduced", name: "Reduced rate" });
		const classes = (await json(await get("/tax/classes"))).classes as Array<
			Record<string, unknown>
		>;
		expect(classes.find((c) => c.id === "reduced")?.name).toBe("Reduced rate");

		expect((await send("PUT", "/tax/classes/missing", { name: "X" })).status).toBe(404);
	});

	test("tax class: a rename never orphans an existing rate (still resolves by id)", async () => {
		await post("/tax/classes", { id: "std-rn", name: "Standard" });
		await post("/tax/rates", { id: "t-rn", taxClassId: "std-rn", zoneId: "z-rn", rateBps: 725 });
		expect((await send("PUT", "/tax/classes/std-rn", { name: "Standard renamed" })).status).toBe(
			200,
		);
		const rates = (await json(await get("/tax/rates?zoneId=z-rn"))).rates as Array<
			Record<string, unknown>
		>;
		expect(rates[0]?.taxClassId).toBe("std-rn");
		expect(rates[0]?.rateBps).toBe(725);
	});

	test("tax class: delete succeeds once unreferenced; idempotent 404 after; unknown id is 404", async () => {
		await post("/tax/classes", { id: "temp-del", name: "Temp" });
		expect((await send("DELETE", "/tax/classes/temp-del")).status).toBe(200);
		expect((await send("DELETE", "/tax/classes/temp-del")).status).toBe(404);
		expect((await send("DELETE", "/tax/classes/never-existed")).status).toBe(404);
	});

	test("tax class: delete is refused 409 with an honest count while a PRODUCT references it", async () => {
		await post("/tax/classes", { id: "prod-ref", name: "Product referenced" });
		await server.seedProductRow({
			id: "p-tax-ref",
			sku: "SKU-TAXREF",
			priceCents: 1000,
			createdAt: "2026-07-10T00:00:00.000Z",
			taxClass: "prod-ref",
		});
		const del = await send("DELETE", "/tax/classes/prod-ref");
		expect(del.status).toBe(409);
		const body = await json(del);
		expect(body.reason).toBe("IN_USE_BY_PRODUCTS");
		expect(body.count).toBe(1);
	});

	test("tax class: delete is refused 409 with an honest count while a RATE references it", async () => {
		await post("/tax/classes", { id: "rate-ref", name: "Rate referenced" });
		await post("/tax/rates", {
			id: "t-ref-1",
			taxClassId: "rate-ref",
			zoneId: "z-a",
			rateBps: 500,
		});
		await post("/tax/rates", {
			id: "t-ref-2",
			taxClassId: "rate-ref",
			zoneId: "z-b",
			rateBps: 700,
		});
		const del = await send("DELETE", "/tax/classes/rate-ref");
		expect(del.status).toBe(409);
		const body = await json(del);
		expect(body.reason).toBe("IN_USE_BY_RATES");
		expect(body.count).toBe(2);
		// The class survives the refused delete.
		const classes = (await json(await get("/tax/classes"))).classes as Array<
			Record<string, unknown>
		>;
		expect(classes.some((c) => c.id === "rate-ref")).toBe(true);
	});

	test("tax class UPDATE/DELETE without the internal token are rejected 401", async () => {
		await post("/tax/classes", { id: "tc-guard", name: "Guard" });
		expect((await send("PUT", "/tax/classes/tc-guard", { name: "X" }, false)).status).toBe(401);
		expect((await send("DELETE", "/tax/classes/tc-guard", undefined, false)).status).toBe(401);
	});

	// -- Increment 3 closeout: coupon blank-economics server-side guard -------

	test("coupon update: a fixed_amount coupon cannot be updated with a null amountCents (400, nothing written)", async () => {
		await post("/coupons", {
			id: "cpn-fixed",
			code: "FIXED10",
			type: "fixed_amount",
			amountCents: 1000,
			currency: "USD",
		});
		const res = await send("PUT", "/coupons/cpn-fixed", { amountCents: null, maxUses: 5 });
		expect(res.status).toBe(400);
		const coupon = (await json(await get("/coupons/FIXED10"))).coupon as Record<string, unknown>;
		expect(coupon.amountCents).toBe(1000); // nothing written
		expect(coupon.maxUses).toBeNull(); // nothing written
	});

	test("coupon update: a percentage coupon cannot be updated with a null rateBps (400, nothing written)", async () => {
		await post("/coupons", {
			id: "cpn-pct",
			code: "PCT10",
			type: "percentage",
			rateBps: 1000,
		});
		const res = await send("PUT", "/coupons/cpn-pct", { rateBps: null, capCents: 500 });
		expect(res.status).toBe(400);
		const coupon = (await json(await get("/coupons/PCT10"))).coupon as Record<string, unknown>;
		expect(coupon.rateBps).toBe(1000); // nothing written
		expect(coupon.capCents).toBeNull(); // nothing written
	});

	test("coupon update: omitting the OTHER type's field is fine (only the owning type's blank is guarded)", async () => {
		await post("/coupons", {
			id: "cpn-fixed-2",
			code: "FIXED20",
			type: "fixed_amount",
			amountCents: 2000,
			currency: "USD",
		});
		// amountCents present and non-null; rateBps absent (irrelevant to fixed_amount).
		const res = await send("PUT", "/coupons/cpn-fixed-2", { amountCents: 2500 });
		expect(res.status).toBe(200);
		const coupon = (await json(await get("/coupons/FIXED20"))).coupon as Record<string, unknown>;
		expect(coupon.amountCents).toBe(2500);
	});

	test("coupon update: an unknown couponId is still 404 (fetch-then-validate doesn't change the not_found case)", async () => {
		expect((await send("PUT", "/coupons/does-not-exist", { amountCents: 100 })).status).toBe(404);
	});
});
