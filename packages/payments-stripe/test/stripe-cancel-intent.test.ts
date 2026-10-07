import { idempotencyKey, orderId, type CancelIntentInput } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	createStripeHttpTransport,
	DEFAULT_CANCEL_TIMEOUT_MS,
	StripePaymentGateway,
	type StripeCancelPaymentIntentResult,
	type StripeCreatePaymentIntentResult,
	type StripeCreateRefundResult,
	type StripePreflightResult,
	type StripeTransport,
} from "../src/index.js";

// `cancelIntent` — late-payment PREVENTION. When an unpaid order expires (or is
// cancelled) its PaymentIntent is withdrawn at Stripe so a pay page left open can
// no longer charge the buyer for stock already back on sale. Offline throughout:
// a mock transport for the gateway's mapping, a stub `fetch` for the wire.

const WEBHOOK = "whsec_test";
const SK = "sk_test_51CancelIntent";

class MockTransport implements StripeTransport {
	result: StripeCancelPaymentIntentResult = { ok: true, outcome: "cancelled" };
	readonly cancels: { intentId: string; idempotencyKey: string; secretKey: string }[] = [];

	async readRefundedAmount(): Promise<StripePreflightResult> {
		throw new Error("not used by the cancel suite");
	}
	async createRefund(): Promise<StripeCreateRefundResult> {
		throw new Error("not used by the cancel suite");
	}
	async createPaymentIntent(): Promise<StripeCreatePaymentIntentResult> {
		throw new Error("not used by the cancel suite");
	}
	async cancelPaymentIntent(input: {
		intentId: string;
		idempotencyKey: string;
		secretKey: string;
	}): Promise<StripeCancelPaymentIntentResult> {
		this.cancels.push(input);
		return this.result;
	}
}

function cancelInput(): CancelIntentInput {
	return {
		orderId: orderId("ord-1"),
		intentId: "pi_live_1",
		idempotencyKey: idempotencyKey("cancel-intent:pi_live_1"),
	};
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
		handler(String(target), init)) as unknown as typeof fetch;
}

describe("StripePaymentGateway.cancelIntent (mock transport)", () => {
	test("no secretKey ⇒ UNSUPPORTED and no call — an offline handle is not a real intent", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, transport });
		expect(await gw.cancelIntent(cancelInput())).toEqual({ ok: false, reason: "UNSUPPORTED" });
		expect(transport.cancels).toHaveLength(0);
	});

	test("cancels the named intent under OUR idempotency key and the secret key", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		expect(await gw.cancelIntent(cancelInput())).toEqual({ ok: true, outcome: "cancelled" });
		expect(transport.cancels).toEqual([
			{ intentId: "pi_live_1", idempotencyKey: "cancel-intent:pi_live_1", secretKey: SK },
		]);
	});

	test("an already-final intent is a no-op success; retryable/terminal map through", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		transport.result = { ok: true, outcome: "not_cancellable" };
		expect(await gw.cancelIntent(cancelInput())).toEqual({ ok: true, outcome: "not_cancellable" });
		transport.result = { ok: false, class: "retryable" };
		expect(await gw.cancelIntent(cancelInput())).toEqual({ ok: false, reason: "RETRYABLE" });
		transport.result = { ok: false, class: "terminal" };
		expect(await gw.cancelIntent(cancelInput())).toEqual({ ok: false, reason: "TERMINAL" });
	});

	test("a transport built before cancel existed (no `cancelPaymentIntent`) is UNSUPPORTED, never a throw", async () => {
		const legacy: StripeTransport = {
			readRefundedAmount: () => Promise.reject(new Error("unused")),
			createRefund: () => Promise.reject(new Error("unused")),
			createPaymentIntent: () => Promise.reject(new Error("unused")),
		};
		const gw = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			transport: legacy,
		});
		expect(await gw.cancelIntent(cancelInput())).toEqual({ ok: false, reason: "UNSUPPORTED" });
	});
});

const cancel = (t: StripeTransport) =>
	t.cancelPaymentIntent?.({ intentId: "pi_1", idempotencyKey: "k", secretKey: SK });
const intentWith = (status: string) =>
	new Response(JSON.stringify({ id: "pi_1", object: "payment_intent", status }), {
		status: 200,
	});

describe("createStripeHttpTransport.cancelPaymentIntent (stub fetch — NO network)", () => {
	test("POSTs /v1/payment_intents/{id}/cancel with reason=abandoned, Bearer auth, pinned version and the native Idempotency-Key", async () => {
		let seen: { url: string; method?: string; headers: Headers; body: string } | undefined;
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((url, init) => {
				seen = {
					url,
					...(init?.method !== undefined ? { method: init.method } : {}),
					headers: new Headers(init?.headers),
					body: String(init?.body),
				};
				return new Response(JSON.stringify({ id: "pi_live_1", status: "canceled" }), {
					status: 200,
				});
			}),
		});

		const res = await transport.cancelPaymentIntent?.({
			intentId: "pi_live_1",
			idempotencyKey: "cancel-intent:pi_live_1",
			secretKey: SK,
		});

		expect(res).toEqual({ ok: true, outcome: "cancelled" });
		expect(seen?.url).toBe("https://api.example/v1/payment_intents/pi_live_1/cancel");
		expect(seen?.method).toBe("POST");
		expect(seen?.headers.get("authorization")).toBe(`Bearer ${SK}`);
		expect(seen?.headers.get("idempotency-key")).toBe("cancel-intent:pi_live_1");
		expect(seen?.headers.get("stripe-version")).toBeTruthy();
		expect(new URLSearchParams(seen?.body).get("cancellation_reason")).toBe("abandoned");
	});

	test("the intent id is path-escaped — a hostile id can never retarget the request", async () => {
		let url = "";
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((u) => {
				url = u;
				return new Response("{}", { status: 200 });
			}),
		});
		await transport.cancelPaymentIntent?.({
			intentId: "pi_1/../../refunds",
			idempotencyKey: "k",
			secretKey: SK,
		});
		expect(url).toBe("https://api.example/v1/payment_intents/pi_1%2F..%2F..%2Frefunds/cancel");
	});

	// QA2 M1b. Stripe answers `payment_intent_unexpected_state` whenever the intent is
	// not in a state it will cancel FROM at that moment — which is not only "already
	// succeeded". Cancellable: requires_payment_method, requires_confirmation,
	// requires_action, requires_capture and (rarely) processing
	// (https://docs.stripe.com/api/payment_intents/cancel). Giving up on that code
	// alone left a payable intent live, so the adapter now READS the intent and
	// decides from its status.
	function unexpectedStateThen(intent: Response | (() => Response)) {
		const calls: { url: string; method: string }[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((url, init) => {
				calls.push({ url, method: init?.method ?? "GET" });
				if (init?.method === "POST") {
					return new Response(
						JSON.stringify({
							error: { type: "invalid_request_error", code: "payment_intent_unexpected_state" },
						}),
						{ status: 400 },
					);
				}
				return typeof intent === "function" ? intent() : intent;
			}),
		});
		return { transport, calls };
	}

	test("payment_intent_unexpected_state + the intent SUCCEEDED ⇒ not_cancellable: the payment landed, settle owns it", async () => {
		const { transport, calls } = unexpectedStateThen(intentWith("succeeded"));
		expect(await cancel(transport)).toEqual({ ok: true, outcome: "not_cancellable" });
		expect(calls).toEqual([
			{ url: "https://api.example/v1/payment_intents/pi_1/cancel", method: "POST" },
			{ url: "https://api.example/v1/payment_intents/pi_1", method: "GET" },
		]);
	});

	test("payment_intent_unexpected_state + the intent already CANCELED ⇒ cancelled: it cannot be paid", async () => {
		const { transport } = unexpectedStateThen(intentWith("canceled"));
		expect(await cancel(transport)).toEqual({ ok: true, outcome: "cancelled" });
	});

	test("payment_intent_unexpected_state + an intent that is STILL payable or in flight ⇒ retryable — never abandoned", async () => {
		for (const status of [
			"requires_payment_method",
			"requires_confirmation",
			"requires_action",
			"requires_capture",
			"processing",
		]) {
			const { transport } = unexpectedStateThen(intentWith(status));
			expect(await cancel(transport), status).toEqual({ ok: false, class: "retryable" });
		}
	});

	test("payment_intent_unexpected_state + the read fails, times out or is unreadable ⇒ retryable, never not_cancellable", async () => {
		for (const [label, res] of [
			["5xx", () => new Response("{}", { status: 500 })],
			["404", () => new Response("{}", { status: 404 })],
			["no status", () => new Response(JSON.stringify({ id: "pi_1" }), { status: 200 })],
			["unknown status", () => intentWith("requires_something_new")],
			["not json", () => new Response("<html>", { status: 200 })],
			[
				"network",
				() => {
					throw new Error("ECONNRESET");
				},
			],
		] as const) {
			const { transport } = unexpectedStateThen(res);
			expect(await cancel(transport), label).toEqual({ ok: false, class: "retryable" });
		}
	});

	test("5xx, 429, 409 and a network failure are retryable (a cancel moves no money); any other 4xx is terminal", async () => {
		for (const [status, cls] of [
			[500, "retryable"],
			[503, "retryable"],
			[429, "retryable"],
			[409, "retryable"],
			[400, "terminal"],
			[404, "terminal"],
		] as const) {
			const transport = createStripeHttpTransport({
				baseUrl: "https://api.example",
				fetch: stubFetch(() => new Response("{}", { status })),
			});
			expect(
				await transport.cancelPaymentIntent?.({
					intentId: "pi_1",
					idempotencyKey: "k",
					secretKey: SK,
				}),
				String(status),
			).toEqual({ ok: false, class: cls });
		}
		const netFail = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: (() => {
				throw new Error("ECONNRESET");
			}) as unknown as typeof fetch,
		});
		expect(
			await netFail.cancelPaymentIntent?.({ intentId: "pi_1", idempotencyKey: "k", secretKey: SK }),
		).toEqual({ ok: false, class: "retryable" });
	});
});

describe("cancelPaymentIntent is SHORT-bounded — a cron leg must not wait 30 s on Stripe", () => {
	test("the default cancel timeout is at most 3 s", () => {
		expect(DEFAULT_CANCEL_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
	});

	test("the read after a refused cancel shares the cancel's bound — a hung read is retryable in time", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			cancelTimeoutMs: 50,
			fetch: ((_target: Parameters<typeof fetch>[0], init?: RequestInit) =>
				init?.method === "POST"
					? Promise.resolve(
							new Response(JSON.stringify({ error: { code: "payment_intent_unexpected_state" } }), {
								status: 400,
							}),
						)
					: new Promise<Response>((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
						})) as unknown as typeof fetch,
		});
		const started = Date.now();
		expect(
			await transport.cancelPaymentIntent?.({
				intentId: "pi_1",
				idempotencyKey: "k",
				secretKey: SK,
			}),
		).toEqual({ ok: false, class: "retryable" });
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("a hung cancel classifies retryable at its own (short) bound", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			cancelTimeoutMs: 20,
			fetch: ((_target: Parameters<typeof fetch>[0], init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				})) as unknown as typeof fetch,
		});
		const started = Date.now();
		expect(
			await transport.cancelPaymentIntent?.({
				intentId: "pi_1",
				idempotencyKey: "k",
				secretKey: SK,
			}),
		).toEqual({ ok: false, class: "retryable" });
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
