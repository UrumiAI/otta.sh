import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin cancel-with-reason HTTP contract (admin-UX Increment 1): wire ⇄ port
// fidelity for POST /admin/orders/:id/cancel against a LIVE server backed by
// Postgres. Cancelling drives {pending,paid,processing} → cancelled and records
// the structured reason envelope, NEVER touching line items. Guards:
// internal-token, the X-Service-Token write gate (a non-GET), validation
// (bad reason / blank cancelledBy → 400), a non-cancellable order (→ 409
// NOT_CANCELLABLE), an unknown order (→ 404), and idempotent replay via the
// guarded flip.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin cancel-order HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
		// A processing order — cancellable (pre-shipment).
		await server.seedOrder({
			id: "ord-proc",
			state: "processing",
			currency: "USD",
			buyerRef: "alice@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 1000,
		});
		// A shipped order — terminal-adjacent, not cancellable via this slice.
		await server.seedOrder({
			id: "ord-shipped",
			state: "shipped",
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
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/cancel`, {
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

	test("cancels a processing order with a reason (200, cancelled:true): records it + moves to cancelled", async () => {
		const res = await post("ord-proc", {
			reason: "out_of_stock",
			detail: "last unit sold on another channel",
			cancelledBy: "ops@shop.test",
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.cancelled).toBe(true);
		const order = body.order as Record<string, unknown>;
		expect(order.state).toBe("cancelled");
		expect(order.cancellation).toMatchObject({
			reason: "out_of_stock",
			detail: "last unit sold on another channel",
			cancelledBy: "ops@shop.test",
		});

		// A fresh GET reflects the cancelled state + reason; cancelled is terminal
		// (no allowedTransitions).
		const reloaded = await json(await getOrder("ord-proc"));
		const ro = reloaded.order as Record<string, unknown>;
		expect(ro.state).toBe("cancelled");
		expect((ro.cancellation as Record<string, unknown>).reason).toBe("out_of_stock");
		expect(reloaded.allowedTransitions).toEqual([]);
	});

	test("an absent detail normalizes to null", async () => {
		const body = await json(
			await post("ord-proc", { reason: "customer_request", cancelledBy: "alice" }),
		);
		const c = (body.order as Record<string, unknown>).cancellation as Record<string, unknown>;
		expect(c.detail).toBeNull();
	});

	test("a non-cancellable (shipped) order → 409 NOT_CANCELLABLE; state untouched", async () => {
		const res = await post("ord-shipped", { reason: "customer_request", cancelledBy: "ops" });
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("NOT_CANCELLABLE");
		const reloaded = (await json(await getOrder("ord-shipped"))).order as Record<string, unknown>;
		expect(reloaded.state).toBe("shipped");
		expect(reloaded.cancellation).toBeNull();
	});

	test("replay is once-only: a second cancel is cancelled:false, reason unchanged", async () => {
		const first = await json(
			await post("ord-proc", { reason: "out_of_stock", cancelledBy: "alice" }),
		);
		expect(first.cancelled).toBe(true);
		const replay = await json(
			await post("ord-proc", { reason: "pricing_error", cancelledBy: "bob" }),
		);
		expect(replay.cancelled).toBe(false);
		// The first reason stands — the loser never overwrote it.
		const c = (replay.order as Record<string, unknown>).cancellation as Record<string, unknown>;
		expect(c.reason).toBe("out_of_stock");
		expect(c.cancelledBy).toBe("alice");
	});

	test("validation: an unknown reason value → 400", async () => {
		expect(
			(await post("ord-proc", { reason: "buyer_changed_mind", cancelledBy: "y" })).status,
		).toBe(400);
	});

	test("validation: a blank cancelledBy → 400", async () => {
		expect(
			(await post("ord-proc", { reason: "customer_request", cancelledBy: "   " })).status,
		).toBe(400);
	});

	test("unknown order → 404", async () => {
		const res = await post("does-not-exist", { reason: "customer_request", cancelledBy: "y" });
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no internal token ⇒ 401", async () => {
		const res = await post(
			"ord-proc",
			{ reason: "customer_request", cancelledBy: "y" },
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
			const path = `${gated.baseUrl}/admin/orders/ord-g/cancel`;
			const payload = JSON.stringify({ reason: "customer_request", cancelledBy: "ops" });
			const blocked = await fetch(path, { method: "POST", headers: common, body: payload });
			expect(blocked.status).toBe(401);
			const ok = await fetch(path, {
				method: "POST",
				headers: { ...common, "X-Service-Token": "svc-secret" },
				body: payload,
			});
			expect(ok.status).toBe(200);
			expect((await json(ok)).cancelled).toBe(true);
		} finally {
			await gated.stop();
		}
	});
});
