/**
 * The PUBLIC `webhooks/stripe/settle` route (work order 02, INC-C1b), driven
 * in-process against a REAL document store, a REAL `StripePaymentGateway` and the
 * REAL `settleOrder` use-case.
 *
 * WHAT IS REAL HERE AND WHY IT HAS TO BE. The signature is produced by the
 * adapter's own offline signer and verified by the adapter's own
 * `crypto.subtle.verify`; the order is a row in a migrated SQLite database; the
 * settlement is the domain's. A fake gateway would make "a tampered body is
 * rejected" a statement about the fake. The ONLY seam is `settle`, injected so a
 * case can COUNT calls — which is how the ordering case proves the token gate
 * short-circuits before the domain is ever entered, rather than merely proving
 * the handler returned an error.
 *
 * THE SECRETS IN THIS FILE ARE FAKE and are asserted to never appear in any
 * response: every case that has a secret in scope pins the serialized result
 * against it.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	settleOrder,
	sku as toSku,
	type SettleResult,
} from "@otta-sh/domain";
import { signStripeWebhook } from "@otta-sh/payments-stripe";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../src/payment-secrets.js";
import {
	createStripeWebhookSettleHandler,
	settleResultToResponse,
	STRIPE_WEBHOOK_SETTLE_ROUTE,
	type SettleFn,
	type StripeWebhookSettleResult,
} from "../src/webhooks/stripe-settle-route.js";
import type { PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const WEBHOOK_SECRET = "whsec_test_NEVER_LEAK";
const EDGE_TOKEN = "otta_edge_NEVER_LEAK";
const AMOUNT = 1500;

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	for (const { key } of await harness.ctx.kv.list()) await harness.ctx.kv.delete(key);
});

afterAll(async () => {
	await harness?.close();
});

/** A pending, digital, stripe-paid order — the state a delivery settles. */
async function seedPendingOrder(id: string): Promise<void> {
	const usd = toCurrency("USD");
	await harness.stores.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
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

interface Delivery {
	rawBodyBase64: string;
	stripeSignature: string;
	idempotencyKey: string;
}

/** Sign a delivery for `orderId` and shape it the way the calling site sends it:
 *  the EXACT bytes, base64-encoded, because the route framework JSON-parses the
 *  body and a re-serialized object would never verify. */
async function signedDelivery(
	orderId: string,
	options: { eventId?: string; secret?: string; amountCents?: number } = {},
): Promise<Delivery> {
	const signed = await signStripeWebhook(
		{
			eventId: options.eventId ?? `evt_${orderId}`,
			type: "payment_intent.succeeded",
			paymentIntentId: `pi_${orderId}`,
			orderId,
			amountCents: options.amountCents ?? AMOUNT,
			currency: "usd",
		},
		options.secret ?? WEBHOOK_SECRET,
	);
	return {
		rawBodyBase64: Buffer.from(signed.body).toString("base64"),
		stripeSignature: signed.signatureHeader,
		idempotencyKey: `wh-${options.eventId ?? orderId}`,
	};
}

/** A settle seam that DELEGATES to the real use-case while recording every call
 *  and its result — a counter, not a stub. */
function recordingSettle(): { settle: SettleFn; calls: SettleResult[] } {
	const calls: SettleResult[] = [];
	const settle: SettleFn = async (deps, gateway, raw) => {
		const result = await settleOrder(deps, gateway, raw);
		calls.push(result);
		return result;
	};
	return { settle, calls };
}

/**
 * Invoke the handler the way a host does.
 *
 * `headers` takes BOTH shapes a host actually passes, because the two deployment
 * modes disagree about it: a SANDBOXED plugin is handed a plain record (the
 * `SandboxedRequest` these types describe), while a TRUSTED one — which is how
 * `sites/staging` registers Otta — is handed EmDash's `guardConsumedRequestBody`
 * proxy over the genuine `Request`, whose `.headers` is a real `Headers`. The
 * type annotation describes only the first, so the second is asserted through
 * rather than trusted.
 */
async function invoke(
	input: unknown,
	headers: Record<string, string> | Headers = {},
	options: { settle?: SettleFn; ctx?: PluginContext } = {},
): Promise<StripeWebhookSettleResult> {
	const handler = createStripeWebhookSettleHandler(
		options.settle === undefined ? {} : { settle: options.settle },
	);
	const result = await handler(
		{
			input: input as never,
			request: {
				method: "POST",
				url: "/route",
				headers: headers as unknown as Record<string, string>,
			},
		},
		options.ctx ?? harness.ctx,
	);
	return result as StripeWebhookSettleResult;
}

async function orderState(id: string): Promise<string | undefined> {
	return (await harness.stores.orderStore.getById(toOrderId(id)))?.state;
}

describe("the route's identity", () => {
	test("the path names what it does, in the repo's <area>/<thing>/<verb> convention", () => {
		expect(STRIPE_WEBHOOK_SETTLE_ROUTE).toBe("webhooks/stripe/settle");
	});

	test("the status table is byte-for-byte the service's own (webhooks.ts)", () => {
		// A drift here silently changes STRIPE'S RETRY BEHAVIOUR, which is the one
		// thing the fold-in must not change while swapping the transport.
		expect(settleResultToResponse({ ok: true, order: null, noop: false })).toEqual({
			ok: true,
			status: 200,
		});
		expect(settleResultToResponse({ ok: false, reason: "INVALID_SIGNATURE" })).toEqual({
			ok: false,
			status: 400,
			reason: "INVALID_SIGNATURE",
		});
		expect(settleResultToResponse({ ok: false, reason: "MALFORMED" })).toMatchObject({
			status: 400,
		});
		expect(settleResultToResponse({ ok: false, reason: "UNKNOWN_EVENT" })).toMatchObject({
			status: 400,
		});
		expect(settleResultToResponse({ ok: false, reason: "ORDER_NOT_FOUND" })).toMatchObject({
			status: 404,
		});
		// 200, not an error: a mismatch is a recorded anomaly no retry can fix.
		expect(settleResultToResponse({ ok: false, reason: "AMOUNT_MISMATCH" })).toMatchObject({
			status: 200,
		});
	});
});

describe("(i) a valid token and a correct signature settle the order, once", () => {
	test("settleOrder runs exactly once and the order is paid", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-happy");
		const { settle, calls } = recordingSettle();

		const res = await invoke(
			await signedDelivery("ord-happy"),
			{ [WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN },
			{ settle },
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ ok: true, noop: false });
		expect(await orderState("ord-happy")).toBe("paid");
		// No secret of either kind rode out on the response.
		expect(JSON.stringify(res)).not.toContain(WEBHOOK_SECRET);
		expect(JSON.stringify(res)).not.toContain(EDGE_TOKEN);
	});

	test("the header is matched case-insensitively (HTTP header names are)", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-case");
		const res = await invoke(await signedDelivery("ord-case"), {
			"x-otta-wh-token": EDGE_TOKEN,
		});
		expect(res).toEqual({ ok: true, status: 200 });
	});

	test("a REAL `Headers` instance carries the token too — TRUSTED mode hands one over", async () => {
		// The shape, not the casing, is the point. `sites/staging` registers this
		// plugin with no `sandboxed:` key, and EmDash's trusted `PluginRouteHandler`
		// therefore passes the genuine `Request` (wrapped in
		// `guardConsumedRequestBody`), whose `.headers` is a `Headers` INSTANCE and
		// not the sandbox's plain record. `Object.entries(new Headers({…}))` is `[]`
		// — its entries are behind an iterator, not own properties — so a lookup
		// that only enumerates own entries sees NO headers at all and 401s every
		// genuine delivery the moment an edge token is provisioned. That is the
		// whole feature failing closed in exactly the deployment that ships it.
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-headers");

		const res = await invoke(
			await signedDelivery("ord-headers"),
			new Headers({ [WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN }),
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(await orderState("ord-headers")).toBe("paid");
	});

	test("a WRONG token in a real `Headers` is still refused — the shape is not a bypass", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-headers-wrong");
		const { settle, calls } = recordingSettle();

		const res = await invoke(
			await signedDelivery("ord-headers-wrong"),
			new Headers({ [WEBHOOK_EDGE_TOKEN_HEADER]: "otta_edge_WRONG" }),
			{ settle },
		);

		expect(res).toEqual({ ok: false, status: 401, reason: "UNAUTHORIZED" });
		expect(calls).toHaveLength(0);
		expect(await orderState("ord-headers-wrong")).toBe("pending");
	});
});

describe("(ii) a tampered body is rejected and settles NOTHING", () => {
	test("INVALID_SIGNATURE, and the order is still pending in the real store", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-tamper");
		const delivery = await signedDelivery("ord-tamper");
		// Flip the amount in the BODY, leaving the signature that covered the
		// original bytes — the forgery a signature exists to stop.
		const tampered = Buffer.from(delivery.rawBodyBase64, "base64")
			.toString("utf8")
			.replace(`"amount":${AMOUNT}`, `"amount":1`);
		const { settle, calls } = recordingSettle();

		const res = await invoke(
			{ ...delivery, rawBodyBase64: Buffer.from(tampered, "utf8").toString("base64") },
			{ [WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN },
			{ settle },
		);

		expect(res).toEqual({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });
		// The DOMAIN's own verdict, not just the handler's: the use-case ran and
		// refused at verification.
		expect(calls).toEqual([{ ok: false, reason: "INVALID_SIGNATURE" }]);
		// And the state that matters is untouched: nothing was committed.
		expect(await orderState("ord-tamper")).toBe("pending");
		// The dedupe row was never claimed either — proven by claiming it now.
		await expect(
			harness.stores.paymentEventStore.dedupe(
				"evt_ord-tamper",
				toOrderId("ord-tamper"),
				"stripe",
				new Date().toISOString(),
			),
		).resolves.toBe(true);
	});

	test("a body signed with the WRONG secret is refused just as hard", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-wrongsec");
		const res = await invoke(await signedDelivery("ord-wrongsec", { secret: "whsec_attacker" }));
		expect(res).toEqual({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });
		expect(await orderState("ord-wrongsec")).toBe("pending");
	});
});

describe("(iii) the token gate runs FIRST — the ordering is the security property", () => {
	/** A ctx whose kv records the ORDER of every read. */
	function recordingCtx(): { ctx: PluginContext; reads: string[] } {
		const reads: string[] = [];
		const kv = harness.ctx.kv;
		return {
			reads,
			ctx: {
				...harness.ctx,
				kv: {
					...kv,
					get<T>(key: string): Promise<T | null> {
						reads.push(key);
						return kv.get<T>(key);
					},
				},
			},
		};
	}

	test("a WRONG token: rejected before stripeWebhookSecret is read and before settle", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-wrongtok");
		const { ctx, reads } = recordingCtx();
		const { settle, calls } = recordingSettle();

		const res = await invoke(
			await signedDelivery("ord-wrongtok"),
			{ [WEBHOOK_EDGE_TOKEN_HEADER]: "otta_edge_WRONG" },
			{ ctx, settle },
		);

		expect(res).toEqual({ ok: false, status: 401, reason: "UNAUTHORIZED" });
		// THE ORDERING, asserted as an ordering: the edge token is the FIRST and
		// ONLY key read, and the signing secret is never touched.
		expect(reads).toEqual([WEBHOOK_EDGE_TOKEN_KEY]);
		expect(reads).not.toContain(STRIPE_WEBHOOK_SECRET_KEY);
		// And the domain was never entered at all.
		expect(calls).toHaveLength(0);
		expect(await orderState("ord-wrongtok")).toBe("pending");
	});

	test("a MISSING token header, with the key set: same short-circuit", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		const { ctx, reads } = recordingCtx();
		const { settle, calls } = recordingSettle();
		const res = await invoke(await signedDelivery("ord-none"), {}, { ctx, settle });
		expect(res).toEqual({ ok: false, status: 401, reason: "UNAUTHORIZED" });
		expect(reads).toEqual([WEBHOOK_EDGE_TOKEN_KEY]);
		expect(calls).toHaveLength(0);
	});

	test("a rejection never echoes the expected token, in any field", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		const res = await invoke(await signedDelivery("ord-leak"), {
			[WEBHOOK_EDGE_TOKEN_HEADER]: "otta_edge_WRONG",
		});
		expect(JSON.stringify(res)).not.toContain(EDGE_TOKEN);
	});

	test("a token that is a PREFIX of the real one is refused (length is not a pass)", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		const res = await invoke(await signedDelivery("ord-prefix"), {
			[WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN.slice(0, EDGE_TOKEN.length - 1),
		});
		expect(res).toMatchObject({ status: 401, reason: "UNAUTHORIZED" });
	});
});

describe("(iv) replay: the DOMAIN's dedupe is the defense, and it holds", () => {
	test("the same signed delivery twice settles once and the second is a no-op", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-replay");
		const delivery = await signedDelivery("ord-replay");
		const { settle, calls } = recordingSettle();

		const first = await invoke(delivery, {}, { settle });
		const second = await invoke(delivery, {}, { settle });

		// Stripe sees 200 both times — a retry must stop, not escalate.
		expect(first).toEqual({ ok: true, status: 200 });
		expect(second).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ ok: true, noop: false });
		expect(calls[1]).toMatchObject({ ok: true, noop: true });
		expect(await orderState("ord-replay")).toBe("paid");
		// EXACTLY ONE dedupe row for the event id: claiming it again now fails,
		// which is only possible if the two deliveries left one row between them.
		await expect(
			harness.stores.paymentEventStore.dedupe(
				"evt_ord-replay",
				toOrderId("ord-replay"),
				"stripe",
				new Date().toISOString(),
			),
		).resolves.toBe(false);
	});
});

describe("(v) an UNSET edge token passes through — but never disables the HMAC", () => {
	test("unset token + correct signature ⇒ settled (a missing token is not a lockout)", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-passthrough");
		const res = await invoke(await signedDelivery("ord-passthrough"));
		expect(res).toEqual({ ok: true, status: 200 });
		expect(await orderState("ord-passthrough")).toBe("paid");
	});

	test("unset token + TAMPERED body ⇒ still rejected (the HMAC is unconditional)", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-passthrough-bad");
		const delivery = await signedDelivery("ord-passthrough-bad");
		const tampered = Buffer.from(delivery.rawBodyBase64, "base64")
			.toString("utf8")
			.replace("ord-passthrough-bad", "ord-passthrough-xxx");
		const res = await invoke({
			...delivery,
			rawBodyBase64: Buffer.from(tampered, "utf8").toString("base64"),
		});
		expect(res).toEqual({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });
		expect(await orderState("ord-passthrough-bad")).toBe("pending");
	});

	test("an EMPTY stored token is 'unset', not 'the empty string is the password'", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, "");
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-emptytok");
		const res = await invoke(await signedDelivery("ord-emptytok"));
		expect(res).toEqual({ ok: true, status: 200 });
	});
});

describe("(vii) the new secret is fail-closed and leaks nothing", () => {
	test("a kv read that REJECTS degrades the token gate to pass-through, never a throw", async () => {
		// Fail-closed for this key means "cannot prove the operator set one", and
		// the HMAC below is what still stands between a forgery and a settlement.
		const failingCtx: PluginContext = {
			...harness.ctx,
			kv: {
				...harness.ctx.kv,
				get<T>(key: string): Promise<T | null> {
					if (key === WEBHOOK_EDGE_TOKEN_KEY) throw new Error(`kv unavailable: ${key}`);
					return harness.ctx.kv.get<T>(key);
				},
			},
		};
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-kvfail");
		const res = await invoke(await signedDelivery("ord-kvfail"), {}, { ctx: failingCtx });
		expect(res).toEqual({ ok: true, status: 200 });
	});

	test("a kv OUTAGE on the signing secret is 503 NOT_CONFIGURED, not a false 400", async () => {
		// 400 would tell Stripe the delivery was bad. The truth is that this
		// deployment cannot verify anything, so it must not settle and must not lie.
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await seedPendingOrder("ord-noconf");
		const { settle, calls } = recordingSettle();
		const res = await invoke(
			await signedDelivery("ord-noconf"),
			{ [WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN },
			{ settle },
		);
		expect(res).toEqual({ ok: false, status: 503, reason: "NOT_CONFIGURED" });
		expect(calls).toHaveLength(0);
		expect(await orderState("ord-noconf")).toBe("pending");
	});

	test("a malformed request is a 400 that names no secret and touches no order", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		const { settle, calls } = recordingSettle();
		for (const input of [
			{},
			{ rawBodyBase64: "", stripeSignature: "t=1,v1=x", idempotencyKey: "k" },
			{ rawBodyBase64: "!!!not base64!!!", stripeSignature: "t=1,v1=x", idempotencyKey: "k" },
			{ rawBodyBase64: "eyJhIjoxfQ==", stripeSignature: "t=1,v1=x" },
		]) {
			const res = await invoke(input, {}, { settle });
			expect(res).toMatchObject({ ok: false, status: 400, reason: "MALFORMED" });
			expect(JSON.stringify(res)).not.toContain(WEBHOOK_SECRET);
		}
		expect(calls).toHaveLength(0);
	});

	test("an unknown order is 404 — the delivery verified, there was nothing to settle", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		const res = await invoke(await signedDelivery("ord-absent"));
		expect(res).toEqual({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });
	});
});
