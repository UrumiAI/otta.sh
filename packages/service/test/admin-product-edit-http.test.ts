import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Standalone product EDIT (admin-UX Increment 2 slice 2): wire ⇄ port fidelity
// for PATCH /admin/products/:id against a LIVE server backed by Postgres. Pins
// the guarded commerce edit end-to-end — the optimistic compare-and-set on
// updatedAt (stale ⇒ 409, never a silent clobber), currency integrity, the
// price > 0 boundary, SKU uniqueness, not_found, and the snapshot-safe scope
// (active is never touched). Mirrors admin-products-http.test.ts's shape.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin product EDIT HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	function get(id: string): Promise<Response> {
		return fetch(`${server.baseUrl}/admin/products/${id}`, {
			headers: { "X-Internal-Token": token },
		});
	}

	function patch(
		id: string,
		body: unknown,
		opts: { token?: string | null; idempotencyKey?: string } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		const tok = opts.token === undefined ? token : opts.token;
		if (tok !== null) headers["X-Internal-Token"] = tok;
		if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
		return fetch(`${server.baseUrl}/admin/products/${id}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify(body),
		});
	}

	async function seedAndReadWatermark(id = "prod-1"): Promise<string> {
		await server.seedProductRow({
			id,
			sku: `SKU-${id}`,
			title: "Original",
			priceCents: 1000,
			currency: "USD",
			productKind: "physical",
			active: true,
			createdAt: "2026-07-10T01:00:00.000Z",
		});
		const detail = (await json(await get(id))).product as Record<string, unknown>;
		return detail.updatedAt as string;
	}

	test("applies a price edit under a matching expectedUpdatedAt (200), never touching the publish gate", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			price: { amount: 2599, currency: "USD" },
			taxClass: "reduced",
		});
		expect(res.status).toBe(200);
		expect((await json(res)).ok).toBe(true);

		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.priceCents).toBe(2599);
		expect(after.taxClass).toBe("reduced");
		expect(after.active).toBe(true); // the CMS publish gate is untouched.
		// The CMS-owned title rode through untouched — this edit has no channel to it.
		expect(after.title).toBe("Original");
	});

	test("a concurrent edit is a 409 STALE_EDIT carrying the current watermark, never a clobber", async () => {
		await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
			sku: "SKU-loser",
		});
		expect(res.status).toBe(409);
		const body = await json(res);
		expect(body.reason).toBe("STALE_EDIT");
		expect(typeof body.currentUpdatedAt).toBe("string");
		// The losing write never landed — the lost-update guard keeps its teeth on a
		// field the edit CAN write (title moved to the CMS sync, ADR-0013).
		expect(((await json(await get("prod-1"))).product as Record<string, unknown>).sku).toBe(
			"SKU-prod-1",
		);
	});

	test("a same-Idempotency-Key replay dedupes to one applied write (200 both times)", async () => {
		const watermark = await seedAndReadWatermark();
		const first = await patch(
			"prod-1",
			{ expectedUpdatedAt: watermark, taxClass: "reduced" },
			{ idempotencyKey: "edit-key-1" },
		);
		expect(first.status).toBe(200);
		// A retry with the SAME key but the now-stale watermark still succeeds (replay
		// precedence over the CAS), rather than a spurious 409.
		const replay = await patch(
			"prod-1",
			{ expectedUpdatedAt: watermark, taxClass: "reduced" },
			{ idempotencyKey: "edit-key-1" },
		);
		expect(replay.status).toBe(200);
	});

	// -- ADR-0013: title is CMS-owned, and the PATCH says so out loud -----------

	test("REJECTS a PATCH carrying `title` (400 naming the field) and the stored title is UNCHANGED", async () => {
		// Rung 3 of the ADR-0013 enforcement ladder. `editProductCommerceBody` is
		// `.strict()` precisely so a stale client's title edit cannot vanish behind a
		// 200: zod's default object behaviour STRIPS an unknown key, which is the
		// failure mode most likely to be misread as "it saved".
		//
		// THE STORED-VALUE ASSERTION IS THE POINT. A status-only test passes just as
		// well against a stripping schema and therefore proves nothing; only reading
		// the title back distinguishes "rejected" from "silently dropped".
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			title: "Renamed from a stale client",
		});
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toBe("invalid request body");
		// The rejection NAMES the offending field, so the client sees which key is
		// unwelcome rather than an opaque "invalid body".
		expect(JSON.stringify(body.issues)).toContain("title");

		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.title).toBe("Original");
	});

	test("a legal edit alongside an illegal `title` is rejected WHOLE — no partial application", async () => {
		// The other half of `.strict()`: the price must not land while the title is
		// quietly discarded, which is what a stripping schema would do.
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			price: { amount: 2599, currency: "USD" },
			title: "Renamed from a stale client",
		});
		expect(res.status).toBe(400);

		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.priceCents).toBe(1000); // untouched
		expect(after.title).toBe("Original"); // untouched
	});

	test("the CMS sync's own channel (PUT /products/:id/commerce) still writes the title", async () => {
		// The positive statement of ADR-0013: removing the admin writer must not
		// remove the ONE writer that remains. Without this the suite would be happy
		// with a title nothing can ever set.
		await seedAndReadWatermark();
		const res = await fetch(`${server.baseUrl}/products/prod-1/commerce`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", "Idempotency-Key": "sync-1" },
			body: JSON.stringify({ title: "Renamed by the CMS" }),
		});
		expect(res.status).toBe(200);

		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.title).toBe("Renamed by the CMS");
	});

	test("rejects a silent currency switch (409 CURRENCY_MISMATCH)", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			price: { amount: 1000, currency: "EUR" },
		});
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("CURRENCY_MISMATCH");
	});

	test("rejects a non-positive price at the boundary (400)", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			price: { amount: 0, currency: "USD" },
		});
		expect(res.status).toBe(400);
	});

	test("a live-SKU collision is a 409 SKU_TAKEN", async () => {
		await server.seedProductRow({
			id: "prod-a",
			sku: "SKU-SHARED",
			title: "A",
			priceCents: 500,
			currency: "USD",
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		const watermark = await seedAndReadWatermark("prod-b");
		const res = await patch("prod-b", { expectedUpdatedAt: watermark, sku: "SKU-SHARED" });
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("SKU_TAKEN");
	});

	test("404s for an unknown product (an edit is not a create)", async () => {
		const res = await patch("does-not-exist", {
			expectedUpdatedAt: "2026-07-10T01:00:00.000Z",
			taxClass: "reduced",
		});
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("PRODUCT_NOT_FOUND");
	});

	test("guard: no admin token ⇒ 401", async () => {
		const res = await patch(
			"prod-1",
			{ expectedUpdatedAt: "2026-07-10T01:00:00.000Z", taxClass: "reduced" },
			{ token: null },
		);
		expect(res.status).toBe(401);
	});

	// -- product data-model adds (Increment 2 slice 5) ------------------------

	test("round-trips compare-at, unit cost, and inventory policy through the admin detail", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			compareAtPrice: { amount: 3000, currency: "USD" },
			unitCost: { amount: 850, currency: "USD" },
			inventoryPolicy: "deny",
		});
		expect(res.status).toBe(200);

		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.compareAtCents).toBe(3000);
		expect(after.compareAtCurrency).toBe("USD");
		expect(after.unitCostCents).toBe(850);
		expect(after.unitCostCurrency).toBe("USD");
		expect(after.inventoryPolicy).toBe("deny");
	});

	test("rejects a compare-at in a different currency than the product's price (409 CURRENCY_MISMATCH)", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			compareAtPrice: { amount: 3000, currency: "EUR" },
		});
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("CURRENCY_MISMATCH");
	});

	test("rejects a mixed-currency edit (price USD + compare-at EUR) as a 400, nothing written", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			price: { amount: 2599, currency: "USD" },
			compareAtPrice: { amount: 3000, currency: "EUR" },
		});
		expect(res.status).toBe(400);
		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.compareAtCents).toBeNull();
		expect(after.priceCents).toBe(1000); // untouched
	});

	test("unit cost NEVER leaks to a storefront-facing read path (admin-only)", async () => {
		const watermark = await seedAndReadWatermark();
		await patch("prod-1", {
			expectedUpdatedAt: watermark,
			compareAtPrice: { amount: 3000, currency: "USD" },
			unitCost: { amount: 850, currency: "USD" },
		});

		// (a) The public (un-authenticated) raw commerce GET: compare-at is present,
		//     unit cost is absent — it is admin-only margin data.
		const publicRes = await fetch(`${server.baseUrl}/products/prod-1/commerce`);
		const publicBody = await json(publicRes);
		expect(publicBody).not.toHaveProperty("unitCost");
		expect(publicBody).not.toHaveProperty("unitCostCents");
		expect(publicBody.compareAt).toEqual({ amount: 3000, currency: "USD" });

		// (b) The storefront catalog batch view: no cost of any kind.
		const catalogRes = await fetch(`${server.baseUrl}/catalog/commerce/batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productIds: ["prod-1"] }),
		});
		const items = (await json(catalogRes)).items as Array<Record<string, unknown>>;
		for (const item of items) {
			expect(item).not.toHaveProperty("unitCost");
			expect(item).not.toHaveProperty("unitCostCents");
		}
	});

	test("the write gate blocks a PATCH with no X-Service-Token when the service secret is set", async () => {
		const gated = await startTestServer({ serviceToken: "svc-secret" });
		try {
			const res = await fetch(`${gated.baseUrl}/admin/products/prod-1`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Token": gated.internalToken as string,
				},
				body: JSON.stringify({
					expectedUpdatedAt: "2026-07-10T01:00:00.000Z",
					taxClass: "reduced",
				}),
			});
			// The app-level write gate rejects a non-GET without the service token.
			expect([401, 403]).toContain(res.status);
		} finally {
			await gated.stop();
		}
	});
});
