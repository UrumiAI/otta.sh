/**
 * Late answers from Stripe, now that a timed-out call is abandoned rather than
 * aborted (no `AbortSignal` in `init` by default): what reaches the money paths.
 *
 * Shape: a trusted Node host — real undici (`globalThis.fetch`) against a REAL
 * local HTTP stub that behaves like Stripe's idempotency layer: the side effect
 * happens on RECEIPT (the answer is merely late), a key is processed once, a
 * replay after the first finished gets the first answer, and a concurrent replay
 * while the first is still running gets 409 `idempotency_key_in_use`. No real
 * Stripe is called; the key is a fake.
 *
 * What these pin: a refund that succeeded at Stripe after our bound is
 * `UNVERIFIED` (ambiguous), never `TERMINAL`; a resume while the abandoned create
 * is still in flight fails closed (pre-flight sees the refund, or a same-key
 * create gets 409 ⇒ retryable); and however the calls interleave, Stripe records
 * ONE refund and ONE PaymentIntent per key.
 */
import { cents, currency, idempotencyKey, orderId, type RefundInput } from "@otta-sh/domain";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createStripeHttpTransport, StripePaymentGateway } from "../src/index.js";

const SK = "sk_test_late_answers_fake";
const STRIPE_ORIGIN = "https://api.stripe.com";

interface Stub {
	base: string;
	/** Money-moving side effects, recorded when the request is RECEIVED. */
	refunds: { key: string; id: string; amount: number }[];
	intents: { key: string; id: string }[];
	/** How long to wait before answering a create, by kind. */
	delayMs: { refund: number; intent: number };
	/** Answer the refund create's 2xx one character every 40 ms. */
	trickleRefundBody: boolean;
	sockets: Set<Socket>;
	close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ms until `n()` is 0, polled every 50 ms, or -1 after `max` ms. */
async function msUntilZero(n: () => number, max: number): Promise<number> {
	const started = Date.now();
	while (Date.now() - started < max) {
		if (n() === 0) return Date.now() - started;
		await sleep(50);
	}
	return -1;
}

async function startStripeLikeStub(): Promise<Stub> {
	const sockets = new Set<Socket>();
	const firstAnswer = new Map<string, { status: number; body: unknown }>();
	const inFlight = new Set<string>();
	const refunds: Stub["refunds"] = [];
	const intents: Stub["intents"] = [];
	const delayMs = { refund: 0, intent: 0 };
	const stub = { refunds, intents, delayMs, trickleRefundBody: false, sockets } as Stub;

	const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		for await (const chunk of req) void chunk;
		const key = req.headers["idempotency-key"] as string | undefined;
		const url = req.url ?? "";
		const answer = (status: number, body: unknown) => {
			if (res.destroyed) return;
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.method === "GET" && url.startsWith("/v1/payment_intents/")) {
			const refunded = refunds.reduce((sum, r) => sum + r.amount, 0);
			return answer(200, {
				latest_charge: { amount_refunded: refunded, amount_captured: 1000, currency: "usd" },
			});
		}
		if (req.method !== "POST" || key === undefined) {
			return answer(404, { error: { code: "unexpected" } });
		}
		const prior = firstAnswer.get(key);
		if (prior !== undefined) return answer(prior.status, prior.body);
		if (inFlight.has(key)) return answer(409, { error: { code: "idempotency_key_in_use" } });
		inFlight.add(key);
		let body: unknown;
		let delay = 0;
		if (url === "/v1/refunds") {
			const id = `re_${String(refunds.length + 1)}`;
			refunds.push({ key, id, amount: 500 });
			body = { id, amount: 500, currency: "usd", status: "succeeded" };
			delay = delayMs.refund;
		} else if (url === "/v1/payment_intents") {
			const id = `pi_${String(intents.length + 1)}`;
			intents.push({ key, id });
			body = { id, client_secret: `${id}_secret_x` };
			delay = delayMs.intent;
		} else {
			body = { error: { code: "unexpected" } };
		}
		if (url === "/v1/refunds" && stub.trickleRefundBody) {
			firstAnswer.set(key, { status: 200, body });
			res.writeHead(200, { "content-type": "application/json" });
			for (const ch of JSON.stringify(body)) {
				if (res.destroyed) break;
				res.write(ch);
				await sleep(40);
			}
			res.end();
			inFlight.delete(key);
			return;
		}
		await sleep(delay);
		firstAnswer.set(key, { status: 200, body });
		inFlight.delete(key);
		answer(200, body);
	});
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("stub has no port");
	stub.base = `http://127.0.0.1:${String(address.port)}`;
	stub.close = async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	return stub;
}

function refundInput(): RefundInput {
	return {
		orderId: orderId("ord_1"),
		providerRef: "pi_paid",
		amount: cents(500),
		currency: currency("USD"),
		priorRefunded: cents(0),
		idempotencyKey: idempotencyKey("rf-key-late"),
	};
}

let stub: Stub;
beforeEach(async () => {
	stub = await startStripeLikeStub();
});
afterEach(async () => {
	await stub.close();
});

/** The gateway as a site builds it, its Stripe origin pointed at the stub. */
function gateway(refundCreateTimeoutMs: number): StripePaymentGateway {
	return new StripePaymentGateway({
		secretKey: SK,
		webhookSecret: "whsec_fake",
		fetch: ((target: Parameters<typeof fetch>[0], init?: RequestInit) =>
			globalThis.fetch(String(target).replace(STRIPE_ORIGIN, stub.base), init)) as typeof fetch,
		requestTimeoutMs: 2_000,
		refundCreateTimeoutMs,
	});
}

describe("refund create: our bound passed, Stripe succeeded", () => {
	test("the late success is UNVERIFIED (never TERMINAL); a resume finds the same refund; one refund in all", async () => {
		stub.delayMs.refund = 600;
		const g = gateway(150);
		expect(await g.refund(refundInput())).toEqual({ ok: false, reason: "UNVERIFIED" });
		// Money moved at "Stripe".
		expect(stub.refunds).toHaveLength(1);

		// A resume while the abandoned create is STILL in flight (nothing aborts it):
		// the pre-flight already shows the 500 refunded, so nothing more is issued.
		expect(await g.refund(refundInput())).toMatchObject({
			ok: false,
			reason: "PROVIDER_ALREADY_REFUNDED",
		});

		// Once the original finished, a same-key create replays the SAME refund.
		await sleep(700);
		const transport = createStripeHttpTransport({ fetch: globalThis.fetch, baseUrl: stub.base });
		expect(
			await transport.createRefund({
				providerRef: "pi_paid",
				amountCents: 500,
				idempotencyKey: "rf-key-late",
				secretKey: SK,
			}),
		).toMatchObject({ ok: true, refundId: "re_1" });
		expect(stub.refunds).toHaveLength(1);
	});

	test("a same-key create while the abandoned one is in flight gets 409: retryable, not terminal", async () => {
		stub.delayMs.refund = 800;
		const transport = createStripeHttpTransport({
			fetch: globalThis.fetch,
			baseUrl: stub.base,
			createRefundTimeoutMs: 100,
		});
		const args = {
			providerRef: "pi_paid",
			amountCents: 500,
			idempotencyKey: "rf-key-409",
			secretKey: SK,
		};
		expect(await transport.createRefund(args)).toEqual({ ok: false, class: "ambiguous" });
		expect(await transport.createRefund(args)).toEqual({ ok: false, class: "retryable" });
		expect(stub.refunds).toHaveLength(1);
	});

	test("a 2xx refund body trickled past the bound is ambiguous, and the connection is released", async () => {
		stub.trickleRefundBody = true;
		const transport = createStripeHttpTransport({
			fetch: globalThis.fetch,
			baseUrl: stub.base,
			createRefundTimeoutMs: 300,
		});
		const started = Date.now();
		expect(
			await transport.createRefund({
				providerRef: "pi_paid",
				amountCents: 500,
				idempotencyKey: "rf-key-trickle",
				secretKey: SK,
			}),
		).toEqual({ ok: false, class: "ambiguous" });
		expect(Date.now() - started).toBeLessThan(600);
		// The reader is cancelled at the bound, which ends undici's connection.
		expect(await msUntilZero(() => stub.sockets.size, 8_000)).toBeGreaterThanOrEqual(0);
	}, 15_000);
});

describe("PaymentIntent create answered late", () => {
	test("the late success is retryable; a retry in flight gets 409; after it, the same intent (no orphan)", async () => {
		stub.delayMs.intent = 500;
		const transport = createStripeHttpTransport({
			fetch: globalThis.fetch,
			baseUrl: stub.base,
			requestTimeoutMs: 100,
		});
		const args = {
			orderId: "ord_1",
			amountCents: 1000,
			currency: "USD",
			idempotencyKey: "pi-key-late",
			secretKey: SK,
			description: "Order ord_1",
		};
		expect(await transport.createPaymentIntent(args)).toEqual({ ok: false, class: "retryable" });
		expect(await transport.createPaymentIntent(args)).toMatchObject({
			ok: false,
			class: "retryable",
			status: 409,
		});
		await sleep(600);
		const patient = createStripeHttpTransport({ fetch: globalThis.fetch, baseUrl: stub.base });
		expect(await patient.createPaymentIntent(args)).toMatchObject({ ok: true, intentId: "pi_1" });
		expect(stub.intents).toHaveLength(1);
	});
});
