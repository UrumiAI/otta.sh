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
});
