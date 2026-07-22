import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin record-fulfillment HTTP contract (admin-UX Increment 1): wire ⇄ port
// fidelity for POST /admin/orders/:id/fulfillment against a LIVE server backed by
// Postgres. Recording fulfillment ships a `processing` order (`→ shipped`) and
// records the tracking envelope, NEVER touching line items. Guards: internal-token,
// the X-Service-Token write gate (a non-GET), validation (blank fields → 400), a
// non-processing order (→ 409 NOT_FULFILLABLE), an unknown order (→ 404), and
// idempotent replay via the guarded flip.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin record-fulfillment HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
		// A processing order ready to ship.
		await server.seedOrder({
			id: "ord-proc",
			state: "processing",
			currency: "USD",
			buyerRef: "alice@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 1000,
		});
		// A paid order — not yet fulfillable (must reach processing first).
		await server.seedOrder({
			id: "ord-paid",
			state: "paid",
			currency: "USD",
			buyerRef: "bob@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 500,
		});
	});
	afterEach(async () => {
		await server.stop();
	});

	function post(
		orderId: string,
		body: Record<string, unknown>,
		opts: { token?: string | null; idempotencyKey?: string; serviceToken?: string } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const tk = opts.token === undefined ? token : opts.token;
		if (tk !== null) headers["X-Internal-Token"] = tk;
		if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
		if (opts.serviceToken !== undefined) headers["X-Service-Token"] = opts.serviceToken;
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/fulfillment`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	}

	function getOrder(orderId: string): Promise<Response> {
		return fetch(`${server.baseUrl}/admin/orders/${orderId}`, {
			headers: { "X-Internal-Token": token },
		});
	}

	test("records fulfillment on a processing order (200, recorded:true): ships it + stores tracking", async () => {
		const res = await post("ord-proc", {
			carrier: "UPS",
			trackingNumber: "1Z-999",
			trackingUrl: "https://track/1Z-999",
			shippedAt: "2026-07-11T09:00:00.000Z",
			recordedBy: "ops@shop.test",
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.recorded).toBe(true);
		const order = body.order as Record<string, unknown>;
		expect(order.state).toBe("shipped");
		expect(order.fulfillment).toMatchObject({
			carrier: "UPS",
			trackingNumber: "1Z-999",
			trackingUrl: "https://track/1Z-999",
			shippedAt: "2026-07-11T09:00:00.000Z",
			recordedBy: "ops@shop.test",
		});

		// A fresh GET reflects the shipped state + fulfillment; allowedTransitions
		// come from the domain state machine (shipped → delivered|refunded).
		const reloaded = await json(await getOrder("ord-proc"));
		const ro = reloaded.order as Record<string, unknown>;
		expect(ro.state).toBe("shipped");
		expect((ro.fulfillment as Record<string, unknown>).trackingNumber).toBe("1Z-999");
	});

	test("trims the free-text fields + normalizes an absent tracking URL / ship time", async () => {
		const body = await json(
			await post("ord-proc", {
				carrier: "  DHL  ",
				trackingNumber: "  DH-42  ",
				recordedBy: "  alice  ",
			}),
		);
		const f = (body.order as Record<string, unknown>).fulfillment as Record<string, unknown>;
		expect(f.carrier).toBe("DHL");
		expect(f.trackingNumber).toBe("DH-42");
		expect(f.recordedBy).toBe("alice");
		expect(f.trackingUrl).toBeNull();
		// A blank ship time defaults to the store's record timestamp.
		expect(f.shippedAt).toBe(f.recordedAt);
	});

	test("a non-processing (paid) order → 409 NOT_FULFILLABLE; state untouched", async () => {
		const res = await post("ord-paid", {
			carrier: "UPS",
			trackingNumber: "1Z-1",
			recordedBy: "ops",
		});
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("NOT_FULFILLABLE");
		const reloaded = (await json(await getOrder("ord-paid"))).order as Record<string, unknown>;
		expect(reloaded.state).toBe("paid");
		expect(reloaded.fulfillment).toBeNull();
	});

	test("replay is once-only: a second record is recorded:false, fulfillment unchanged", async () => {
		const first = await json(
			await post("ord-proc", { carrier: "UPS", trackingNumber: "1Z-A", recordedBy: "alice" }),
		);
		expect(first.recorded).toBe(true);
		const replay = await json(
			await post("ord-proc", { carrier: "DHL", trackingNumber: "1Z-B", recordedBy: "bob" }),
		);
		expect(replay.recorded).toBe(false);
		// The first fulfillment stands — the loser never overwrote it.
		const f = (replay.order as Record<string, unknown>).fulfillment as Record<string, unknown>;
		expect(f.carrier).toBe("UPS");
		expect(f.trackingNumber).toBe("1Z-A");
	});

	test("validation: blank carrier / tracking number / recorder → 400", async () => {
		expect(
			(await post("ord-proc", { carrier: "", trackingNumber: "x", recordedBy: "y" })).status,
		).toBe(400);
		expect(
			(await post("ord-proc", { carrier: "x", trackingNumber: "   ", recordedBy: "y" })).status,
		).toBe(400);
		expect(
			(await post("ord-proc", { carrier: "x", trackingNumber: "y", recordedBy: "  " })).status,
		).toBe(400);
	});

	test("unknown order → 404", async () => {
		const res = await post("does-not-exist", {
			carrier: "UPS",
			trackingNumber: "x",
			recordedBy: "y",
		});
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no internal token ⇒ 401", async () => {
		const res = await post(
			"ord-proc",
			{ carrier: "UPS", trackingNumber: "x", recordedBy: "y" },
			{ token: null },
		);
		expect(res.status).toBe(401);
	});

	test("write gate: with a service token set, POST needs X-Service-Token (401 without, 200 with)", async () => {
		const gated = await startTestServer({ serviceToken: "svc-secret" });
		try {
			const gatedToken = gated.internalToken as string;
			await gated.seedOrder({
				id: "ord-g",
				state: "processing",
				currency: "USD",
				buyerRef: "g@example.com",
				createdAt: "2026-07-10T00:00:00.000Z",
				totalCents: 500,
			});
			const common = { "content-type": "application/json", "X-Internal-Token": gatedToken };
			const path = `${gated.baseUrl}/admin/orders/ord-g/fulfillment`;
			const payload = JSON.stringify({ carrier: "UPS", trackingNumber: "1Z", recordedBy: "ops" });
			const blocked = await fetch(path, { method: "POST", headers: common, body: payload });
			expect(blocked.status).toBe(401);
			const ok = await fetch(path, {
				method: "POST",
				headers: { ...common, "X-Service-Token": "svc-secret" },
				body: payload,
			});
			expect(ok.status).toBe(200);
			expect((await json(ok)).recorded).toBe(true);
		} finally {
			await gated.stop();
		}
	});
});
