import { cents, currency, idempotencyKey, orderId, type RefundInput } from "@otta-sh/domain";
import { describe, expect, test, vi } from "vitest";
import {
	createStripeHttpTransport,
	fetchStripeAccountCountry,
	StripePaymentGateway,
	type StripeTransport,
} from "../src/index.js";

// EmDash's sandbox runner hands a plugin's `ctx.http.fetch(url, init)` to the
// host over Workers RPC. On EmDash 0.38 workerd refused an `AbortSignal` there
// (`DataCloneError: AbortSignal serialization is not enabled.`); on 1.0.1 the
// wrapper drops it silently, so the abort never reaches the host fetch (both
// measured in `packages/plugin/test/emdash-sandbox-rpc.sandbox.test.ts`). Either
// way the racing deadline is the only bound: by default the live transport puts
// NO signal in `init`, and bounds every call with its own race instead. Only a trusted (in-process) host may opt back
// in to a signal, so a timed-out request's socket is released.
//
// Offline throughout: no call here leaves the process; the secret is a fake.

const SK = "sk_test_sandbox_bridge_fake";

function refundInput(): RefundInput {
	return {
		orderId: orderId("ord_1"),
		providerRef: "pi_1",
		amount: cents(500),
		currency: currency("USD"),
		priorRefunded: cents(0),
		idempotencyKey: idempotencyKey("rf-key-1"),
	};
}
const BASE = "https://api.example";

/** What the RPC does with an init it cannot clone: it throws before anything is
 *  sent. Records every init it accepts. */
function bridgeFetch(
	seen: { url: string; init: RequestInit }[],
	answer: (url: string, init: RequestInit) => Response,
): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (init?.signal != null) {
			throw new DOMException("AbortSignal serialization is not enabled.", "DataCloneError");
		}
		seen.push({ url: String(target), init: init ?? {} });
		return answer(String(target), init ?? {});
	}) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

const INTENT = { id: "pi_1", client_secret: "pi_1_secret_x" };
const CHARGE = { amount_refunded: 0, amount_captured: 1000, currency: "usd" };
const REFUND = { id: "re_1", amount: 500, currency: "usd" };

/** Each live call, with the canned 2xx it needs. */
function callsOf(transport: StripeTransport) {
	return {
		createPaymentIntent: () =>
			transport.createPaymentIntent({
				orderId: "ord_1",
				amountCents: 1000,
				currency: "USD",
				idempotencyKey: "pi-key-1",
				secretKey: SK,
				description: "Order ord_1",
			}),
		createCustomer: () =>
			transport.createCustomer!({
				orderId: "ord_1",
				name: "A Buyer",
				address: { line1: "1 Road", city: "Pune", postalCode: "411001", country: "IN" },
				idempotencyKey: "cus-key-1",
				secretKey: SK,
			}),
		readRefundedAmount: () => transport.readRefundedAmount({ providerRef: "pi_1", secretKey: SK }),
		createRefund: () =>
			transport.createRefund({
				providerRef: "pi_1",
				amountCents: 500,
				idempotencyKey: "rf-key-1",
				secretKey: SK,
			}),
		cancelPaymentIntent: () =>
			transport.cancelPaymentIntent!({
				intentId: "pi_1",
				idempotencyKey: "cx-key-1",
				secretKey: SK,
			}),
	};
}

function answerFor(url: string, init: RequestInit): Response {
	if (url.endsWith("/v1/payment_intents") && init.method === "POST") return json(INTENT);
	if (url.endsWith("/v1/customers")) return json({ id: "cus_1" });
	if (url.includes("/v1/payment_intents/pi_1?expand")) return json({ latest_charge: CHARGE });
	if (url.endsWith("/v1/refunds")) return json(REFUND);
	if (url.endsWith("/cancel")) return json({ id: "pi_1", status: "canceled" });
	if (url.endsWith("/v1/account")) return json({ country: "in" });
	return json({ error: { code: "unexpected" } }, 404);
}

/** Races a call against a generous ceiling so an unbounded call fails legibly. */
async function settlesWithin<T>(ms: number, call: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ceiling = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`call did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([call, ceiling]);
	} finally {
		clearTimeout(timer);
	}
}

/** A fetch that never answers and IGNORES any signal: only the transport's own
 *  race can end the wait. */
function neverAnswers(seen: RequestInit[]): typeof fetch {
	return ((_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
		seen.push(init ?? {});
		return new Promise<Response>(() => {});
	}) as unknown as typeof fetch;
}

/** A 2xx whose body starts and never finishes. Records whether the stream was
 *  cancelled (the transport must not leave the reader hanging). */
function endlessBody(): { response: Response; cancelled: () => boolean } {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"id":"'));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { response: new Response(stream, { status: 200 }), cancelled: () => cancelled };
}

describe("Stripe over the sandbox bridge: no AbortSignal in init (default)", () => {
	test("every live call goes through a bridge that refuses a signal, and keeps its idempotency key", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			fetch: bridgeFetch(seen, answerFor),
		});
		const calls = callsOf(transport);
		expect(await calls.createPaymentIntent()).toEqual({
			ok: true,
			intentId: "pi_1",
			clientSecret: "pi_1_secret_x",
		});
		expect(await calls.createCustomer()).toEqual({ ok: true, customerId: "cus_1" });
		expect(await calls.readRefundedAmount()).toEqual({
			ok: true,
			view: { amountRefunded: 0, amountCaptured: 1000, currency: "usd" },
		});
		expect(await calls.createRefund()).toEqual({
			ok: true,
			refundId: "re_1",
			amountCents: 500,
			currency: "usd",
		});
		expect(await calls.cancelPaymentIntent()).toEqual({ ok: true, outcome: "cancelled" });
		// Exactly one request per call — nothing is retried behind the caller's back.
		expect(seen.map((s) => `${String(s.init.method)} ${s.url.slice(BASE.length)}`)).toEqual([
			"POST /v1/payment_intents",
			"POST /v1/customers",
			"GET /v1/payment_intents/pi_1?expand[]=latest_charge",
			"POST /v1/refunds",
			"POST /v1/payment_intents/pi_1/cancel",
		]);
		const keys = seen.map(
			(s) => (s.init.headers as Record<string, string> | undefined)?.["idempotency-key"],
		);
		expect(keys).toEqual(["pi-key-1", "cus-key-1", undefined, "rf-key-1", "cx-key-1"]);
		for (const s of seen) expect("signal" in s.init).toBe(false);
	});

	test("the read after a refused cancel crosses the bridge too", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			fetch: bridgeFetch(seen, (_url, init) =>
				init.method === "POST"
					? json({ error: { code: "payment_intent_unexpected_state" } }, 400)
					: json({ id: "pi_1", status: "succeeded" }),
			),
		});
		expect(await callsOf(transport).cancelPaymentIntent()).toEqual({
			ok: true,
			outcome: "not_cancellable",
		});
		expect(seen.map((s) => s.init.method)).toEqual(["POST", "GET"]);
	});

	test("the account-country read crosses the bridge", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		expect(
			await fetchStripeAccountCountry({
				secretKey: SK,
				baseUrl: BASE,
				fetch: bridgeFetch(seen, answerFor),
			}),
		).toEqual({ ok: true, country: "IN" });
		expect(seen).toHaveLength(1);
	});

	test("the gateway's default transport sends no signal either (refund, end to end)", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const gw = new StripePaymentGateway({
			webhookSecret: "whsec_test",
			secretKey: SK,
			fetch: bridgeFetch(seen, (url, init) =>
				answerFor(url.replace("https://api.stripe.com", BASE), init),
			),
		});
		const res = await gw.refund(refundInput());
		expect(res.ok).toBe(true);
		expect(seen.map((s) => s.init.method)).toEqual(["GET", "POST"]);
	});
});

describe("the transport's own race bounds every call (a fetch that ignores signals)", () => {
	test("each call settles at its bound with the classification a timeout always had", async () => {
		const seen: RequestInit[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			requestTimeoutMs: 20,
			cancelTimeoutMs: 20,
			fetch: neverAnswers(seen),
		});
		const calls = callsOf(transport);
		// Intent and Customer creates move no money and are deduped by their key.
		expect(await settlesWithin(1_000, calls.createPaymentIntent())).toEqual({
			ok: false,
			class: "retryable",
		});
		expect(await settlesWithin(1_000, calls.createCustomer())).toEqual({
			ok: false,
			class: "retryable",
		});
		// A read issued nothing.
		expect(await settlesWithin(1_000, calls.readRefundedAmount())).toEqual({
			ok: false,
			class: "retryable",
		});
		// A refund POST may have reached Stripe: fate unknown, never retried blind.
		expect(await settlesWithin(1_000, calls.createRefund())).toEqual({
			ok: false,
			class: "ambiguous",
		});
		expect(await settlesWithin(1_000, calls.cancelPaymentIntent())).toEqual({
			ok: false,
			class: "retryable",
		});
		expect(
			await settlesWithin(
				1_000,
				fetchStripeAccountCountry({
					secretKey: SK,
					baseUrl: BASE,
					timeoutMs: 20,
					fetch: neverAnswers(seen),
				}),
			),
		).toEqual({ ok: false, reason: "unavailable" });
		// One request per call, none carrying a signal.
		expect(seen).toHaveLength(6);
		for (const init of seen) expect(init.signal).toBeUndefined();
	});

	test("a hung read after a refused cancel is bounded by what is left of the cancel's deadline", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			cancelTimeoutMs: 50,
			fetch: ((_target: Parameters<typeof fetch>[0], init?: RequestInit) =>
				init?.method === "POST"
					? Promise.resolve(json({ error: { code: "payment_intent_unexpected_state" } }, 400))
					: new Promise<Response>(() => {})) as unknown as typeof fetch,
		});
		const started = Date.now();
		expect(await settlesWithin(1_000, callsOf(transport).cancelPaymentIntent())).toEqual({
			ok: false,
			class: "retryable",
		});
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("a 2xx body that never ends is cut off by the same bound, and its stream is cancelled", async () => {
		const cases = [
			["createPaymentIntent", { ok: false, class: "terminal", status: 200 }],
			["createCustomer", { ok: false, class: "terminal", status: 200 }],
			["readRefundedAmount", { ok: false, class: "retryable" }],
			["createRefund", { ok: false, class: "ambiguous" }],
		] as const;
		for (const [name, expected] of cases) {
			const body = endlessBody();
			const transport = createStripeHttpTransport({
				baseUrl: BASE,
				requestTimeoutMs: 20,
				fetch: (async () => body.response) as unknown as typeof fetch,
			});
			expect(await settlesWithin<unknown>(1_000, callsOf(transport)[name]()), name).toEqual(
				expected,
			);
			expect(body.cancelled(), name).toBe(true);
		}
	});

	test("an answer that arrives after the bound is discarded and its body cancelled unread", async () => {
		let deliver: ((res: Response) => void) | undefined;
		const body = endlessBody();
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			requestTimeoutMs: 20,
			fetch: (() =>
				new Promise<Response>((resolve) => {
					deliver = resolve;
				})) as unknown as typeof fetch,
		});
		expect(await settlesWithin(1_000, callsOf(transport).createRefund())).toEqual({
			ok: false,
			class: "ambiguous",
		});
		deliver?.(body.response);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(body.cancelled()).toBe(true);
	});

	// The error code is read off a non-2xx body under the call's own bound: a 400
	// whose body never ends (a refused cancel, a rejected create) settles at the
	// bound, classified by its status, with the stream cancelled. Without the
	// bound a trusted host would hang the cron's cancel leg on that read.
	test("a non-2xx error body that never ends is read under the call's bound, and its stream cancelled", async () => {
		const stalled400 = (): { fetch: typeof fetch; cancelled: () => boolean } => {
			const body = endlessBody();
			return {
				fetch: (async () =>
					new Response(body.response.body, { status: 400 })) as unknown as typeof fetch,
				cancelled: body.cancelled,
			};
		};
		const cases = [
			["cancelPaymentIntent", { ok: false, class: "terminal" }],
			["createPaymentIntent", { ok: false, class: "terminal", status: 400 }],
			["createCustomer", { ok: false, class: "terminal", status: 400 }],
		] as const;
		for (const [name, expected] of cases) {
			const stalled = stalled400();
			const transport = createStripeHttpTransport({
				baseUrl: BASE,
				requestTimeoutMs: 50,
				cancelTimeoutMs: 50,
				fetch: stalled.fetch,
			});
			const started = Date.now();
			expect(await settlesWithin<unknown>(1_000, callsOf(transport)[name]()), name).toEqual(
				expected,
			);
			expect(Date.now() - started, name).toBeLessThan(500);
			expect(stalled.cancelled(), name).toBe(true);
		}
	});

	test("a non-2xx body that is never read is not left open", async () => {
		const body = endlessBody();
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			fetch: (async () =>
				new Response(body.response.body, { status: 503 })) as unknown as typeof fetch,
		});
		expect(await callsOf(transport).readRefundedAmount()).toEqual({
			ok: false,
			class: "retryable",
		});
		expect(body.cancelled()).toBe(true);
	});

	test("a fast answer leaves no timer behind (the bound is cleared when the call ends)", async () => {
		vi.useFakeTimers();
		try {
			const seen: { url: string; init: RequestInit }[] = [];
			const transport = createStripeHttpTransport({
				baseUrl: BASE,
				requestTimeoutMs: 60_000,
				fetch: bridgeFetch(seen, answerFor),
			});
			expect((await callsOf(transport).createPaymentIntent()).ok).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("trustedHost: a signal travels in init, for an in-process host only", () => {
	test("each call carries a signal that aborts at the call's bound; the classification is unchanged", async () => {
		const seen: RequestInit[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			requestTimeoutMs: 20,
			cancelTimeoutMs: 20,
			trustedHost: true,
			fetch: neverAnswers(seen),
		});
		const calls = callsOf(transport);
		expect(await settlesWithin(1_000, calls.createPaymentIntent())).toEqual({
			ok: false,
			class: "retryable",
		});
		expect(await settlesWithin(1_000, calls.createRefund())).toEqual({
			ok: false,
			class: "ambiguous",
		});
		expect(seen).toHaveLength(2);
		for (const init of seen) {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(init.signal?.aborted).toBe(true);
		}
	});

	test("a signal-honouring fetch is cancelled at the socket, and still classifies as before", async () => {
		const aborted: boolean[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: BASE,
			requestTimeoutMs: 20,
			trustedHost: true,
			fetch: ((_target: Parameters<typeof fetch>[0], init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						aborted.push(true);
						reject(new Error("The operation was aborted"));
					});
				})) as unknown as typeof fetch,
		});
		expect(await settlesWithin(1_000, callsOf(transport).createRefund())).toEqual({
			ok: false,
			class: "ambiguous",
		});
		expect(aborted).toEqual([true]);
	});

	test("the gateway and the account read pass trustedHost through", async () => {
		const seen: RequestInit[] = [];
		const gw = new StripePaymentGateway({
			webhookSecret: "whsec_test",
			secretKey: SK,
			requestTimeoutMs: 20,
			trustedHost: true,
			fetch: neverAnswers(seen),
		});
		await settlesWithin(1_000, gw.refund(refundInput()));
		await settlesWithin(
			1_000,
			fetchStripeAccountCountry({
				secretKey: SK,
				baseUrl: BASE,
				timeoutMs: 20,
				trustedHost: true,
				fetch: neverAnswers(seen),
			}),
		);
		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const init of seen) expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});
