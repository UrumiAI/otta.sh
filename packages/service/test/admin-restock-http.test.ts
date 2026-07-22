import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Merchant restock / stock removal (admin-UX Increment 2, slice 3): wire ⇄ port
// fidelity for POST /admin/products/:id/restock and /remove-stock against a LIVE
// server backed by Postgres. Pins the productId → authoritative-sku resolution,
// the additive-restock + guarded-removal semantics, the required Idempotency-Key
// (an additive op has no safe content-only fallback), and the double-gate auth.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin restock / remove-stock HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	async function seedProduct(id: string, onHand: number, sku = `SKU-${id}`): Promise<string> {
		await server.seedProductRow({
			id,
			sku,
			title: "Widget",
			priceCents: 1000,
			currency: "USD",
			productKind: "physical",
			active: true,
			createdAt: "2026-07-10T01:00:00.000Z",
		});
		await server.seed(sku, onHand);
		return sku;
	}

	function post(
		id: string,
		verb: "restock" | "remove-stock",
		body: unknown,
		opts: { token?: string | null; idempotencyKey?: string | null } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		const tok = opts.token === undefined ? token : opts.token;
		if (tok !== null) headers["X-Internal-Token"] = tok;
		const key = opts.idempotencyKey === undefined ? "key-1" : opts.idempotencyKey;
		if (key !== null) headers["Idempotency-Key"] = key;
		return fetch(`${server.baseUrl}/admin/products/${id}/${verb}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	}

	test("restock adds units and returns the new on_hand", async () => {
		const sku = await seedProduct("prod-1", 5);
		const res = await post("prod-1", "restock", { qty: 8 });
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ ok: true, onHand: 13 });
		expect(await server.onHand(sku)).toBe(13);
	});

	test("a same-Idempotency-Key restock replay adds the units exactly once", async () => {
		const sku = await seedProduct("prod-1", 5);
		const first = await post("prod-1", "restock", { qty: 8 }, { idempotencyKey: "rk-1" });
		const replay = await post("prod-1", "restock", { qty: 8 }, { idempotencyKey: "rk-1" });
		expect(first.status).toBe(200);
		expect(replay.status).toBe(200);
		expect(await json(replay)).toEqual({ ok: true, onHand: 13 });
		expect(await server.onHand(sku)).toBe(13); // added once, not twice
	});

	test("remove-stock removes units down to the guarded floor", async () => {
		const sku = await seedProduct("prod-1", 5);
		const res = await post("prod-1", "remove-stock", { qty: 2 });
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ ok: true, onHand: 3 });
		expect(await server.onHand(sku)).toBe(3);
	});

	test("remove-stock beyond available is a 409 INSUFFICIENT_STOCK carrying the current count, never negative", async () => {
		const sku = await seedProduct("prod-1", 3);
		const res = await post("prod-1", "remove-stock", { qty: 5 });
		expect(res.status).toBe(409);
		expect(await json(res)).toEqual({ ok: false, reason: "INSUFFICIENT_STOCK", onHand: 3 });
		expect(await server.onHand(sku)).toBe(3); // untouched
	});

	test("a missing Idempotency-Key is a 400 (an additive op has no safe fallback)", async () => {
		await seedProduct("prod-1", 5);
		const res = await post("prod-1", "restock", { qty: 8 }, { idempotencyKey: null });
		expect(res.status).toBe(400);
		expect((await json(res)).reason).toBe("MISSING_IDEMPOTENCY_KEY");
	});

	test("a non-positive / non-integer qty is a 400", async () => {
		await seedProduct("prod-1", 5);
		expect((await post("prod-1", "restock", { qty: 0 })).status).toBe(400);
		expect((await post("prod-1", "restock", { qty: -3 })).status).toBe(400);
		expect((await post("prod-1", "restock", { qty: 1.5 })).status).toBe(400);
	});

	test("restock on an unknown product is a 404", async () => {
		const res = await post("ghost", "restock", { qty: 1 });
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("PRODUCT_NOT_FOUND");
	});

	test("restock on a priced-but-unseeded product (no inventory row) is a 409 NO_INVENTORY_ROW", async () => {
		// A product_commerce row with a sku but NO inventory row (stock never
		// seeded). A stock movement cannot create the row — clean 409.
		await server.seedProductRow({
			id: "prod-unseeded",
			sku: "SKU-unseeded",
			title: "Unseeded",
			priceCents: 1000,
			currency: "USD",
			createdAt: "2026-07-10T01:00:00.000Z",
		});
		const res = await post("prod-unseeded", "restock", { qty: 5 });
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("NO_INVENTORY_ROW");
	});

	test("a product with no sku (create-then-price) is a 409 NO_SKU", async () => {
		await server.seedProductRow({
			id: "prod-noskued",
			sku: null,
			title: "Skuless",
			createdAt: "2026-07-10T01:00:00.000Z",
		});
		const res = await post("prod-noskued", "restock", { qty: 5 });
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("NO_SKU");
	});

	test("guard: no admin token ⇒ 401", async () => {
		await seedProduct("prod-1", 5);
		const res = await post("prod-1", "restock", { qty: 1 }, { token: null });
		expect(res.status).toBe(401);
	});

	test("the write gate blocks a restock with no X-Service-Token when the service secret is set", async () => {
		const gated = await startTestServer({ serviceToken: "svc-secret" });
		try {
			const res = await fetch(`${gated.baseUrl}/admin/products/prod-1/restock`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Token": gated.internalToken as string,
					"Idempotency-Key": "k",
				},
				body: JSON.stringify({ qty: 1 }),
			});
			expect([401, 403]).toContain(res.status);
		} finally {
			await gated.stop();
		}
	});
});
