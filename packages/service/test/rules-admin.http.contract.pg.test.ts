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
});
