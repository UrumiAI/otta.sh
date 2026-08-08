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

	// Default publish-gate watermark for lifecycle cases whose intent is NOT
	// ordering; convergence cases below pass explicit distinct timestamps.
	const WM = "2026-07-11T00:00:00.000Z";

	function activate(
		id: string,
		headers: Record<string, string> = {},
		contentUpdatedAt: string = WM,
	): Promise<JsonResponse> {
		return fetch(`${server.baseUrl}/products/${id}/commerce/activate`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ contentUpdatedAt }),
		}).then(async (res) => ({
			status: res.status,
			body: (await res.json()) as Record<string, unknown>,
		}));
	}

	function deactivate(
		id: string,
		headers: Record<string, string> = {},
		contentUpdatedAt: string = WM,
	): Promise<JsonResponse> {
		return fetch(`${server.baseUrl}/products/${id}/commerce/deactivate`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ contentUpdatedAt }),
		}).then(async (res) => ({
			status: res.status,
			body: (await res.json()) as Record<string, unknown>,
		}));
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

	test("a save carrying a sku but NO stock figure still creates the inventory row at 0 (PR 1a, Postgres)", async () => {
		// PR 1a: the invariant is "a product with a sku has an inventory row",
		// so this path can no longer mint a sku with nothing behind it — the
		// stranded state this test used to construct is now unreachable here.
		await put(
			"prod-http-b1",
			{ sku: "SKU-HB1", price: { amount: 300, currency: "USD" } },
			{ "Idempotency-Key": "kb1" },
		);
		expect(await server.onHand("SKU-HB1")).toBe(0);

		// `onHand` reads a MISSING row as 0 too, so that assertion alone proves
		// nothing. Restock never auto-creates a row, so a successful restock is
		// the real proof the row exists — and this exact call was a 409
		// NO_INVENTORY_ROW before 1a.
		const restocked = await fetch(`${server.baseUrl}/admin/products/prod-http-b1/restock`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Internal-Token": server.internalToken as string,
				"Idempotency-Key": "kb1-restock",
			},
			body: JSON.stringify({ qty: 4 }),
		});
		expect(restocked.status).toBe(200);
		expect(await server.onHand("SKU-HB1")).toBe(4);

		// And because the seed is create-if-absent, a LATER save's initialOnHand
		// is silently discarded rather than clobbering the live count — in either
		// direction. (Before 1a this same call healed a stranded row to 12.)
		await put(
			"prod-http-b1",
			{ sku: "SKU-HB1", price: { amount: 300, currency: "USD" }, initialOnHand: 12 },
			{ "Idempotency-Key": "kb1" },
		);
		expect(await server.onHand("SKU-HB1")).toBe(4);
		await put("prod-http-b1", { initialOnHand: 999 }, { "Idempotency-Key": "kb1-later" });
		expect(await server.onHand("SKU-HB1")).toBe(4);
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

	// -- the two RENAME refusals, on the integrator's own upsert ---------------
	// The sync PUT can rename a sku exactly as the admin edit can, so it meets the
	// same two refusals and answers them in this route's own envelope (`error`,
	// beside `SKU_TAKEN`) rather than falling through to an opaque 500.

	test("a rename ONTO an occupied inventory sku is a structured 409 SKU_STOCK_CONFLICT — nothing leaked, nothing moved", async () => {
		await put(
			"prod-http-f3",
			{ sku: "SKU-HF3", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kf3a" },
		);
		await server.seed("SKU-HF3", 7);
		// An inventory row under no live product: what a sku renamed away from
		// leaves behind (retained at zero), or a deleted product's sku.
		await server.seed("SKU-HF3-TAKEN", 2);

		const refused = await put(
			"prod-http-f3",
			{ sku: "SKU-HF3-TAKEN" },
			{ "Idempotency-Key": "kf3b" },
		);
		expect(refused.status).toBe(409);
		expect(refused.body).toEqual({
			ok: false,
			error: "SKU_STOCK_CONFLICT",
			fromSku: "SKU-HF3",
			toSku: "SKU-HF3-TAKEN",
		});
		expect(refused.body).not.toHaveProperty("stack");
		expect(JSON.stringify(refused.body)).not.toMatch(
			/constraint|violates|duplicate key|inventory|reservation|SkuStockConflict|SkuHeldStock|\.ts:/i,
		);

		// The rename and the carry are one transaction: the product still holds its
		// sku, and neither count moved by a unit.
		expect((await get("prod-http-f3")).body).toMatchObject({ sku: "SKU-HF3" });
		expect(await server.onHand("SKU-HF3")).toBe(7);
		expect(await server.onHand("SKU-HF3-TAKEN")).toBe(2);
	});

	test("a rename with LIVE HOLDS against the source is a structured 409 SKU_HELD_STOCK carrying the count", async () => {
		await put(
			"prod-http-f4",
			{ sku: "SKU-HF4", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kf4a" },
		);
		await server.seed("SKU-HF4", 9);
		const reserved = await fetch(`${server.baseUrl}/inventory/reserve`, {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "kf4-hold" },
			body: JSON.stringify({ sku: "SKU-HF4", qty: 3 }),
		});
		expect(reserved.status).toBe(200);

		const refused = await put(
			"prod-http-f4",
			{ sku: "SKU-HF4-NEW" },
			{ "Idempotency-Key": "kf4b" },
		);
		expect(refused.status).toBe(409);
		expect(refused.body).toEqual({
			ok: false,
			error: "SKU_HELD_STOCK",
			sku: "SKU-HF4",
			liveHolds: 1,
		});
		expect(refused.body).not.toHaveProperty("stack");

		expect((await get("prod-http-f4")).body).toMatchObject({ sku: "SKU-HF4" });
		// The hold's units are already out of on_hand and stay out of it.
		expect(await server.onHand("SKU-HF4")).toBe(6);
	});

	// -- POST /products/:id/commerce/activate (the afterPublish→activate follow-up) --

	test("POST .../commerce/activate flips a row to active=true", async () => {
		await put(
			"prod-http-act1",
			{ sku: "SKU-HACT1", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kact1" },
		);
		const res = await activate("prod-http-act1", { "Idempotency-Key": "pub-1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });

		const read = await get("prod-http-act1");
		expect(read.body).toMatchObject({ active: true, sku: "SKU-HACT1" });
	});

	test("POST .../commerce/activate replayed (or called on an already-active row) is a stable no-op", async () => {
		await put(
			"prod-http-act2",
			{ sku: "SKU-HACT2", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kact2" },
		);
		await activate("prod-http-act2", { "Idempotency-Key": "pub-1" });
		const first = await get("prod-http-act2");

		await activate("prod-http-act2", { "Idempotency-Key": "pub-2" });
		const again = await get("prod-http-act2");

		expect(again.body).toMatchObject({ active: true });
		expect(again.body?.["updatedAt"]).toBe(first.body?.["updatedAt"]);
	});

	test("POST .../commerce/activate on a SOFT-DELETED product does NOT resurrect it", async () => {
		await put(
			"prod-http-act3",
			{ sku: "SKU-HACT3", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kact3" },
		);
		await del("prod-http-act3", { "Idempotency-Key": "del-1" });

		const res = await activate("prod-http-act3", { "Idempotency-Key": "pub-1" });
		expect(res.status).toBe(200); // fire-and-forget action route: never a hard error

		const read = await get("prod-http-act3");
		expect(read.body).toMatchObject({ active: false });
		expect(read.body?.["deletedAt"]).not.toBeNull();
	});

	test("POST .../commerce/activate on an unknown product_id is a no-op (200, no row minted)", async () => {
		const res = await activate("prod-http-act-unknown", { "Idempotency-Key": "pub-1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		const read = await get("prod-http-act-unknown");
		expect(read.body).toBeNull();
	});

	test("POST .../commerce/activate with a missing Idempotency-Key header returns 400", async () => {
		const res = await activate("prod-http-act4");
		expect(res.status).toBe(400);
	});

	// -- honest end-to-end wire proof: unpublished stays inactive -----------

	test("a saved (priced) product that is never activated stays inactive over the wire", async () => {
		await put(
			"prod-http-act5",
			{ sku: "SKU-HACT5", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kact5" },
		);
		const read = await get("prod-http-act5");
		expect(read.body).toMatchObject({ active: false });
	});

	// -- POST /products/:id/commerce/deactivate (the afterUnpublish→deactivate follow-up) --

	test("POST .../commerce/deactivate flips an active row back to active=false", async () => {
		await put(
			"prod-http-deact1",
			{ sku: "SKU-HDEACT1", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kdeact1" },
		);
		await activate("prod-http-deact1", { "Idempotency-Key": "pub-1" });
		expect((await get("prod-http-deact1")).body).toMatchObject({ active: true });

		const res = await deactivate("prod-http-deact1", { "Idempotency-Key": "unpub-1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });

		const read = await get("prod-http-deact1");
		// The publish gate closes; the row stays live (not soft-deleted).
		expect(read.body).toMatchObject({ active: false, sku: "SKU-HDEACT1" });
		expect(read.body?.["deletedAt"]).toBeNull();
	});

	test("POST .../commerce/deactivate replayed (or on an already-inactive row) is a stable no-op", async () => {
		await put(
			"prod-http-deact2",
			{ sku: "SKU-HDEACT2", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kdeact2" },
		);
		await activate("prod-http-deact2", { "Idempotency-Key": "pub-1" });
		await deactivate("prod-http-deact2", { "Idempotency-Key": "unpub-1" });
		const first = await get("prod-http-deact2");

		await deactivate("prod-http-deact2", { "Idempotency-Key": "unpub-2" });
		const again = await get("prod-http-deact2");

		expect(again.body).toMatchObject({ active: false });
		expect(again.body?.["updatedAt"]).toBe(first.body?.["updatedAt"]);
	});

	test("POST .../commerce/deactivate on a SOFT-DELETED product leaves it soft-deleted", async () => {
		await put(
			"prod-http-deact3",
			{ sku: "SKU-HDEACT3", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kdeact3" },
		);
		await del("prod-http-deact3", { "Idempotency-Key": "del-1" });

		const res = await deactivate("prod-http-deact3", { "Idempotency-Key": "unpub-1" });
		expect(res.status).toBe(200); // fire-and-forget action route: never a hard error

		const read = await get("prod-http-deact3");
		expect(read.body).toMatchObject({ active: false });
		expect(read.body?.["deletedAt"]).not.toBeNull();
	});

	test("POST .../commerce/deactivate on an unknown product_id is a no-op (200, no row minted)", async () => {
		const res = await deactivate("prod-http-deact-unknown", { "Idempotency-Key": "unpub-1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true });
		const read = await get("prod-http-deact-unknown");
		expect(read.body).toBeNull();
	});

	test("POST .../commerce/deactivate with a missing Idempotency-Key header returns 400", async () => {
		const res = await deactivate("prod-http-deact4");
		expect(res.status).toBe(400);
	});

	// -- publish-gate convergence under out-of-order delivery (over the wire) --

	test("out-of-order over the wire: deactivate@T2 then a STALE activate@T1 leaves the product NON-purchasable (active=false)", async () => {
		const T1 = "2026-07-11T01:00:00.000Z";
		const T2 = "2026-07-11T02:00:00.000Z";
		const T3 = "2026-07-11T03:00:00.000Z";
		await put(
			"prod-http-conv1",
			{ sku: "SKU-HCONV1", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kconv1" },
		);
		// publish@T1 then unpublish@T2 applied in order → inactive.
		await activate("prod-http-conv1", { "Idempotency-Key": "pub-early" }, T1);
		await deactivate("prod-http-conv1", { "Idempotency-Key": "unpub-2" }, T2);
		expect((await get("prod-http-conv1")).body).toMatchObject({ active: false });

		// A DELAYED, re-ordered stale activate (older T1) must NOT re-latch it.
		const stale = await activate("prod-http-conv1", { "Idempotency-Key": "pub-1-late" }, T1);
		expect(stale.status).toBe(200);
		expect((await get("prod-http-conv1")).body).toMatchObject({ active: false });

		// A genuinely newer publish (T3 > T2) still wins — the gate advanced,
		// it is not stuck.
		await activate("prod-http-conv1", { "Idempotency-Key": "pub-3" }, T3);
		expect((await get("prod-http-conv1")).body).toMatchObject({ active: true });
	});

	test("out-of-order over the wire: activate@T2 then a STALE deactivate@T1 keeps the product active=true", async () => {
		const T1 = "2026-07-11T01:00:00.000Z";
		const T2 = "2026-07-11T02:00:00.000Z";
		await put(
			"prod-http-conv2",
			{ sku: "SKU-HCONV2", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kconv2" },
		);
		await deactivate("prod-http-conv2", { "Idempotency-Key": "unpub-early" }, T1);
		await activate("prod-http-conv2", { "Idempotency-Key": "pub-2" }, T2);
		expect((await get("prod-http-conv2")).body).toMatchObject({ active: true });

		const stale = await deactivate("prod-http-conv2", { "Idempotency-Key": "unpub-1-late" }, T1);
		expect(stale.status).toBe(200);
		expect((await get("prod-http-conv2")).body).toMatchObject({ active: true });
	});

	test("POST .../commerce/activate|deactivate with a missing/malformed contentUpdatedAt body is a 400 (F1 — the gate watermark must be exact)", async () => {
		await put(
			"prod-http-conv3",
			{ sku: "SKU-HCONV3", price: { amount: 100, currency: "USD" } },
			{ "Idempotency-Key": "kconv3" },
		);
		for (const bad of ["ZZZZ", "2026-07-11", "2026-07-11T02:00:00Z", "not-a-date"]) {
			const a = await fetch(`${server.baseUrl}/products/prod-http-conv3/commerce/activate`, {
				method: "POST",
				headers: { "content-type": "application/json", "Idempotency-Key": `kbad-${bad}` },
				body: JSON.stringify({ contentUpdatedAt: bad }),
			});
			expect(a.status, `activate contentUpdatedAt=${JSON.stringify(bad)}`).toBe(400);
		}
		// A body with no contentUpdatedAt at all is also rejected (required).
		const missing = await fetch(`${server.baseUrl}/products/prod-http-conv3/commerce/deactivate`, {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "kmissing" },
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
		// None of the rejected requests changed state — never activated.
		expect((await get("prod-http-conv3")).body).toMatchObject({ active: false });
	});
	// -- Variants: the wire half of the two-writer split (ADR-0016) -----------
	//
	// The port's own contract suite is the spec for what these operations MEAN;
	// what is pinned here is what an INTEGRATOR sees — the routes, the two
	// bodies that cannot reach each other's columns, the money serialization,
	// and the fact that every documented refusal arrives as a typed envelope
	// with a machine code rather than as an opaque 500.

	async function request(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}${path}`, {
			method,
			headers: { "content-type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> | null };
	}

	const VWM = "2026-08-08T00:00:00.000Z";

	function declare(
		id: string,
		variantKey: string,
		body: Record<string, unknown> = { title: variantKey, contentUpdatedAt: VWM },
		key = `dcl-${id}-${variantKey}`,
	): Promise<JsonResponse> {
		return request("PUT", `/products/${id}/variants/${variantKey}`, body, {
			"Idempotency-Key": key,
		});
	}

	function edit(
		id: string,
		variantKey: string,
		body: Record<string, unknown>,
		key = `edt-${id}-${variantKey}`,
	): Promise<JsonResponse> {
		return request("PATCH", `/products/${id}/variants/${variantKey}`, body, {
			"Idempotency-Key": key,
		});
	}

	function listVariants(id: string): Promise<JsonResponse> {
		return request("GET", `/products/${id}/variants`);
	}

	/** A parent product, priced in USD, so the currency guards have an anchor. */
	async function parent(id: string, skuValue: string, amount = 1000): Promise<void> {
		const res = await put(
			id,
			{ sku: skuValue, price: { amount, currency: "USD" }, title: id },
			{ "Idempotency-Key": `parent-${id}` },
		);
		expect(res.status).toBe(200);
	}

	test("GET variants of a product that has declared none is an empty list, never a 404", async () => {
		expect(await listVariants("prod-v-unknown")).toEqual({
			status: 200,
			body: { variants: [] },
		});
	});

	test("PUT declares a variant: the name is written, sku and price are NOT (declare then price)", async () => {
		await parent("prod-v1", "SKU-V1");
		const res = await declare("prod-v1", "large", { title: "Large", contentUpdatedAt: VWM });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			productId: "prod-v1",
			variantKey: "large",
			title: "Large",
			sku: null,
			// ABSENT IS ABSENT: a declared-but-unpriced size is null, never 0 and
			// never a zero-amount money object.
			price: null,
			orphanedAt: null,
		});
		// Write-path bookkeeping never crosses this wire.
		expect(res.body).not.toHaveProperty("idempotencyKey");
		expect(res.body).not.toHaveProperty("contentUpdatedAt");
	});

	test("the declare channel REJECTS commercial fields rather than silently dropping them", async () => {
		await parent("prod-v2", "SKU-V2");
		await declare("prod-v2", "small");
		for (const bad of [{ sku: "SKU-SNEAK" }, { price: { amount: 100, currency: "USD" } }]) {
			const res = await declare("prod-v2", "small", { title: "Small", ...bad }, "dcl-sneak");
			expect(res.status, JSON.stringify(bad)).toBe(400);
			expect(res.body?.error).toBe("invalid request body");
		}
		// And nothing leaked through on the way past.
		const list = await listVariants("prod-v2");
		const rows = list.body?.variants as Array<Record<string, unknown>>;
		expect(rows[0]).toMatchObject({ sku: null, price: null });
	});

	test("the admin edit REJECTS a title rather than silently dropping it — and the stored name is unchanged", async () => {
		await parent("prod-v3", "SKU-V3");
		const declared = await declare("prod-v3", "medium", { title: "Medium", contentUpdatedAt: VWM });
		const res = await edit("prod-v3", "medium", {
			title: "Renamed by the wrong writer",
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(res.status).toBe(400);
		expect(res.body?.error).toBe("invalid request body");
		const rows = (await listVariants("prod-v3")).body?.variants as Array<Record<string, unknown>>;
		expect(rows[0]?.title).toBe("Medium");
	});

	test("PATCH prices a variant — integer minor units + ISO-4217 — and the list reflects it with a coarse stock signal", async () => {
		await parent("prod-v4", "SKU-V4");
		const declared = await declare("prod-v4", "large", { title: "Large", contentUpdatedAt: VWM });
		const res = await edit("prod-v4", "large", {
			sku: "SKU-V4-L",
			price: { amount: 2599, currency: "USD" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			variantKey: "large",
			sku: "SKU-V4-L",
			price: { amount: 2599, currency: "USD" },
			// The name survives a commerce edit byte-identical: the two writers
			// cannot reach each other's column.
			title: "Large",
		});

		const list = await listVariants("prod-v4");
		const rows = list.body?.variants as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		// The edit seeded the sku's inventory row at zero — a KNOWN sku that is out
		// of stock, which reads as not purchasable.
		expect(rows[0]?.inStock).toBe(false);
		// The exact count is NOT published on this storefront-reachable read.
		expect(rows[0]).not.toHaveProperty("onHand");
	});

	// This read is UNAUTHENTICATED (the write gate covers non-GET verbs only) and
	// exists for the storefront picker, so it carries live sizes and nothing else.
	// A discontinued size's name and its last price are not public data; surfacing
	// orphans is the internal-token console's job, where unit cost and the exact
	// on-hand count already live.
	test("the list is ordered by variant key and EXCLUDES orphans — the public read is live rows only", async () => {
		await parent("prod-v5", "SKU-V5");
		for (const k of ["small", "large", "medium"]) await declare("prod-v5", k);
		const dropped = await request(
			"POST",
			"/products/prod-v5/variants/medium/deactivate",
			{ contentUpdatedAt: "2026-08-09T00:00:00.000Z" },
			{ "Idempotency-Key": "drop-v5-medium" },
		);
		expect(dropped.status).toBe(200);

		const rows = (await listVariants("prod-v5")).body?.variants as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.variantKey)).toEqual(["large", "small"]);
		// Every row this read emits is live, so the flag is present and always null
		// — a caller never has to branch on it.
		expect(rows.every((r) => r.orphanedAt === null)).toBe(true);
	});

	test("a product whose every size is orphaned reads as an empty list, not as tombstones", async () => {
		await parent("prod-v5b", "SKU-V5B");
		const declared = await declare("prod-v5b", "large");
		const priced = await edit("prod-v5b", "large", {
			sku: "SKU-V5B-L",
			price: { amount: 7700, currency: "USD" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(priced.status).toBe(200);
		await request(
			"POST",
			"/products/prod-v5b/variants/large/deactivate",
			{ contentUpdatedAt: "2026-08-09T00:00:00.000Z" },
			{ "Idempotency-Key": "drop-v5b-large" },
		);
		expect((await listVariants("prod-v5b")).body).toEqual({ variants: [] });
	});

	test("editing an unknown key, and editing an ORPHANED one, are both VARIANT_NOT_FOUND — an edit is neither a create nor a resurrection", async () => {
		await parent("prod-v6", "SKU-V6");
		const unknown = await edit("prod-v6", "nope", {
			price: { amount: 100, currency: "USD" },
			expectedUpdatedAt: VWM,
		});
		expect(unknown.status).toBe(404);
		expect(unknown.body).toEqual({ ok: false, error: "VARIANT_NOT_FOUND" });

		const declared = await declare("prod-v6", "large");
		await request(
			"POST",
			"/products/prod-v6/variants/large/deactivate",
			{ contentUpdatedAt: "2026-08-09T00:00:00.000Z" },
			{ "Idempotency-Key": "drop-v6-large" },
		);
		const orphaned = await edit(
			"prod-v6",
			"large",
			{
				price: { amount: 100, currency: "USD" },
				expectedUpdatedAt: declared.body?.updatedAt as string,
			},
			"edt-v6-orphan",
		);
		expect(orphaned.status).toBe(404);
		expect(orphaned.body).toEqual({ ok: false, error: "VARIANT_NOT_FOUND" });
		// No row was minted by either refusal — and the orphan the second one
		// addressed is absent from the public read rather than resurrected by it.
		expect((await listVariants("prod-v6")).body).toEqual({ variants: [] });
	});

	test("a lost update is a 409 STALE_EDIT carrying the watermark to reload from", async () => {
		await parent("prod-v7", "SKU-V7");
		const declared = await declare("prod-v7", "large");
		const stale = await edit("prod-v7", "large", {
			price: { amount: 100, currency: "USD" },
			expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
		});
		expect(stale.status).toBe(409);
		expect(stale.body).toMatchObject({ ok: false, error: "STALE_EDIT" });
		expect(stale.body?.currentUpdatedAt).toBe(declared.body?.updatedAt);
	});

	test("a price in a currency the product cannot honour is a 409 CURRENCY_MISMATCH, not a mixed-currency row", async () => {
		await parent("prod-v8", "SKU-V8");
		const declared = await declare("prod-v8", "large");
		const res = await edit("prod-v8", "large", {
			sku: "SKU-V8-L",
			price: { amount: 100, currency: "EUR" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ ok: false, error: "CURRENCY_MISMATCH" });
		expect(res.body).toHaveProperty("currency");
	});

	test("a sku another LIVE sellable unit holds is a 409 SKU_TAKEN — uniqueness spans both tables", async () => {
		await parent("prod-v9", "SKU-V9");
		await parent("prod-v9-other", "SKU-V9-TAKEN");
		const declared = await declare("prod-v9", "large");
		const res = await edit("prod-v9", "large", {
			sku: "SKU-V9-TAKEN",
			price: { amount: 100, currency: "USD" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ ok: false, error: "SKU_TAKEN", sku: "SKU-V9-TAKEN" });
	});

	test("a rename onto a sku that already has an inventory row is a 409 SKU_STOCK_CONFLICT naming both skus", async () => {
		await parent("prod-v10", "SKU-V10");
		await server.seed("SKU-V10-OCCUPIED", 4);
		const declared = await declare("prod-v10", "large");
		const first = await edit("prod-v10", "large", {
			sku: "SKU-V10-L",
			price: { amount: 100, currency: "USD" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(first.status).toBe(200);
		const rename = await edit(
			"prod-v10",
			"large",
			{ sku: "SKU-V10-OCCUPIED", expectedUpdatedAt: first.body?.updatedAt as string },
			"edt-v10-rename",
		);
		expect(rename.status).toBe(409);
		expect(rename.body).toEqual({
			ok: false,
			error: "SKU_STOCK_CONFLICT",
			fromSku: "SKU-V10-L",
			toSku: "SKU-V10-OCCUPIED",
		});
		// Stock is never merged and never moved by a refusal.
		expect(await server.onHand("SKU-V10-OCCUPIED")).toBe(4);
	});

	test("a rename away from a sku with LIVE HOLDS is a 409 SKU_HELD_STOCK naming the sku and the hold count", async () => {
		await parent("prod-v11", "SKU-V11");
		const declared = await declare("prod-v11", "large");
		const priced = await edit("prod-v11", "large", {
			sku: "SKU-V11-L",
			price: { amount: 100, currency: "USD" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(priced.status).toBe(200);
		await server.seed("SKU-V11-L", 5);

		// Two units of that size are held. Taken through the raw inventory
		// primitive rather than a cart line, because a variant sku is not addable
		// to a cart yet — and because THE SKU-RENAME RULE is a property of the sku
		// column, not of one caller: any live reservation naming it blocks the
		// rename, whatever took it.
		const held = await request(
			"POST",
			"/inventory/reserve",
			{ sku: "SKU-V11-L", qty: 2 },
			{ "Idempotency-Key": "hold-v11" },
		);
		expect(held.status).toBe(200);
		expect(held.body?.ok).toBe(true);

		const rename = await edit(
			"prod-v11",
			"large",
			{ sku: "SKU-V11-RENAMED", expectedUpdatedAt: priced.body?.updatedAt as string },
			"edt-v11-rename",
		);
		expect(rename.status).toBe(409);
		expect(rename.body).toMatchObject({
			ok: false,
			error: "SKU_HELD_STOCK",
			sku: "SKU-V11-L",
			liveHolds: 1,
		});
	});

	test("a zero or negative price is a 400 at the boundary — an absent price is expressed by omitting the field", async () => {
		await parent("prod-v12", "SKU-V12");
		const declared = await declare("prod-v12", "large");
		for (const amount of [0, -100]) {
			const res = await edit(
				"prod-v12",
				"large",
				{
					price: { amount, currency: "USD" },
					expectedUpdatedAt: declared.body?.updatedAt as string,
				},
				`edt-v12-${String(amount)}`,
			);
			expect(res.status, `amount=${String(amount)}`).toBe(400);
			expect(res.body?.error).toBe("invalid request body");
		}
	});

	test("an identity-less variant key is a 400 MISSING_VARIANT_KEY on every writer, never a 500", async () => {
		await parent("prod-v13", "SKU-V13");
		const blank = encodeURIComponent("   ");
		const calls: Array<[string, string, unknown]> = [
			["PUT", `/products/prod-v13/variants/${blank}`, { title: "x" }],
			["PATCH", `/products/prod-v13/variants/${blank}`, { expectedUpdatedAt: VWM }],
			["POST", `/products/prod-v13/variants/${blank}/deactivate`, { contentUpdatedAt: VWM }],
		];
		for (const [method, path, body] of calls) {
			const res = await request(method, path, body, { "Idempotency-Key": `blank-${method}` });
			expect(res.status, `${method} ${path}`).toBe(400);
			expect(res.body).toEqual({ error: "MISSING_VARIANT_KEY" });
		}
	});

	test("every variant writer requires an Idempotency-Key", async () => {
		const calls: Array<[string, string, unknown]> = [
			["PUT", "/products/prod-v14/variants/large", { title: "Large" }],
			["PATCH", "/products/prod-v14/variants/large", { expectedUpdatedAt: VWM }],
			["POST", "/products/prod-v14/variants/large/deactivate", { contentUpdatedAt: VWM }],
		];
		for (const [method, path, body] of calls) {
			const res = await request(method, path, body);
			expect(res.status, `${method} ${path}`).toBe(400);
			expect(res.body?.error).toBe("missing Idempotency-Key header");
		}
	});

	test("deactivate is retained-not-deleted, replays cleanly, and a stale watermark is a no-op", async () => {
		await parent("prod-v15", "SKU-V15");
		const declared = await declare("prod-v15", "large");
		const priced = await edit("prod-v15", "large", {
			sku: "SKU-V15-L",
			price: { amount: 4200, currency: "USD" },
			expectedUpdatedAt: declared.body?.updatedAt as string,
		});
		expect(priced.status).toBe(200);
		await server.seed("SKU-V15-L", 11);

		// An unknown key is a no-op, never a 404 and never a minted row.
		const unknown = await request(
			"POST",
			"/products/prod-v15/variants/never-declared/deactivate",
			{ contentUpdatedAt: "2026-08-09T00:00:00.000Z" },
			{ "Idempotency-Key": "drop-v15-unknown" },
		);
		expect(unknown).toEqual({ status: 200, body: { ok: true } });

		const drop = await request(
			"POST",
			"/products/prod-v15/variants/large/deactivate",
			{ contentUpdatedAt: "2026-08-09T00:00:00.000Z" },
			{ "Idempotency-Key": "drop-v15-large" },
		);
		expect(drop.status).toBe(200);

		// Gone from the public read — and RETAINED, which that read can no longer
		// show. The proof is the resurrect: the CMS declaring the key again brings
		// back the SAME row, sku and price intact, which is only possible because
		// deactivate never deleted it. The units never moved at any point.
		expect((await listVariants("prod-v15")).body).toEqual({ variants: [] });
		expect(await server.onHand("SKU-V15-L")).toBe(11);

		const back = await declare(
			"prod-v15",
			"large",
			{ title: "Large", contentUpdatedAt: "2026-08-10T00:00:00.000Z" },
			"dcl-v15-resurrect",
		);
		expect(back.status).toBe(200);
		expect(back.body).toMatchObject({
			variantKey: "large",
			sku: "SKU-V15-L",
			price: { amount: 4200, currency: "USD" },
			orphanedAt: null,
		});
		const rows = (await listVariants("prod-v15")).body?.variants as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ variantKey: "large", sku: "SKU-V15-L" });
		expect(await server.onHand("SKU-V15-L")).toBe(11);
	});

	test("the deactivate body is strict too — an unknown key is a 400, never a silent strip", async () => {
		await parent("prod-v16", "SKU-V16");
		await declare("prod-v16", "large");
		const res = await request(
			"POST",
			"/products/prod-v16/variants/large/deactivate",
			{ contentUpdatedAt: VWM, title: "not this writer's field" },
			{ "Idempotency-Key": "drop-v16-strict" },
		);
		expect(res.status).toBe(400);
		expect(res.body?.error).toBe("invalid request body");
		// Refused whole: the size is still live and still listed.
		const rows = (await listVariants("prod-v16")).body?.variants as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.orphanedAt).toBeNull();
	});
});
