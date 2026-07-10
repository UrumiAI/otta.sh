import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

const PG = process.env.PG_CONNECTION_STRING;

interface JsonResponse {
	status: number;
	body: Record<string, unknown> | null;
}

describe.skipIf(PG === undefined)("HTTP product-commerce contract [live server, Postgres]", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startTestServer();
	});
	afterAll(async () => {
		await server.stop();
	});

	async function put(
		id: string,
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}/products/${id}/commerce`, {
			method: "PUT",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> | null };
	}

	function get(id: string): Promise<JsonResponse> {
		return fetch(`${server.baseUrl}/products/${id}/commerce`).then(async (res) => ({
			status: res.status,
			body: (await res.json()) as Record<string, unknown> | null,
		}));
	}

	function del(id: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
		return fetch(`${server.baseUrl}/products/${id}/commerce`, { method: "DELETE", headers }).then(
			async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }),
		);
	}

	test("PUT upserts a product_commerce row keyed by the CMS id (wire ⇄ port fidelity)", async () => {
		const res = await put(
			"prod-http-1",
			{
				sku: "SKU-H1",
				price: { amount: 1999, currency: "USD" },
				productKind: "physical",
			},
			{ "Idempotency-Key": "k1" },
		);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			productId: "prod-http-1",
			sku: "SKU-H1",
			price: { amount: 1999, currency: "USD" },
			productKind: "physical",
			active: false,
			deletedAt: null,
		});
	});

	test("replay with the same Idempotency-Key is a no-op returning the existing row unchanged", async () => {
		const first = await put(
			"prod-http-2",
			{ sku: "SKU-H2", price: { amount: 500, currency: "USD" } },
			{ "Idempotency-Key": "k2" },
		);
		const replay = await put(
			"prod-http-2",
			{ sku: "SKU-H2-CHANGED", price: { amount: 999999, currency: "USD" } },
			{ "Idempotency-Key": "k2" },
		);
		expect(replay.body).toEqual(first.body);
	});

	test("PUT on first creation with initialOnHand seeds inventory on_hand once", async () => {
		await put(
			"prod-http-3",
			{ sku: "SKU-H3", price: { amount: 100, currency: "USD" }, initialOnHand: 25 },
			{ "Idempotency-Key": "k3" },
		);
		expect(await server.onHand("SKU-H3")).toBe(25);

		// A later edit must not reseed even if it supplies a new figure.
		await put(
			"prod-http-3",
			{ price: { amount: 150, currency: "USD" }, initialOnHand: 999 },
			{ "Idempotency-Key": "k3b" },
		);
		expect(await server.onHand("SKU-H3")).toBe(25);
	});

	test("GET reads the row back; unknown product_id returns 200 with a null body (not purchasable, not a hard 404)", async () => {
		await put(
			"prod-http-4",
			{ sku: "SKU-H4", price: { amount: 250, currency: "USD" } },
			{ "Idempotency-Key": "k4" },
		);
		const found = await get("prod-http-4");
		expect(found.status).toBe(200);
		expect(found.body).toMatchObject({ productId: "prod-http-4", sku: "SKU-H4" });

		const missing = await get("does-not-exist");
		expect(missing.status).toBe(200);
		expect(missing.body).toBeNull();
	});

	test("DELETE soft-deletes: deletedAt set, active false, row retained (readable via GET)", async () => {
		await put(
			"prod-http-5",
			{ sku: "SKU-H5", price: { amount: 400, currency: "USD" } },
			{ "Idempotency-Key": "k5" },
		);
		const del1 = await del("prod-http-5", { "Idempotency-Key": "del-1" });
		expect(del1.status).toBe(200);
		expect(del1.body).toEqual({ ok: true });

		const read = await get("prod-http-5");
		expect(read.body).toMatchObject({ active: false, sku: "SKU-H5" });
		expect(read.body?.deletedAt).not.toBeNull();
	});

	test("PUT with a missing Idempotency-Key header returns 400", async () => {
		const res = await put("prod-http-6", { sku: "SKU-H6" });
		expect(res.status).toBe(400);
	});

	test("PUT with a schema-invalid body (bad currency) returns 400", async () => {
		const res = await put(
			"prod-http-7",
			{ price: { amount: 100, currency: "usd" } },
			{ "Idempotency-Key": "k7" },
		);
		expect(res.status).toBe(400);
	});

	test("DELETE with a missing Idempotency-Key header returns 400", async () => {
		const res = await del("prod-http-8");
		expect(res.status).toBe(400);
	});

	test("a priced row stranded without an inventory row is healed by retrying the save with initialOnHand (B1, Postgres)", async () => {
		// Simulate the stranded state review B1 flagged: the product upsert
		// committed (sku durably set) but no inventory row ever landed — here
		// by a first save that carried no stock figure.
		await put(
			"prod-http-b1",
			{ sku: "SKU-HB1", price: { amount: 300, currency: "USD" } },
			{ "Idempotency-Key": "kb1" },
		);
		expect(await server.onHand("SKU-HB1")).toBe(0);

		// The retried save (same idempotency key — the upsert replays as a
		// no-op) carries the stock figure; the always-attempt, create-if-absent
		// seed heals the missing inventory row.
		await put(
			"prod-http-b1",
			{ sku: "SKU-HB1", price: { amount: 300, currency: "USD" }, initialOnHand: 12 },
			{ "Idempotency-Key": "kb1" },
		);
		expect(await server.onHand("SKU-HB1")).toBe(12);

		// And a later save can still never clobber the live figure.
		await put("prod-http-b1", { initialOnHand: 999 }, { "Idempotency-Key": "kb1-later" });
		expect(await server.onHand("SKU-HB1")).toBe(12);
	});

	test("a stale sync PUT (older contentUpdatedAt) arriving after a newer one is a no-op over the wire (S1)", async () => {
		const newer = await put(
			"prod-http-s1",
			{
				sku: "SKU-HS1",
				price: { amount: 2000, currency: "USD" },
				contentUpdatedAt: "2026-07-10T02:00:00.000Z",
			},
			{ "Idempotency-Key": "ks1-newer" },
		);
		const stale = await put(
			"prod-http-s1",
			{ price: { amount: 1, currency: "USD" }, contentUpdatedAt: "2026-07-10T01:00:00.000Z" },
			{ "Idempotency-Key": "ks1-stale" },
		);
		expect(stale.status).toBe(200);
		expect(stale.body).toEqual(newer.body);

		const read = await get("prod-http-s1");
		expect(read.body).toMatchObject({ price: { amount: 2000, currency: "USD" } });
	});

	test("panel-style PUTs (no contentUpdatedAt) are last-writer-wins — the documented lost-update semantics (S1)", async () => {
		await put(
			"prod-http-s1b",
			{ sku: "SKU-HS1B", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "ks1b-1" },
		);
		// A second explicit merchant save (e.g. a slower tab finishing later)
		// overwrites — accepted and pinned deliberately: explicit human saves
		// carry no ordering watermark, so the last write wins.
		const second = await put(
			"prod-http-s1b",
			{ price: { amount: 200, currency: "USD" } },
			{ "Idempotency-Key": "ks1b-2" },
		);
		expect(second.body).toMatchObject({ price: { amount: 200, currency: "USD" } });
	});

	test("a malformed contentUpdatedAt (non-ISO / garbage high-sorting value) is a 400 and writes nothing (F1)", async () => {
		// The watermark feeds a raw lexicographic SQL comparison — a stored
		// "ZZZZ" would make every future legitimate sync a stale no-op forever
		// (panel saves preserve, never heal, the watermark).
		for (const bad of ["ZZZZ", "2026-07-10", "2026-07-10T02:00:00Z", "not-a-date", " "]) {
			const res = await put(
				"prod-http-f1",
				{ sku: "SKU-HF1", contentUpdatedAt: bad },
				{ "Idempotency-Key": `kf1-${bad}` },
			);
			expect(res.status, `contentUpdatedAt=${JSON.stringify(bad)}`).toBe(400);
		}
		// Nothing was minted by any of the rejected requests.
		const read = await get("prod-http-f1");
		expect(read.body).toBeNull();

		// The exact Date.toISOString() shape is accepted.
		const ok = await put(
			"prod-http-f1",
			{ sku: "SKU-HF1", contentUpdatedAt: "2026-07-10T02:00:00.000Z" },
			{ "Idempotency-Key": "kf1-ok" },
		);
		expect(ok.status).toBe(200);
	});

	test("two live products contending a SKU is a structured 409 SKU_TAKEN — nothing leaked (F2, Postgres)", async () => {
		await put(
			"prod-http-f2a",
			{ sku: "SKU-HF2", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kf2a" },
		);
		const conflict = await put("prod-http-f2b", { sku: "SKU-HF2" }, { "Idempotency-Key": "kf2b" });
		expect(conflict.status).toBe(409);
		expect(conflict.body).toEqual({ ok: false, error: "SKU_TAKEN", sku: "SKU-HF2" });
		// No internal message/stack/constraint detail leaks.
		expect(JSON.stringify(conflict.body)).not.toMatch(/constraint|violates|duplicate key/i);
		expect(conflict.body).not.toHaveProperty("stack");
		// No row was minted for the loser.
		const read = await get("prod-http-f2b");
		expect(read.body).toBeNull();

		// Soft-deleting the holder frees the sku — the same PUT now succeeds.
		await del("prod-http-f2a", { "Idempotency-Key": "kf2-del" });
		const retry = await put("prod-http-f2b", { sku: "SKU-HF2" }, { "Idempotency-Key": "kf2c" });
		expect(retry.status).toBe(200);
	});
});
