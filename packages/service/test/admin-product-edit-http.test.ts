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

	test("applies a price + title edit under a matching expectedUpdatedAt (200), never touching the publish gate", async () => {
		const watermark = await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: watermark,
			price: { amount: 2599, currency: "USD" },
			title: "Renamed",
		});
		expect(res.status).toBe(200);
		expect((await json(res)).ok).toBe(true);

		const after = (await json(await get("prod-1"))).product as Record<string, unknown>;
		expect(after.priceCents).toBe(2599);
		expect(after.title).toBe("Renamed");
		expect(after.active).toBe(true); // the CMS publish gate is untouched.
	});

	test("a concurrent edit is a 409 STALE_EDIT carrying the current watermark, never a clobber", async () => {
		await seedAndReadWatermark();
		const res = await patch("prod-1", {
			expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
			title: "loser",
		});
		expect(res.status).toBe(409);
		const body = await json(res);
		expect(body.reason).toBe("STALE_EDIT");
		expect(typeof body.currentUpdatedAt).toBe("string");
		// The losing write never landed.
		expect(((await json(await get("prod-1"))).product as Record<string, unknown>).title).toBe(
			"Original",
		);
	});

	test("a same-Idempotency-Key replay dedupes to one applied write (200 both times)", async () => {
		const watermark = await seedAndReadWatermark();
		const first = await patch(
			"prod-1",
			{ expectedUpdatedAt: watermark, title: "Once" },
			{ idempotencyKey: "edit-key-1" },
		);
		expect(first.status).toBe(200);
		// A retry with the SAME key but the now-stale watermark still succeeds (replay
		// precedence over the CAS), rather than a spurious 409.
		const replay = await patch(
			"prod-1",
			{ expectedUpdatedAt: watermark, title: "Once" },
			{ idempotencyKey: "edit-key-1" },
		);
		expect(replay.status).toBe(200);
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
			title: "ghost",
		});
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("PRODUCT_NOT_FOUND");
	});

	test("guard: no admin token ⇒ 401", async () => {
		const res = await patch(
			"prod-1",
			{ expectedUpdatedAt: "2026-07-10T01:00:00.000Z", title: "x" },
			{ token: null },
		);
		expect(res.status).toBe(401);
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
				body: JSON.stringify({ expectedUpdatedAt: "2026-07-10T01:00:00.000Z", title: "x" }),
			});
			// The app-level write gate rejects a non-GET without the service token.
			expect([401, 403]).toContain(res.status);
		} finally {
			await gated.stop();
		}
	});
});
