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
	type EmailSender,
	type SettleResult,
} from "@otta-sh/domain";
import { FakeEmailSender } from "@otta-sh/domain/testing";
import { signStripeWebhook } from "@otta-sh/payments-stripe";
import { EmdashOrderStore, StorageContentionError } from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../src/payment-secrets.js";
import {
	createStripeWebhookSettleHandler,
	SETTLE_PROVIDER_TIMEOUT_MS,
	settleResultToResponse,
	STRIPE_WEBHOOK_SETTLE_ROUTE,
	type SettleFn,
	type StripeWebhookSettleResult,
} from "../src/webhooks/stripe-settle-route.js";
import {
	ORDER_EMAIL_INLINE_DEADLINE_MS,
	type SendOrderEmailsNowOptions,
} from "../src/email/send-order-emails-now.js";
import { SETTLE_REQUEST_BUDGET_MS } from "../src/settle-deadline.js";
import type { EmailMessage, PluginContext } from "../src/types.js";
import { chargeRefundedEvent, signedStripeEvent } from "./helpers/signed-stripe-event.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";
import { runUnderFakeTime } from "./helpers/run-under-fake-time.js";

const WEBHOOK_SECRET = "whsec_test_NEVER_LEAK";
const EDGE_TOKEN = "otta_edge_NEVER_LEAK";
const AMOUNT = 1500;

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	for (const { key } of await harness.ctx.kv.list()) await harness.ctx.kv.delete(key);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
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
 * `headers` takes both container shapes the lookup tolerates. The plain record
 * is the REAL one: EmDash wraps this `format: "standard"` plugin in
 * `adaptSandboxEntry`, which flattens `ctx.request.headers` into a lowercase
 * `Record<string, string>` before the handler runs — in the in-process
 * registration as well as the sandboxed one. A real `Headers` is accepted here
 * only because `header()` defensively supports it; the type annotation describes
 * the record, so the other shape is asserted through rather than typed.
 */
async function invoke(
	input: unknown,
	headers: Record<string, string> | Headers = {},
	options: {
		settle?: SettleFn;
		ctx?: PluginContext;
		orderEmails?: SendOrderEmailsNowOptions;
		now?: () => number;
	} = {},
): Promise<StripeWebhookSettleResult> {
	const handler = createStripeWebhookSettleHandler({
		...(options.settle === undefined ? {} : { settle: options.settle }),
		...(options.orderEmails === undefined ? {} : { orderEmails: options.orderEmails }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
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

	test("the status table is the service's own (webhooks.ts), except UNKNOWN_EVENT is acknowledged", () => {
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
		// 200, not 400 (#300): UNKNOWN_EVENT is only ever produced AFTER the
		// signature verified, so it is a genuine Stripe delivery of a type Otta does
		// not act on. A 4xx makes Stripe retry it and, eventually, disable the
		// endpoint — taking `payment_intent.succeeded` down with it.
		expect(settleResultToResponse({ ok: false, reason: "UNKNOWN_EVENT" })).toEqual({
			ok: false,
			status: 200,
			reason: "UNKNOWN_EVENT",
		});
		expect(settleResultToResponse({ ok: false, reason: "ORDER_NOT_FOUND" })).toMatchObject({
			status: 404,
		});
		// 200, not an error: a mismatch is a recorded anomaly no retry can fix.
		expect(settleResultToResponse({ ok: false, reason: "AMOUNT_MISMATCH" })).toMatchObject({
			status: 200,
		});
		// 503, the one failure a REDELIVERY fixes: a late payment's automatic refund
		// hit a transient Stripe error, and the retry resumes that same refund.
		expect(settleResultToResponse({ ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" })).toEqual({
			ok: false,
			status: 503,
			reason: "LATE_PAYMENT_REFUND_RETRYABLE",
			// The BUSY convention: a 503 that says "the same delivery will work later"
			// carries `retryable`, which is what the site keys its Retry-After on.
			retryable: true,
		});
	});

	test("a late payment's refund (a pre-flight read + a create) fits inside Stripe's ~10 s delivery window", () => {
		expect(SETTLE_PROVIDER_TIMEOUT_MS * 2).toBeLessThanOrEqual(6_000);
	});

	test("settle gets a REFUND-CAPABLE gateway when a secret key is configured, a verify-only one otherwise", async () => {
		// A late payment is refunded INSIDE settle, through the gateway this route
		// builds. Verify-only (`refundable: false`) is the honest fallback: settle then
		// flags the order for a manual refund rather than pretending to issue one.
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		const seen: boolean[] = [];
		const settle: SettleFn = async (deps, gateway, raw) => {
			seen.push(gateway.refundable);
			return settleOrder(deps, gateway, raw);
		};
		await seedPendingOrder("ord-gw-a");
		expect((await invoke(await signedDelivery("ord-gw-a"), {}, { settle })).ok).toBe(true);

		await harness.ctx.kv.set(STRIPE_SECRET_KEY_KEY, "sk_test_settle_route");
		await seedPendingOrder("ord-gw-b");
		expect((await invoke(await signedDelivery("ord-gw-b"), {}, { settle })).ok).toBe(true);

		expect(seen).toEqual([false, true]);
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

	test("a REAL `Headers` instance carries the token too — the defensive branch works", async () => {
		// Coverage for a container shape `header()` supports DEFENSIVELY, not one
		// this deployment currently hands over. Today EmDash wraps every
		// `format: "standard"` plugin whose definition has no top-level `id` — which
		// Otta's does not — in `adaptSandboxEntry`, and that adapter flattens
		// `request.headers` into a plain lowercase record before the handler runs,
		// in-process registration included. So the record cases above are the live
		// path; this one pins the fallback.
		//
		// It is worth pinning because the failure would be silent:
		// `Object.entries(new Headers({…}))` is `[]` — a `Headers`' entries live
		// behind an iterator, not on the object — so a lookup that only enumerates
		// own properties would read NO header and 401 every delivery the moment an
		// edge token is provisioned. If a future dispatch path ever passes a real
		// `Request` through, this test is what catches it before a deploy does.
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

describe("(viii) a VERIFIED event Otta does not handle is acknowledged, and touches nothing (#300)", () => {
	test("a correctly signed `charge.refunded` is 200 and leaves the order exactly as it was", async () => {
		await harness.ctx.kv.set(WEBHOOK_EDGE_TOKEN_KEY, EDGE_TOKEN);
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-refunded");
		const before = await harness.stores.orderStore.getById(toOrderId("ord-refunded"));
		const { settle, calls } = recordingSettle();

		const res = await invoke(
			signedStripeEvent(
				chargeRefundedEvent("ord-refunded", AMOUNT),
				WEBHOOK_SECRET,
				"wh-refund-ord-refunded",
			),
			{ [WEBHOOK_EDGE_TOKEN_HEADER]: EDGE_TOKEN },
			{ settle },
		);

		// 200 so Stripe stops retrying — a 4xx here is what gets an endpoint
		// disabled, and with it every `payment_intent.succeeded` after.
		expect(res).toEqual({ ok: false, status: 200, reason: "UNKNOWN_EVENT" });
		// The DOMAIN's verdict: the signature verified and the type was refused
		// there, so this is not the route guessing.
		expect(calls).toEqual([{ ok: false, reason: "UNKNOWN_EVENT" }]);
		// Nothing done: the order is byte-for-byte what it was...
		expect(await harness.stores.orderStore.getById(toOrderId("ord-refunded"))).toEqual(before);
		// ...and no delivery was recorded against it — proven by claiming it now.
		await expect(
			harness.stores.paymentEventStore.dedupe(
				"evt_refund_ord-refunded",
				toOrderId("ord-refunded"),
				"stripe",
				new Date().toISOString(),
			),
		).resolves.toBe(true);
	});

	test("the same event type under a BAD signature is still a 400 — the 200 needs a verified body", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-refunded-forged");
		const res = await invoke(
			signedStripeEvent(
				chargeRefundedEvent("ord-refunded-forged", AMOUNT),
				"whsec_attacker",
				"wh-refund-forged",
			),
		);
		expect(res).toEqual({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });
		expect(await orderState("ord-refunded-forged")).toBe("pending");
	});
});

/** A settle seam that throws the store's "too busy" refusal — optionally AFTER
 *  the real use-case ran, which is the worst case for a retry: the delivery
 *  made progress and is then redelivered anyway. */
function busySettle(options: { afterRealSettle: boolean }): SettleFn {
	return async (deps, gateway, raw) => {
		if (options.afterRealSettle) await settleOrder(deps, gateway, raw);
		throw new StorageContentionError("markPaid", 24);
	};
}

/** A seam that throws a retryable serialization abort in its BRIDGED shape. */
const bridgedAbortSettle: SettleFn = async () => {
	// oxlint-disable-next-line no-throw-literal -- the bridge shape IS a plain object
	throw { code: "STORAGE_SERIALIZATION_FAILURE", retryable: true };
};

const faultySettle: SettleFn = async () => {
	throw new Error("a real fault");
};

describe("(ix) storage pressure is a 503 Stripe retries — and the redelivery settles exactly once", () => {
	test("an exhausted compare-and-set budget is 503 BUSY, never a thrown host 500", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-busy");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const res = await invoke(
			await signedDelivery("ord-busy"),
			{},
			{
				settle: busySettle({ afterRealSettle: false }),
			},
		);

		expect(res).toEqual({ ok: false, status: 503, reason: "BUSY", retryable: true });
		expect(await orderState("ord-busy")).toBe("pending");
	});

	test("a retryable serialization abort arriving as a plain object (the bridge shape) is 503 BUSY too", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-busy-40001");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await invoke(
			await signedDelivery("ord-busy-40001"),
			{},
			{ settle: bridgedAbortSettle },
		);

		expect(res).toEqual({ ok: false, status: 503, reason: "BUSY", retryable: true });
	});

	test("Stripe's redelivery after a 503 — even one that had made progress — settles ONCE (the domain dedupe, cf. (iv))", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-busy-replay");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const delivery = await signedDelivery("ord-busy-replay");
		const { settle, calls } = recordingSettle();

		const first = await invoke(delivery, {}, { settle: busySettle({ afterRealSettle: true }) });
		const redelivery = await invoke(delivery, {}, { settle });

		expect(first).toEqual({ ok: false, status: 503, reason: "BUSY", retryable: true });
		expect(redelivery).toEqual({ ok: true, status: 200 });
		expect(calls).toEqual([expect.objectContaining({ ok: true, noop: true })]);
		expect(await orderState("ord-busy-replay")).toBe("paid");
		await expect(
			harness.stores.paymentEventStore.dedupe(
				"evt_ord-busy-replay",
				toOrderId("ord-busy-replay"),
				"stripe",
				new Date().toISOString(),
			),
		).resolves.toBe(false);
	});

	test("any OTHER throw still propagates — busy is not a blanket catch", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-fault");
		await expect(
			invoke(await signedDelivery("ord-fault"), {}, { settle: faultySettle }),
		).rejects.toThrow("a real fault");
	});
});

/** The order's outbox row as the CRON would next see it: an unrestricted claim scoped
 *  to THIS order at a far-future instant, so a backed-off row is due too. `null` ⇒
 *  nothing left for the cron (sent); otherwise the row, with its attempt count — 1
 *  means no dispatcher had touched it. */
async function cronWouldClaim(id: string) {
	const row = await harness.stores.orderStore.claimNextEmailForOrder(
		toOrderId(id),
		"2099-01-01T00:00:00.000Z",
		"2099-01-01T00:05:00.000Z",
	);
	return row === null ? null : { orderId: row.orderId as string, attempts: row.attempts };
}

describe("(x) the paid order's confirmation goes out with the settlement, best-effort (ADR-0005 2026-10-02)", () => {
	test("a paid settle sends the order-confirmation inline, and leaves nothing for the cron", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail");
		const emailSender = new FakeEmailSender();

		const res = await invoke(
			await signedDelivery("ord-mail"),
			{},
			{ orderEmails: { emailSender } },
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(emailSender.countByTemplate("order-confirmation", "ord-mail")).toBe(1);
		expect(emailSender.sends[0]?.to).toBe("buyer@example.com");
		// Marked sent in the same request — the cron has nothing to re-send.
		expect(await cronWouldClaim("ord-mail")).toBeNull();
		// The injected sender is the only egress: ctx.http was never touched.
		expect(harness.egressAttempts()).toBe(0);
	});

	test("a replayed delivery does not send a second confirmation", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-replay");
		const emailSender = new FakeEmailSender();
		const delivery = await signedDelivery("ord-mail-replay");

		expect(await invoke(delivery, {}, { orderEmails: { emailSender } })).toEqual({
			ok: true,
			status: 200,
		});
		expect(await invoke(delivery, {}, { orderEmails: { emailSender } })).toEqual({
			ok: true,
			status: 200,
		});

		expect(emailSender.countByTemplate("order-confirmation", "ord-mail-replay")).toBe(1);
	});

	test("a THROWING sender does not change the 200 — the row is backed off for the cron", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-throw");
		const emailSender = new FakeEmailSender();
		emailSender.failNextSends(1);

		const res = await invoke(
			await signedDelivery("ord-mail-throw"),
			{},
			{ orderEmails: { emailSender } },
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(await orderState("ord-mail-throw")).toBe("paid");
		expect(emailSender.sends).toHaveLength(0);
		// Not lost: rescheduled, one attempt spent, and the cron's to deliver.
		expect(await cronWouldClaim("ord-mail-throw")).toMatchObject({
			orderId: "ord-mail-throw",
			attempts: 2,
		});
	});

	test("a HANGING sender does not hold the response — the deadline answers 200 and logs", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-hang");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const hanging: EmailSender = { send: () => new Promise<void>(() => {}) };
		const delivery = await signedDelivery("ord-mail-hang");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		let res: StripeWebhookSettleResult | undefined;
		const waited = await runUnderFakeTime(
			invoke(delivery, {}, { orderEmails: { emailSender: hanging } }).then((r) => (res = r)),
		);
		vi.useRealTimers();

		expect(res).toEqual({ ok: true, status: 200 });
		expect(waited).toBeLessThan(ORDER_EMAIL_INLINE_DEADLINE_MS + 1_000);
		expect(await orderState("ord-mail-hang")).toBe("paid");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ord-mail-hang"));
	});

	test("a send rejecting with a storage-busy-SHAPED error is just a failed send — still 200, rescheduled", async () => {
		// The dispatcher catches every SEND failure, whatever its shape, and reschedules
		// the row. (A real STORE rejection is the next describe's subject.)
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-busy");
		const busy: EmailSender = {
			send: () => Promise.reject(new StorageContentionError("markEmailSent", 24)),
		};
		const res = await invoke(
			await signedDelivery("ord-mail-busy"),
			{},
			{ orderEmails: { emailSender: busy } },
		);
		expect(res).toEqual({ ok: true, status: 200 });
		expect(await cronWouldClaim("ord-mail-busy")).toMatchObject({ attempts: 2 });
	});

	test("redeliveries during a provider outage spend ONE attempt, not one each", async () => {
		// Only a never-attempted row is claimed inline. Without that, every Stripe
		// redelivery (or x402 re-post) would burn one of `maxAttempts` and could park the
		// confirmation `failed` within minutes of an outage.
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-outage");
		const outage = new FakeEmailSender();
		outage.failNextSends(10);
		const sendSpy = vi.spyOn(outage, "send");
		// Each redelivery lands 2 minutes after the last — past the inline backoff, so
		// the row is DUE every time and only `attempts` keeps the inline path off it.
		// Only `Date` is faked; each delivery is signed at its own (fake) time.
		const start = Date.now();
		vi.useFakeTimers({ toFake: ["Date"] });

		for (let i = 0; i < 5; i++) {
			vi.setSystemTime(start + i * 2 * 60_000);
			const delivery = await signedDelivery("ord-mail-outage");
			expect(await invoke(delivery, {}, { orderEmails: { emailSender: outage } })).toEqual({
				ok: true,
				status: 200,
			});
		}
		vi.useRealTimers();

		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(await cronWouldClaim("ord-mail-outage")).toMatchObject({ attempts: 2 });
	});

	test("a settle that used up the request's time budget skips the inline send — still 200", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-slow");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let clock = 0;
		const slowSettle: SettleFn = async (deps, gateway, raw) => {
			const result = await settleOrder(deps, gateway, raw);
			clock += SETTLE_REQUEST_BUDGET_MS; // compare-and-set retries ate it all
			return result;
		};
		const emailSender = new FakeEmailSender();

		const res = await invoke(
			await signedDelivery("ord-mail-slow"),
			{},
			{ settle: slowSettle, orderEmails: { emailSender }, now: () => clock },
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(emailSender.sends).toHaveLength(0);
		expect(await cronWouldClaim("ord-mail-slow")).toMatchObject({ attempts: 1 }); // untouched
	});

	test("no EmDash email provider (ctx.email absent): nothing is sent, no egress, still 200 — the row waits for the cron", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-unconfigured");

		const res = await invoke(await signedDelivery("ord-mail-unconfigured"), {}, {});

		expect(res).toEqual({ ok: true, status: 200 });
		expect(harness.egressAttempts()).toBe(0);
		// Untouched: never claimed, so the cron's first claim is attempt 1.
		expect(await cronWouldClaim("ord-mail-unconfigured")).toMatchObject({ attempts: 1 });
	});

	test("a provider whose send fails (the real CtxEmailSender over ctx.email) still answers 200", async () => {
		// The host's email pipeline rejects — standing in for a provider outage on the
		// REAL sender path, not a fake.
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-egress");
		vi.spyOn(console, "error").mockImplementation(() => {});
		let sends = 0;
		const ctx: PluginContext = {
			...harness.ctx,
			email: {
				send: () => {
					sends += 1;
					return Promise.reject(new Error("provider outage"));
				},
			},
		};

		const res = await invoke(await signedDelivery("ord-mail-egress"), {}, { ctx });

		expect(res).toEqual({ ok: true, status: 200 });
		expect(sends).toBe(1);
		expect(harness.egressAttempts()).toBe(0);
		expect(await cronWouldClaim("ord-mail-egress")).toMatchObject({ attempts: 2 });
	});

	test("a configured provider (the real CtxEmailSender over ctx.email) delivers the confirmation inline", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-ok");
		const messages: EmailMessage[] = [];
		const ctx: PluginContext = {
			...harness.ctx,
			email: {
				send: async (message) => {
					messages.push(message);
				},
			},
		};

		const res = await invoke(await signedDelivery("ord-mail-ok"), {}, { ctx });

		expect(res).toEqual({ ok: true, status: 200 });
		expect(messages).toHaveLength(1);
		expect(await cronWouldClaim("ord-mail-ok")).toBeNull();
	});

	test("a refused settle sends nothing", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-refused");
		const emailSender = new FakeEmailSender();
		const res = await invoke(
			await signedDelivery("ord-mail-refused", { secret: "whsec_WRONG" }),
			{},
			{ orderEmails: { emailSender } },
		);
		expect(res).toMatchObject({ ok: false, status: 400 });
		expect(emailSender.sends).toHaveLength(0);
	});

	test("a redelivery after a BUSY 503 that had already flipped the order sends the confirmation (why noop settles dispatch too)", async () => {
		// The first delivery committed the paid flip and THEN hit storage pressure, so
		// it answered 503 and never reached the inline send. Stripe's redelivery
		// settles as a no-op — and is the first chance to send. Gating on `!noop`
		// would leave this order to the cron.
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-mail-busy-replay");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const emailSender = new FakeEmailSender();
		const delivery = await signedDelivery("ord-mail-busy-replay");

		const first = await invoke(
			delivery,
			{},
			{
				settle: busySettle({ afterRealSettle: true }),
				orderEmails: { emailSender },
			},
		);
		expect(first).toMatchObject({ status: 503, reason: "BUSY" });
		expect(emailSender.sends).toHaveLength(0);

		const redelivery = await invoke(delivery, {}, { orderEmails: { emailSender } });
		expect(redelivery).toEqual({ ok: true, status: 200 });
		expect(emailSender.countByTemplate("order-confirmation", "ord-mail-busy-replay")).toBe(1);
	});
});

/** One `console.error` call, every argument a string, naming the order and the message. */
function expectStringsOnly(error: ReturnType<typeof vi.spyOn>, id: string, message: string) {
	expect(error).toHaveBeenCalledTimes(1);
	const args = error.mock.calls[0] as unknown[];
	expect(args.every((a) => typeof a === "string")).toBe(true);
	expect(args.join(" ")).toContain(id);
	expect(args.join(" ")).toContain(message);
}

describe("(xi) a STORE rejection in the inline dispatch never reaches the response", () => {
	// Distinct from a failed send (which the dispatcher reschedules): here the order
	// store itself rejects — on the claim, or on the mark — after the payment settled.
	// The response must still be the settle's 200, the log must carry strings only
	// (never the error object), and nothing may escape as an unhandled rejection.
	let unhandled: unknown[];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	beforeEach(() => {
		unhandled = [];
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	async function settleWithBrokenStore(id: string): Promise<StripeWebhookSettleResult> {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder(id);
		return invoke(
			await signedDelivery(id),
			{},
			{ orderEmails: { emailSender: new FakeEmailSender() } },
		);
	}

	test.each([
		["a StorageContentionError", () => new StorageContentionError("claimNextEmailForOrder", 24)],
		["a plain Error", () => new Error("disk on fire")],
	])("the claim rejects with %s: 200, logged as strings", async (_label, make) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const thrown = make();
		vi.spyOn(EmdashOrderStore.prototype, "claimNextEmailForOrder").mockRejectedValue(thrown);

		const res = await settleWithBrokenStore("ord-store-claim");

		expect(res).toEqual({ ok: true, status: 200 });
		expect(await orderState("ord-store-claim")).toBe("paid");
		expectStringsOnly(error, "ord-store-claim", thrown.message);
		await new Promise((resolve) => setImmediate(resolve));
		expect(unhandled).toEqual([]);
	});

	test.each([
		["a StorageContentionError", () => new StorageContentionError("markEmailSent", 24)],
		["a plain Error", () => new Error("disk on fire")],
	])(
		"the mark (and its reschedule) reject with %s: 200, logged as strings",
		async (_label, make) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const thrown = make();
			vi.spyOn(EmdashOrderStore.prototype, "markEmailSent").mockRejectedValue(thrown);
			vi.spyOn(EmdashOrderStore.prototype, "rescheduleEmail").mockRejectedValue(thrown);

			const res = await settleWithBrokenStore("ord-store-mark");

			expect(res).toEqual({ ok: true, status: 200 });
			expectStringsOnly(error, "ord-store-mark", thrown.message);
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		},
	);
});

describe("(xii) ONE deadline for the whole settle: the refund calls and the inline email share it", () => {
	test("a late payment's Stripe call made after the settle used most of the budget is bounded by what is LEFT", async () => {
		// The gateway the route builds is refund-capable (a secret key is set). The
		// settle seam "uses" 7 s of the 8 s budget, then makes a Stripe call through
		// that gateway against a provider that never answers: the call must give up
		// at ~1 s (what is left), not at its own 3 s ceiling — two such calls plus the
		// inline email would otherwise run past Stripe's ~10 s.
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await harness.ctx.kv.set(STRIPE_SECRET_KEY_KEY, "sk_test_settle_route");
		await seedPendingOrder("ord-deadline-refund");
		let clock = 0;
		// Measured from the request to the refund giving up — not from a signal
		// listener: the transport puts no signal in `init` (EmDash's sandbox RPC
		// refuses one) and bounds the call with its own race.
		let requestedAt: number | undefined;
		let abortedAfterMs: number | undefined;
		const ctx: PluginContext = {
			...harness.ctx,
			http: {
				fetch: () => {
					requestedAt ??= performance.now();
					return new Promise<Response>(() => {});
				},
			},
		};
		const settle: SettleFn = async (deps, gateway, raw) => {
			const result = await settleOrder(deps, gateway, raw);
			clock += SETTLE_REQUEST_BUDGET_MS - 1_000;
			await gateway
				.refund({
					orderId: toOrderId("ord-deadline-refund"),
					providerRef: "pi_ord-deadline-refund",
					amount: cents(AMOUNT),
					currency: toCurrency("USD"),
					priorRefunded: cents(0),
					idempotencyKey: toIdempotencyKey("refund-deadline"),
				})
				.catch(() => undefined);
			if (requestedAt !== undefined) abortedAfterMs = performance.now() - requestedAt;
			return result;
		};

		const res = await invoke(
			await signedDelivery("ord-deadline-refund"),
			{},
			{
				ctx,
				settle,
				now: () => clock,
				orderEmails: { emailSender: new FakeEmailSender() },
			},
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(abortedAfterMs).toBeDefined();
		expect(abortedAfterMs!).toBeGreaterThan(500);
		expect(abortedAfterMs!).toBeLessThan(SETTLE_PROVIDER_TIMEOUT_MS - 1_000);
	});

	test("the inline email draws on the same deadline: a refund that used it all leaves no inline send", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await seedPendingOrder("ord-deadline-mail");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let clock = 0;
		const settle: SettleFn = async (deps, gateway, raw) => {
			const result = await settleOrder(deps, gateway, raw);
			clock += SETTLE_REQUEST_BUDGET_MS; // two slow refund calls, say
			return result;
		};
		const emailSender = new FakeEmailSender();

		const res = await invoke(
			await signedDelivery("ord-deadline-mail"),
			{},
			{
				settle,
				now: () => clock,
				orderEmails: { emailSender },
			},
		);

		expect(res).toEqual({ ok: true, status: 200 });
		expect(emailSender.sends).toHaveLength(0);
		expect(await cronWouldClaim("ord-deadline-mail")).toMatchObject({ attempts: 1 });
	});
});

describe("(xiii) the late-payment refund CREATE gets its full bound or is not started", () => {
	// A timed-out create is AMBIGUOUS (it may have reached Stripe): it lands as
	// GATEWAY_UNVERIFIED, flags the order "verify in Stripe", and blocks the automatic
	// retry. So the shared deadline may clip the pre-flight READ, but must never hand
	// the create a sliver: with too little left it is not started at all.
	test("a settle whose pre-flight read leaves too little time issues NO create: the refund stays reserved, uncounted, never 'verify in Stripe'", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await harness.ctx.kv.set(STRIPE_SECRET_KEY_KEY, "sk_test_settle_route");
		await seedPendingOrder("ord-late-create");
		expect(
			await harness.stores.orderStore.expire(
				toOrderId("ord-late-create"),
				"2100-01-01T00:00:00.000Z",
			),
		).toBe(true);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let clock = 0;
		const calls: string[] = [];
		const ctx: PluginContext = {
			...harness.ctx,
			http: {
				async fetch(url: string, init?: RequestInit): Promise<Response> {
					calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
					// The pre-flight read is slow: by the time it answers, 7 s of the
					// request's 8 s are gone.
					clock += 7_000;
					return new Response(
						JSON.stringify({
							id: "pi_ord-late-create",
							latest_charge: { amount_refunded: 0, amount_captured: AMOUNT, currency: "usd" },
						}),
						{ status: 200 },
					);
				},
			},
		};

		const res = await invoke(
			await signedDelivery("ord-late-create"),
			{},
			{ ctx, now: () => clock },
		);

		// Retryable, so Stripe redelivers and the redelivery (or the sweep) resumes the
		// SAME reservation under the SAME key with a whole create's time.
		expect(res).toMatchObject({ ok: false, status: 503, reason: "LATE_PAYMENT_REFUND_RETRYABLE" });
		expect(calls).toEqual(["GET /v1/payment_intents/pi_ord-late-create"]); // no POST /v1/refunds
		const ledger = await harness.stores.orderStore.readOrderLedger(toOrderId("ord-late-create"));
		expect(ledger?.refunds.map((r) => r.status)).toEqual(["reserved"]);
		expect(ledger?.refundRetries.map((r) => r.attempts)).toEqual([0]); // not counted
		expect(ledger?.order.reconciliationFlag ?? "").not.toContain("verify in");
	});

	test("with a whole create's time left, the create is issued with its FULL bound", async () => {
		await harness.ctx.kv.set(STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
		await harness.ctx.kv.set(STRIPE_SECRET_KEY_KEY, "sk_test_settle_route");
		await seedPendingOrder("ord-late-full");
		await harness.stores.orderStore.expire(toOrderId("ord-late-full"), "2100-01-01T00:00:00.000Z");
		const calls: string[] = [];
		const ctx: PluginContext = {
			...harness.ctx,
			http: {
				async fetch(url: string, init?: RequestInit): Promise<Response> {
					const path = new URL(url).pathname;
					calls.push(`${init?.method ?? "GET"} ${path}`);
					return new Response(
						JSON.stringify(
							path === "/v1/refunds"
								? { id: "re_1", amount: AMOUNT, currency: "usd", status: "succeeded" }
								: {
										id: "pi_ord-late-full",
										latest_charge: { amount_refunded: 0, amount_captured: AMOUNT, currency: "usd" },
									},
						),
						{ status: 200 },
					);
				},
			},
		};

		const res = await invoke(await signedDelivery("ord-late-full"), {}, { ctx });

		expect(res).toEqual({ ok: true, status: 200 });
		expect(calls).toEqual(["GET /v1/payment_intents/pi_ord-late-full", "POST /v1/refunds"]);
	});
});
