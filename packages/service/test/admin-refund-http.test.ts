import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
	StripeCreateRefundResult,
	StripePreflightResult,
	StripeTransport,
} from "@urumi/payments-stripe";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin refund HTTP contract (ADR-0008): wire ⇄ port fidelity for the refund
// endpoints against a LIVE server backed by Postgres. Covers the GET
// ceiling/remaining/capability read, the POST gateway (Stripe) + manual (x402)
// paths, the ceiling rejection, the required Idempotency-Key, the fail-closed
// PROVIDER_ALREADY_REFUNDED, the internal-token + write gate, and idempotent replay.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

/** A scripted offline Stripe transport making the gateway refundable:true. */
class StubTransport implements StripeTransport {
	preflight: StripePreflightResult = {
		ok: true,
		view: { amountRefunded: 0, amountCaptured: 1000, currency: "usd" },
	};
	async readRefundedAmount(): Promise<StripePreflightResult> {
		return this.preflight;
	}
	async createRefund(input: { amountCents: number }): Promise<StripeCreateRefundResult> {
		return { ok: true, refundId: "re_test", amountCents: input.amountCents, currency: "usd" };
	}
}

describe.skipIf(PG === undefined)("admin refund HTTP contract (Stripe, refundable)", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer({
			stripeSecretKey: "sk_test",
			stripeTransport: new StubTransport(),
		});
		token = server.internalToken as string;
		await server.seedOrder({
			id: "ord-paid",
			state: "paid",
			currency: "USD",
			buyerRef: "alice@example.com",
			paymentMethod: "stripe",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 1000,
		});
		await server.seedPayment({
			orderId: "ord-paid",
			gateway: "stripe",
			providerRef: "pi_paid",
			amountCents: 1000,
			currency: "USD",
		});
	});
	afterEach(async () => {
		await server.stop();
	});

	function postRefund(
		orderId: string,
		body: Record<string, unknown>,
		opts: { token?: string | null; idempotencyKey?: string; serviceToken?: string } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const tk = opts.token === undefined ? token : opts.token;
		if (tk !== null) headers["X-Internal-Token"] = tk;
		if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
		if (opts.serviceToken !== undefined) headers["X-Service-Token"] = opts.serviceToken;
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/refund`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	}

	function getRefunds(orderId: string): Promise<Response> {
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/refunds`, {
			headers: { "X-Internal-Token": token },
		});
	}

	test("GET refunds shows the ceiling, remaining, and honest capability (refundable:true)", async () => {
		const body = await json(await getRefunds("ord-paid"));
		expect(body.ok).toBe(true);
		expect(body.capturedTotalCents).toBe(1000);
		expect(body.ceilingCents).toBe(1000);
		expect(body.refundedTotalCents).toBe(0);
		expect(body.remainingCents).toBe(1000);
		expect(body.refundable).toBe(true);
		expect(body.paymentMethod).toBe("stripe");
		expect(body.refunds).toEqual([]);
	});

	test("a full gateway refund records + flips to refunded; the ledger + remaining update", async () => {
		const res = await postRefund(
			"ord-paid",
			{ amountCents: 1000, currency: "USD", refundedBy: "ops@shop.test" },
			{ idempotencyKey: "rf-1" },
		);
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.recorded).toBe(true);
		expect(body.fullyRefunded).toBe(true);
		const refund = body.refund as Record<string, unknown>;
		expect(refund.kind).toBe("gateway");
		expect(refund.refundRef).toBe("re_test");
		expect(refund.amountCents).toBe(1000);
		expect((body.order as Record<string, unknown>).state).toBe("refunded");

		const after = await json(await getRefunds("ord-paid"));
		expect(after.refundedTotalCents).toBe(1000);
		expect(after.remainingCents).toBe(0);
		expect((after.refunds as unknown[]).length).toBe(1);
	});

	test("a partial refund does not transition; remaining decreases", async () => {
		await postRefund(
			"ord-paid",
			{ amountCents: 400, currency: "USD", refundedBy: "ops" },
			{ idempotencyKey: "rf-partial" },
		);
		const after = await json(await getRefunds("ord-paid"));
		expect(after.refundedTotalCents).toBe(400);
		expect(after.remainingCents).toBe(600);
	});

	test("over-refund past the ceiling → 409 REFUND_EXCEEDS_TOTAL", async () => {
		const res = await postRefund(
			"ord-paid",
			{ amountCents: 1001, currency: "USD", refundedBy: "ops" },
			{ idempotencyKey: "rf-over" },
		);
		expect(res.status).toBe(409);
		expect((await json(res)).reason).toBe("REFUND_EXCEEDS_TOTAL");
	});

	test("a missing Idempotency-Key header → 400 (refunds are additive, must not collapse)", async () => {
		const res = await postRefund("ord-paid", {
			amountCents: 100,
			currency: "USD",
			refundedBy: "ops",
		});
		expect(res.status).toBe(400);
		expect((await json(res)).reason).toBe("MISSING_IDEMPOTENCY_KEY");
	});

	test("idempotent replay: same key → recorded once, duplicate on the second", async () => {
		const first = await json(
			await postRefund(
				"ord-paid",
				{ amountCents: 300, currency: "USD", refundedBy: "ops" },
				{ idempotencyKey: "rf-idem" },
			),
		);
		expect(first.recorded).toBe(true);
		const replay = await json(
			await postRefund(
				"ord-paid",
				{ amountCents: 300, currency: "USD", refundedBy: "ops" },
				{ idempotencyKey: "rf-idem" },
			),
		);
		expect(replay.recorded).toBe(false);
		expect(replay.duplicate).toBe(true);
		const after = await json(await getRefunds("ord-paid"));
		expect(after.refundedTotalCents).toBe(300);
	});

	test("unknown order → 404; no internal token → 401", async () => {
		expect(
			(
				await postRefund(
					"nope",
					{ amountCents: 100, currency: "USD", refundedBy: "ops" },
					{ idempotencyKey: "x" },
				)
			).status,
		).toBe(404);
		expect(
			(
				await postRefund(
					"ord-paid",
					{ amountCents: 100, currency: "USD", refundedBy: "ops" },
					{ idempotencyKey: "x", token: null },
				)
			).status,
		).toBe(401);
	});

	test("fail closed: a provider that already refunded past our view → 409 PROVIDER_ALREADY_REFUNDED, nothing recorded", async () => {
		const gated = await startTestServer({
			stripeSecretKey: "sk_test",
			stripeTransport: (() => {
				const t = new StubTransport();
				t.preflight = {
					ok: true,
					view: { amountRefunded: 500, amountCaptured: 1000, currency: "usd" },
				};
				return t;
			})(),
		});
		try {
			const tk = gated.internalToken as string;
			await gated.seedOrder({
				id: "ord-pre",
				state: "paid",
				currency: "USD",
				buyerRef: "b@example.com",
				paymentMethod: "stripe",
				createdAt: "2026-07-10T00:00:00.000Z",
				totalCents: 1000,
			});
			await gated.seedPayment({
				orderId: "ord-pre",
				gateway: "stripe",
				providerRef: "pi_pre",
				amountCents: 1000,
				currency: "USD",
			});
			const res = await fetch(`${gated.baseUrl}/admin/orders/ord-pre/refund`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Internal-Token": tk,
					"Idempotency-Key": "rf-pre",
				},
				body: JSON.stringify({ amountCents: 300, currency: "USD", refundedBy: "ops" }),
			});
			expect(res.status).toBe(409);
			expect((await json(res)).reason).toBe("PROVIDER_ALREADY_REFUNDED");
			const after = await json(
				await fetch(`${gated.baseUrl}/admin/orders/ord-pre/refunds`, {
					headers: { "X-Internal-Token": tk },
				}),
			);
			expect(after.refundedTotalCents).toBe(0);
		} finally {
			await gated.stop();
		}
	});
});

describe.skipIf(PG === undefined)("admin refund HTTP contract (x402, manual record-only)", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
		await server.seedOrder({
			id: "ord-x402",
			state: "paid",
			currency: "USD",
			buyerRef: "c@example.com",
			paymentMethod: "x402",
			createdAt: "2026-07-10T00:00:00.000Z",
			totalCents: 800,
		});
		await server.seedPayment({
			orderId: "ord-x402",
			gateway: "x402",
			providerRef: "0xtx",
			amountCents: 800,
			currency: "USD",
		});
	});
	afterEach(async () => {
		await server.stop();
	});

	test("GET refunds reports refundable:false for an x402 order (honest capability)", async () => {
		const body = await json(
			await fetch(`${server.baseUrl}/admin/orders/ord-x402/refunds`, {
				headers: { "X-Internal-Token": token },
			}),
		);
		expect(body.refundable).toBe(false);
		expect(body.paymentMethod).toBe("x402");
	});

	test("a full refund on an x402 order records a MANUAL entry (no refundRef) and flips to refunded", async () => {
		const res = await fetch(`${server.baseUrl}/admin/orders/ord-x402/refund`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Internal-Token": token,
				"Idempotency-Key": "rf-x402",
			},
			body: JSON.stringify({ amountCents: 800, currency: "USD", refundedBy: "ops" }),
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		const refund = body.refund as Record<string, unknown>;
		expect(refund.kind).toBe("manual");
		expect(refund.refundRef).toBeNull();
		expect(body.fullyRefunded).toBe(true);
		expect((body.order as Record<string, unknown>).state).toBe("refunded");
	});
});
