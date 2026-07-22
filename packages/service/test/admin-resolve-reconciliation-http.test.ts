import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin resolve-reconciliation HTTP contract (admin-UX Increment 1): wire ⇄ port
// fidelity for POST /admin/orders/:id/resolve-reconciliation against a LIVE server
// backed by Postgres. Clears a flagged order's reconciliation flag and records the
// admin disposition, NEVER touching state/line items. Guards: internal-token, the
// X-Service-Token write gate (a non-GET), validation (bad outcome / blank reason →
// 400), unknown order (→ 404), a never-flagged order (→ 409), and idempotent
// replay via the guarded flip.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin resolve-reconciliation HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
		// A flagged order (settle lost a hold) awaiting manual resolution.
		await server.seedOrder({
			id: "ord-flagged",
			state: "paid",
			currency: "USD",
			buyerRef: "alice@example.com",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 1000,
			reconciliationFlag: "commit lost for reservation res-1",
		});
		// A clean order (never flagged).
		await server.seedOrder({
			id: "ord-clean",
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
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/resolve-reconciliation`, {
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

	test("resolves a flagged order (200, resolved:true): clears the flag, records the disposition, state unchanged", async () => {
		const res = await post("ord-flagged", {
			outcome: "fulfilled",
			reason: "re-sourced from warehouse B",
			resolvedBy: "ops@shop.test",
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.resolved).toBe(true);
		const order = body.order as Record<string, unknown>;
		expect(order.reconciliationFlag).toBeNull();
		expect(order.state).toBe("paid"); // resolve never moves the state
		expect(order.reconciliationResolution).toMatchObject({
			outcome: "fulfilled",
			reason: "re-sourced from warehouse B",
			resolvedBy: "ops@shop.test",
			resolvedAt: "2026-07-10T00:00:00.000Z",
		});

		// A fresh GET reflects the same cleared flag + recorded disposition.
		const reloaded = (await json(await getOrder("ord-flagged"))).order as Record<string, unknown>;
		expect(reloaded.reconciliationFlag).toBeNull();
		expect((reloaded.reconciliationResolution as Record<string, unknown>).outcome).toBe(
			"fulfilled",
		);
	});

	test("trims reason + resolvedBy server-side (domain validation)", async () => {
		const body = await json(
			await post("ord-flagged", {
				outcome: "refunded",
				reason: "  refunded via stripe  ",
				resolvedBy: "  alice  ",
			}),
		);
		const resolution = (body.order as Record<string, unknown>).reconciliationResolution as Record<
			string,
			unknown
		>;
		expect(resolution.reason).toBe("refunded via stripe");
		expect(resolution.resolvedBy).toBe("alice");
	});

	test("a never-flagged order → 409 NOT_IN_RECONCILIATION", async () => {
		const res = await post("ord-clean", {
			outcome: "written_off",
			reason: "n/a",
			resolvedBy: "ops",
		});
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("NOT_IN_RECONCILIATION");
	});

	test("replay is once-only: a second resolve is resolved:false, disposition unchanged", async () => {
		const first = await json(
			await post("ord-flagged", {
				outcome: "refunded",
				reason: "refunded buyer",
				resolvedBy: "alice",
			}),
		);
		expect(first.resolved).toBe(true);
		const replay = await json(
			await post("ord-flagged", {
				outcome: "written_off",
				reason: "second call",
				resolvedBy: "bob",
			}),
		);
		expect(replay.resolved).toBe(false);
		const resolution = (replay.order as Record<string, unknown>).reconciliationResolution as Record<
			string,
			unknown
		>;
		// The first disposition stands — the loser never overwrote it.
		expect(resolution.outcome).toBe("refunded");
		expect(resolution.resolvedBy).toBe("alice");
	});

	test("validation: unknown outcome → 400; blank reason → 400", async () => {
		expect(
			(await post("ord-flagged", { outcome: "nope", reason: "x", resolvedBy: "y" })).status,
		).toBe(400);
		expect(
			(await post("ord-flagged", { outcome: "fulfilled", reason: "   ", resolvedBy: "y" })).status,
		).toBe(400);
	});

	test("unknown order → 404", async () => {
		const res = await post("does-not-exist", {
			outcome: "fulfilled",
			reason: "x",
			resolvedBy: "y",
		});
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no internal token ⇒ 401", async () => {
		const res = await post(
			"ord-flagged",
			{ outcome: "fulfilled", reason: "x", resolvedBy: "y" },
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
				state: "paid",
				currency: "USD",
				buyerRef: "g@example.com",
				createdAt: "2026-07-10T00:00:00.000Z",
				totalCents: 500,
				reconciliationFlag: "paid flip lost",
			});
			const common = { "content-type": "application/json", "X-Internal-Token": gatedToken };
			const path = `${gated.baseUrl}/admin/orders/ord-g/resolve-reconciliation`;
			const payload = JSON.stringify({
				outcome: "written_off",
				reason: "loss accepted",
				resolvedBy: "ops",
			});
			// Missing X-Service-Token ⇒ blocked by the write gate.
			const blocked = await fetch(path, { method: "POST", headers: common, body: payload });
			expect(blocked.status).toBe(401);
			// With the service token ⇒ resolves.
			const ok = await fetch(path, {
				method: "POST",
				headers: { ...common, "X-Service-Token": "svc-secret" },
				body: payload,
			});
			expect(ok.status).toBe(200);
			expect((await json(ok)).resolved).toBe(true);
		} finally {
			await gated.stop();
		}
	});
});
