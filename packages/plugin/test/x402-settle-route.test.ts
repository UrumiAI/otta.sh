/**
 * The PUBLIC `entitlements/x402/settle` route (INC-C5 revision, review A1/B5) —
 * the in-process replacement for the service's `POST /entitlements/grant`.
 *
 * WHY THIS FILE EXISTS AT ALL. Before it, `settleOrder(gateway, {kind:
 * "page_gate"})` had exactly ONE caller in the repo — a route on the commerce
 * service that INC-D3b deletes. The in-process build wired an x402 gateway that
 * nothing could drive in either direction, so the x402 half was a functional
 * regression waiting for the staging flip. This route is the missing half.
 *
 * WHAT IS REAL HERE. The store is a migrated SQLite database, the settlement is
 * the domain's own `settleOrder`, and the gateway is a real `X402PaymentGateway`
 * over a real `createHttpFacilitator` — the ONLY fake is the facilitator's HTTP
 * response, which is the remote service and cannot be anything else. That is the
 * same discipline `stripe-settle-route.test.ts` keeps, and for the same reason: a
 * fake gateway would make every assertion here a statement about the fake.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
	X402_FACILITATOR_API_KEY_KEY,
} from "../src/payment-secrets.js";
import { X402_PAYTO_KEY } from "../src/payments/x402-wiring.js";
import {
	createX402SettleHandler,
	X402_SETTLE_ROUTE,
	type X402SettleResult,
} from "../src/payments/x402-settle-route.js";
import type { PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const FACILITATOR_URL = "https://facilitator.example.test/verify";
const PAY_TO = "0x00000000000000000000000000000000000000a1";
const AMOUNT = 2599;

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	for (const { key } of await harness.ctx.kv.list()) await harness.ctx.kv.delete(key);
	await harness.ctx.kv.set(X402_PAYTO_KEY, PAY_TO);
	await harness.ctx.kv.set(X402_FACILITATOR_API_KEY_KEY, "fac_key_NEVER_LEAK");
});

afterAll(async () => {
	await harness?.close();
});

/** A pending, digital order — x402-paid by default, which is the state a
 *  page-gate proof settles. `paymentMethod` is a parameter because the route's
 *  CHECK 2 is precisely about the other value. */
async function seedPendingOrder(
	id: string,
	paymentMethod: "x402" | "stripe" = "x402",
): Promise<void> {
	const usd = toCurrency("USD");
	await harness.stores.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod,
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Digital Widget",
				unitPrice: cents(AMOUNT),
				currency: usd,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(AMOUNT), total: cents(AMOUNT), currency: usd },
	});
}

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "33333333-3333-4333-8333-333333333333";

function proofFor(
	orderId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		orderId,
		transaction: `0xtx-${orderId}`,
		network: "eip155:8453",
		payer: "0xbuyer",
		amount: AMOUNT,
		currency: "USD",
		// Not an HMAC: the facilitator, not a secret this process holds, decides.
		signature: "facilitator-receipt",
		...overrides,
	};
}

/** A context whose `ctx.http` answers as the facilitator. The harness's own
 *  context rejects every fetch (in-process commerce makes none), so this is the
 *  one egress the route is allowed and it is visible in every case. */
function ctxWithFacilitator(respond: (body: unknown) => Response | Promise<Response>): {
	ctx: PluginContext;
	calls: Array<{ url: string; body: unknown }>;
} {
	const calls: Array<{ url: string; body: unknown }> = [];
	const ctx: PluginContext = {
		...harness.ctx,
		http: {
			async fetch(url: string, init?: RequestInit): Promise<Response> {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				calls.push({ url, body });
				return respond(body);
			},
		},
	};
	return { ctx, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
}

/** `null` for "this bundle baked no facilitator URL" — NOT `undefined`, which a
 *  default parameter would quietly replace with the configured one. */
async function invoke(
	input: unknown,
	ctx: PluginContext,
	facilitatorUrl: string | null = FACILITATOR_URL,
	headers: Record<string, string> = {},
): Promise<X402SettleResult> {
	const handler = createX402SettleHandler({
		egress: facilitatorUrl === null ? {} : { facilitatorUrl },
	});
	const result = await handler(
		{ input: input as never, request: { method: "POST", url: "/route", headers } },
		ctx,
	);
	return result as X402SettleResult;
}

async function orderState(id: string): Promise<string | undefined> {
	return (await harness.stores.orderStore.getById(toOrderId(id)))?.state;
}

describe("the route's identity", () => {
	test("the path names what it does, in the repo's <area>/<thing>/<verb> convention", () => {
		expect(X402_SETTLE_ROUTE).toBe("entitlements/x402/settle");
	});
});

describe("settling a verified page-gate proof", () => {
	test("a proof the facilitator accepts settles the order and grants the entitlement", async () => {
		await seedPendingOrder(ORDER_A);
		const { ctx, calls } = ctxWithFacilitator((body) =>
			jsonResponse({
				valid: true,
				// The binding INC-C5 added: the answer echoes the question.
				transaction: (body as { transaction?: string }).transaction,
				orderId: (body as { orderId?: string }).orderId,
			}),
		);

		const res = await invoke(proofFor(ORDER_A), ctx);
		expect(res).toEqual({ ok: true, status: 200 });
		expect(await orderState(ORDER_A)).toBe("paid");
		// The verification went over ctx.http to the configured facilitator — the
		// gated egress, never an offline shared secret this process holds.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(FACILITATOR_URL);
	});

	test("REPLAY is the domain's job: the same proof twice leaves one payment", async () => {
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator((body) =>
			jsonResponse({ valid: true, transaction: (body as { transaction?: string }).transaction }),
		);
		expect(await invoke(proofFor(ORDER_A), ctx)).toEqual({ ok: true, status: 200 });
		const again = await invoke(proofFor(ORDER_A), ctx);
		expect(again.ok).toBe(true);
		expect(await orderState(ORDER_A)).toBe("paid");
	});

	test("the response carries NO order body — this route is PUBLIC", async () => {
		// The service's `POST /entitlements/grant` returned the FULL serialized
		// order, which it could afford because `requireInternalToken` stood in
		// front of it. There is no such gate in-process (see the module doc), so
		// the receipt states the outcome and nothing about the buyer. The caller
		// re-reads the order through the capability URL it already holds.
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator((body) =>
			jsonResponse({ valid: true, transaction: (body as { transaction?: string }).transaction }),
		);
		const res = await invoke(proofFor(ORDER_A), ctx);
		expect(JSON.stringify(res)).not.toContain("buyer@example.com");
		expect(res).not.toHaveProperty("order");
	});
});

describe("refusals, each for its own reason", () => {
	test("a proof the facilitator REJECTS does not settle anything", async () => {
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator(() => jsonResponse({ valid: false }));
		expect(await invoke(proofFor(ORDER_A), ctx)).toEqual({
			ok: false,
			status: 400,
			reason: "INVALID_SIGNATURE",
		});
		expect(await orderState(ORDER_A)).toBe("pending");
	});

	test("an answer that does not echo the question is UNAVAILABLE, not a verdict", async () => {
		// B7 refuses it; review round 2's A4 fixes HOW. `{valid: true}` about some
		// OTHER transaction is not an answer about this one — but it is equally not
		// a verdict that THIS receipt is bad. Classifying it terminal would let a
		// buggy or confused facilitator permanently refuse a buyer whose USDC has
		// already moved, which is the exact failure round 1 introduced `unavailable`
		// to prevent. "Could not be asked" is the honest reading, so: 503, retryable.
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator(() =>
			jsonResponse({ valid: true, transaction: "0xsomeone-elses" }),
		);
		expect(await invoke(proofFor(ORDER_A), ctx)).toEqual({
			ok: false,
			status: 503,
			reason: "FACILITATOR_UNAVAILABLE",
		});
		expect(await orderState(ORDER_A)).toBe("pending");
	});

	test("ONE receipt settles ONE order: the same transaction aimed at a SECOND order is refused", async () => {
		// A1/B1, at the route. `settleOrder` used to DISCARD `dedupe(...)`'s answer,
		// so a receipt already bound to order A, resubmitted with orderId = order B,
		// settled B — and `recordPayment` then conflicted on the globally-unique
		// provider_ref and silently recorded nothing, so the ledger did not even
		// show it. One on-chain payment, two entitlements, no trace.
		await seedPendingOrder(ORDER_A);
		await seedPendingOrder(ORDER_B);
		const { ctx } = ctxWithFacilitator((body) =>
			jsonResponse({
				valid: true,
				transaction: (body as { transaction?: string }).transaction,
				orderId: (body as { orderId?: string }).orderId,
			}),
		);

		const shared = { transaction: "0xtx-shared-receipt" };
		expect(await invoke(proofFor(ORDER_A, shared), ctx)).toEqual({ ok: true, status: 200 });
		// Same tx hash, different order. The facilitator says valid — it is a real
		// on-chain payment — and the refusal has to come from the binding, not it.
		expect(await invoke(proofFor(ORDER_B, shared), ctx)).toEqual({
			ok: false,
			status: 400,
			reason: "RECEIPT_REBOUND",
		});
		expect(await orderState(ORDER_A)).toBe("paid");
		expect(await orderState(ORDER_B)).toBe("pending");
	});

	test("a NON-x402 order is refused before any egress — a public route is not a bypass", async () => {
		// A1/B1's other half. This route is `public: true`, replacing a service
		// endpoint that sat behind `requireInternalToken`. Without this check an
		// anonymous POST naming a STRIPE order plus any receipt the facilitator
		// happens to call valid would settle an order nobody paid for through x402.
		await seedPendingOrder(ORDER_A, "stripe");
		const { ctx, calls } = ctxWithFacilitator((body) =>
			jsonResponse({ valid: true, transaction: (body as { transaction?: string }).transaction }),
		);
		expect(await invoke(proofFor(ORDER_A), ctx)).toEqual({
			ok: false,
			status: 400,
			reason: "WRONG_PAYMENT_METHOD",
		});
		expect(await orderState(ORDER_A)).toBe("pending");
		// And it cost no metered third-party call: the check is before the ask.
		expect(calls).toHaveLength(0);
	});
});

describe("the edge-token gate — the same cheap outer layer the Stripe route has", () => {
	test("UNSET is pass-through, exactly as `webhooks/stripe/settle` behaves", async () => {
		// B2. Provisioning is optional and an un-provisioned deploy must degrade to
		// "facilitator + binding only", never to "nothing works".
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator((body) =>
			jsonResponse({ valid: true, transaction: (body as { transaction?: string }).transaction }),
		);
		expect(await invoke(proofFor(ORDER_A), ctx)).toEqual({ ok: true, status: 200 });
	});

	test("SET and absent/wrong is 401 BEFORE the facilitator is asked", async () => {
		// The point of a cheap outer gate on a public POST that spends metered
		// egress: an unattributed request is refused without costing a call.
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, "edge_tok");
		await seedPendingOrder(ORDER_A);
		for (const headers of [{}, { [WEBHOOK_EDGE_TOKEN_HEADER.toLowerCase()]: "wrong" }]) {
			const { ctx, calls } = ctxWithFacilitator(() => jsonResponse({ valid: true }));
			expect(await invoke(proofFor(ORDER_A), ctx, FACILITATOR_URL, headers)).toEqual({
				ok: false,
				status: 401,
				reason: "UNAUTHORIZED",
			});
			expect(calls).toHaveLength(0);
		}
		expect(await orderState(ORDER_A)).toBe("pending");
	});

	test("SET and matching passes through to the real checks", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, "edge_tok");
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator((body) =>
			jsonResponse({ valid: true, transaction: (body as { transaction?: string }).transaction }),
		);
		const res = await invoke(proofFor(ORDER_A), ctx, FACILITATOR_URL, {
			[WEBHOOK_EDGE_TOKEN_HEADER.toLowerCase()]: "edge_tok",
		});
		expect(res).toEqual({ ok: true, status: 200 });
	});

	test("the token is NEVER the trust anchor: a good token cannot settle a bad proof", async () => {
		// Stated as a test because the whole risk of adding a cheap gate is that a
		// later reader mistakes it for the real one.
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, "edge_tok");
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator(() => jsonResponse({ valid: false }));
		expect(
			await invoke(proofFor(ORDER_A), ctx, FACILITATOR_URL, {
				[WEBHOOK_EDGE_TOKEN_HEADER.toLowerCase()]: "edge_tok",
			}),
		).toMatchObject({ ok: false, reason: "INVALID_SIGNATURE" });
		expect(await orderState(ORDER_A)).toBe("pending");
	});
});

describe("refusals, continued: configuration and shape", () => {
	test("an unknown order is 404, distinct from a rejected proof", async () => {
		const { ctx } = ctxWithFacilitator((body) =>
			jsonResponse({ valid: true, transaction: (body as { transaction?: string }).transaction }),
		);
		const missing = "22222222-2222-4222-8222-222222222222";
		expect(await invoke(proofFor(missing), ctx)).toMatchObject({ status: 404 });
	});

	test.each([
		["no orderId", { orderId: undefined }],
		["a non-UUID orderId", { orderId: "not-a-uuid" }],
		["no transaction", { transaction: "" }],
		["a negative amount", { amount: -1 }],
		["a fractional amount", { amount: 10.5 }],
		["a non-ISO currency", { currency: "dollars" }],
		["no signature", { signature: "" }],
	])("a malformed body is 400 and never reaches the facilitator (%s)", async (_why, override) => {
		const { ctx, calls } = ctxWithFacilitator(() => jsonResponse({ valid: true }));
		const res = await invoke(proofFor(ORDER_A, override), ctx);
		expect(res).toEqual({ ok: false, status: 400, reason: "MALFORMED" });
		// Validation runs BEFORE egress: a garbage body costs no network call.
		expect(calls).toHaveLength(0);
	});

	test("an UNREACHABLE facilitator is 503 RETRYABLE, never a terminal 400", async () => {
		// B2, end to end. The buyer's money has already moved on-chain; a transient
		// facilitator outage must not turn into a permanent refusal that a retry
		// can never undo. `X402FacilitatorUnavailableError` is what carries that
		// distinction out of the adapter, and this is where it becomes a status.
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator(() => jsonResponse({ error: "upstream" }, 503));
		expect(await invoke(proofFor(ORDER_A), ctx)).toEqual({
			ok: false,
			status: 503,
			reason: "FACILITATOR_UNAVAILABLE",
		});
		// Nothing was decided, so nothing moved.
		expect(await orderState(ORDER_A)).toBe("pending");
	});

	test("a deployment with NO facilitator URL is 503 NOT_CONFIGURED, not a rejection", async () => {
		await seedPendingOrder(ORDER_A);
		const { ctx, calls } = ctxWithFacilitator(() => jsonResponse({ valid: true }));
		expect(await invoke(proofFor(ORDER_A), ctx, null)).toEqual({
			ok: false,
			status: 503,
			reason: "NOT_CONFIGURED",
		});
		expect(calls).toHaveLength(0);
	});

	test("a deployment with no payTo is 503 NOT_CONFIGURED — the gateway never arms", async () => {
		await harness.ctx.kv.delete(X402_PAYTO_KEY);
		await seedPendingOrder(ORDER_A);
		const { ctx } = ctxWithFacilitator(() => jsonResponse({ valid: true }));
		expect(await invoke(proofFor(ORDER_A), ctx)).toMatchObject({
			status: 503,
			reason: "NOT_CONFIGURED",
		});
	});

	test("no credential reaches the response, on any arm", async () => {
		await seedPendingOrder(ORDER_A);
		for (const respond of [
			() => jsonResponse({ valid: false }),
			() => jsonResponse({ error: "upstream" }, 503),
			() => Promise.reject(new Error("facilitator down at fac_key_NEVER_LEAK")),
		]) {
			const { ctx } = ctxWithFacilitator(respond as never);
			const res = await invoke(proofFor(ORDER_A), ctx);
			expect(JSON.stringify(res)).not.toContain("fac_key_NEVER_LEAK");
		}
	});
});
