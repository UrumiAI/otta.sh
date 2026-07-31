import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	PaymentIntentError,
	type CreateIntentInput,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	createStripeHttpTransport,
	STRIPE_UNSUPPORTED_CURRENCIES,
	StripePaymentGateway,
	type StripeCreatePaymentIntentInput,
	type StripeCreatePaymentIntentResult,
	type StripeCreateRefundResult,
	type StripePreflightResult,
	type StripeTransport,
} from "../src/index.js";

const WEBHOOK = "whsec_test";
const SK = "sk_test_51LiveCreateIntent";
const USD = currency("USD");

/** Records every `createPaymentIntent` call and plays a scripted result — keeps
 *  the live-path suite OFFLINE (the same philosophy as the refund suite's mock). */
class MockTransport implements StripeTransport {
	result: StripeCreatePaymentIntentResult = {
		ok: true,
		intentId: "pi_live_1",
		clientSecret: "pi_live_1_secret_stripe",
	};
	readonly intents: StripeCreatePaymentIntentInput[] = [];

	async readRefundedAmount(): Promise<StripePreflightResult> {
		throw new Error("not used by the createIntent suite");
	}
	async createRefund(): Promise<StripeCreateRefundResult> {
		throw new Error("not used by the createIntent suite");
	}
	async createPaymentIntent(
		input: StripeCreatePaymentIntentInput,
	): Promise<StripeCreatePaymentIntentResult> {
		this.intents.push(input);
		return this.result;
	}
}

function intentInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
	return {
		orderId: orderId("ord-1"),
		amount: cents(2500),
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		lines: [{ title: "Widget", quantity: 1 }],
		...overrides,
	};
}

describe("StripePaymentGateway.createIntent — the OFFLINE path is unchanged", () => {
	test("no secretKey ⇒ the deterministic pi_<orderId> handle + synthetic client secret", async () => {
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK });
		expect(await gw.createIntent(intentInput())).toEqual({
			gateway: "stripe",
			intentId: "pi_ord-1",
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_ord-1_secret_key-1" },
		});
	});

	test("an injected transport with NO secretKey is never called (offline stays offline)", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, transport });
		await gw.createIntent(intentInput());
		expect(transport.intents).toHaveLength(0);
	});

	test("the offline path is NOT currency-gated — a zero-decimal currency still gets its handle (it moves no money)", async () => {
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK });
		expect(await gw.createIntent(intentInput({ currency: currency("JPY") }))).toEqual({
			gateway: "stripe",
			intentId: "pi_ord-1",
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_ord-1_secret_key-1" },
		});
	});
});

describe("StripePaymentGateway.createIntent — the LIVE path FAILS CLOSED on non-exponent-2 currencies", () => {
	// The repo's money convention is integer minor units at hundredths scale
	// EVERYWHERE (see packages/plugin/src/admin/money-input.ts). Stripe wants
	// ZERO-decimal currencies (JPY, KRW, …) in WHOLE units, so passing our
	// hundredths integer through would charge the buyer 100×; three-decimal
	// currencies (KWD, …) are the mirror hazard. Reject before the network — a
	// wrong charge is not a retryable condition.

	test("a ZERO-decimal currency (JPY) throws a TERMINAL unsupported_currency error and never calls the transport", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const err = (await gw
			.createIntent(intentInput({ currency: currency("JPY"), amount: cents(1000) }))
			.catch((e: unknown) => e)) as PaymentIntentError;
		expect(err).toBeInstanceOf(PaymentIntentError);
		expect(err.retryable).toBe(false);
		expect(err.providerCode).toBe("unsupported_currency");
		expect(err.providerStatus).toBeUndefined();
		expect(transport.intents, "nothing was sent to Stripe").toHaveLength(0);
	});

	test("a THREE-decimal currency (KWD) is rejected the same way", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const err = (await gw
			.createIntent(intentInput({ currency: currency("KWD") }))
			.catch((e: unknown) => e)) as PaymentIntentError;
		expect(err).toBeInstanceOf(PaymentIntentError);
		expect(err.retryable).toBe(false);
		expect(err.providerCode).toBe("unsupported_currency");
		expect(transport.intents).toHaveLength(0);
	});

	test("every currency on the deny-list is rejected; ordinary exponent-2 currencies still go live", async () => {
		for (const denied of STRIPE_UNSUPPORTED_CURRENCIES) {
			const transport = new MockTransport();
			const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
			await expect(
				gw.createIntent(intentInput({ currency: currency(denied) })),
			).rejects.toBeInstanceOf(PaymentIntentError);
			expect(transport.intents).toHaveLength(0);
		}
		for (const allowed of ["USD", "EUR", "GBP", "CAD", "AUD", "INR"]) {
			const transport = new MockTransport();
			const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
			await gw.createIntent(intentInput({ currency: currency(allowed) }));
			expect(transport.intents[0]?.currency).toBe(allowed.toLowerCase());
		}
	});

	test("the deny-list covers Stripe's documented zero-decimal AND three-decimal sets", () => {
		for (const code of "BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF XPF".split(
			" ",
		)) {
			expect(STRIPE_UNSUPPORTED_CURRENCIES.has(code), code).toBe(true);
		}
		for (const code of "BHD JOD KWD OMR TND".split(" ")) {
			expect(STRIPE_UNSUPPORTED_CURRENCIES.has(code), code).toBe(true);
		}
		expect(STRIPE_UNSUPPORTED_CURRENCIES.has("USD")).toBe(false);
	});
});

describe("StripePaymentGateway.createIntent — the LIVE path (mock transport)", () => {
	test("the transport receives integer minor units, lowercase currency, the order id, our idempotency key and the secretKey", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		await gw.createIntent(intentInput());
		expect(transport.intents).toHaveLength(1);
		expect(transport.intents[0]).toEqual({
			orderId: "ord-1",
			amountCents: 2500,
			currency: "usd",
			idempotencyKey: "key-1",
			secretKey: SK,
			// The India-export description, rendered from the order's line snapshot
			// (see stripe-intent-description.test.ts for the formatting contract).
			description: "1 × Widget",
		});
	});

	test("returns Stripe's real intent id + client_secret, never the synthetic pair", async () => {
		const transport = new MockTransport();
		transport.result = { ok: true, intentId: "pi_3Nxyz", clientSecret: "pi_3Nxyz_secret_abc" };
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		expect(await gw.createIntent(intentInput())).toEqual({
			gateway: "stripe",
			intentId: "pi_3Nxyz",
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_3Nxyz_secret_abc" },
		});
	});

	test("a retryable transport failure throws PaymentIntentError{ retryable: true, gateway: stripe }", async () => {
		const transport = new MockTransport();
		transport.result = { ok: false, class: "retryable", status: 503 };
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const err = await gw.createIntent(intentInput()).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PaymentIntentError);
		const typed = err as PaymentIntentError;
		expect(typed.retryable).toBe(true);
		expect(typed.gateway).toBe("stripe");
		expect(typed.providerStatus).toBe(503);
	});

	test("a terminal transport failure throws PaymentIntentError{ retryable: false }, carrying the provider code", async () => {
		const transport = new MockTransport();
		transport.result = { ok: false, class: "terminal", status: 402, code: "card_declined" };
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const err = await gw.createIntent(intentInput()).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PaymentIntentError);
		const typed = err as PaymentIntentError;
		expect(typed.retryable).toBe(false);
		expect(typed.providerStatus).toBe(402);
		expect(typed.providerCode).toBe("card_declined");
	});

	test("the thrown error NEVER contains the secret key (message, cause, or any enumerable field)", async () => {
		const transport = new MockTransport();
		transport.result = { ok: false, class: "terminal", status: 401, code: "api_key_expired" };
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const err = (await gw
			.createIntent(intentInput())
			.catch((e: unknown) => e)) as PaymentIntentError;
		expect(err.message).not.toContain(SK);
		expect(String(err.stack)).not.toContain(SK);
		expect(String((err as { cause?: unknown }).cause ?? "")).not.toContain(SK);
		expect(JSON.stringify(err)).not.toContain(SK);
		expect(JSON.stringify({ ...err })).not.toContain(SK);
		expect(JSON.stringify(Object.getOwnPropertyDescriptors(err))).not.toContain(SK);
	});

	test("the amount is a pass-through with NO float math (1 and 99_999_999 arrive verbatim)", async () => {
		for (const amount of [1, 99_999_999]) {
			const transport = new MockTransport();
			const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
			await gw.createIntent(intentInput({ amount: cents(amount) }));
			expect(transport.intents[0]?.amountCents).toBe(amount);
		}
	});
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
		handler(String(target), init)) as unknown as typeof fetch;
}

const OK_BODY = JSON.stringify({ id: "pi_3Nxyz", client_secret: "pi_3Nxyz_secret_abc" });

describe("createStripeHttpTransport.createPaymentIntent (stub fetch — NO network)", () => {
	test("POSTs form-encoded amount / currency / metadata[order_id] / automatic_payment_methods to /v1/payment_intents", async () => {
		let seenUrl: string | undefined;
		let seenMethod: string | undefined;
		let body: URLSearchParams | undefined;
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((url, init) => {
				seenUrl = url;
				seenMethod = init?.method;
				// Bracket keys are percent-encoded on the wire — parse, never byte-compare.
				body = new URLSearchParams(String(init?.body));
				return new Response(OK_BODY, { status: 200 });
			}),
		});
		await transport.createPaymentIntent({
			orderId: "ord-7",
			amountCents: 2500,
			currency: "USD",
			idempotencyKey: "key-7",
			secretKey: SK,
			description: "1 × Widget",
		});
		expect(seenUrl).toBe("https://api.example/v1/payment_intents");
		expect(seenMethod).toBe("POST");
		expect(body?.get("amount")).toBe("2500");
		expect(body?.get("currency")).toBe("usd");
		expect(body?.get("metadata[order_id]")).toBe("ord-7");
		expect(body?.get("automatic_payment_methods[enabled]")).toBe("true");
	});

	test("passes the domain idempotencyKey as Stripe's native Idempotency-Key, with Bearer auth + a form content-type", async () => {
		let headers: Headers | undefined;
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((_url, init) => {
				headers = new Headers(init?.headers);
				return new Response(OK_BODY, { status: 200 });
			}),
		});
		await transport.createPaymentIntent({
			orderId: "ord-7",
			amountCents: 2500,
			currency: "usd",
			idempotencyKey: "key-7",
			secretKey: SK,
			description: "1 × Widget",
		});
		expect(headers?.get("idempotency-key")).toBe("key-7");
		expect(headers?.get("authorization")).toBe(`Bearer ${SK}`);
		expect(headers?.get("content-type")).toBe("application/x-www-form-urlencoded");
	});

	test("a 2xx with id + client_secret is ok", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch(() => new Response(OK_BODY, { status: 200 })),
		});
		expect(
			await transport.createPaymentIntent({
				orderId: "ord-7",
				amountCents: 2500,
				currency: "usd",
				idempotencyKey: "key-7",
				secretKey: SK,
				description: "1 × Widget",
			}),
		).toEqual({ ok: true, intentId: "pi_3Nxyz", clientSecret: "pi_3Nxyz_secret_abc" });
	});

	test("a network reject is RETRYABLE (an intent moves no money; the native key dedupes the retry)", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: (() => {
				throw new Error("ECONNRESET");
			}) as unknown as typeof fetch,
		});
		expect(
			await transport.createPaymentIntent({
				orderId: "ord-7",
				amountCents: 2500,
				currency: "usd",
				idempotencyKey: "key-7",
				secretKey: SK,
				description: "1 × Widget",
			}),
		).toMatchObject({ ok: false, class: "retryable" });
	});

	test("5xx / 429 / 409 are retryable, any other 4xx is terminal — and the provider code is carried for logs", async () => {
		for (const [status, cls] of [
			[500, "retryable"],
			[503, "retryable"],
			[429, "retryable"],
			[409, "retryable"],
			[400, "terminal"],
			[401, "terminal"],
			[402, "terminal"],
		] as const) {
			const transport = createStripeHttpTransport({
				baseUrl: "https://api.example",
				fetch: stubFetch(
					() => new Response(JSON.stringify({ error: { code: "some_code" } }), { status }),
				),
			});
			expect(
				await transport.createPaymentIntent({
					orderId: "ord-7",
					amountCents: 2500,
					currency: "usd",
					idempotencyKey: "key-7",
					secretKey: SK,
					description: "1 × Widget",
				}),
			).toEqual({ ok: false, class: cls, status, code: "some_code" });
		}
	});

	test("a 2xx missing id or client_secret is TERMINAL (a same-key retry replays the same body)", async () => {
		for (const payload of [
			JSON.stringify({ client_secret: "pi_x_secret" }),
			JSON.stringify({ id: "pi_x" }),
			"not json at all",
		]) {
			const transport = createStripeHttpTransport({
				baseUrl: "https://api.example",
				fetch: stubFetch(() => new Response(payload, { status: 200 })),
			});
			expect(
				await transport.createPaymentIntent({
					orderId: "ord-7",
					amountCents: 2500,
					currency: "usd",
					idempotencyKey: "key-7",
					secretKey: SK,
					description: "1 × Widget",
				}),
			).toMatchObject({ ok: false, class: "terminal" });
		}
	});

	test("a non-JSON ERROR body classifies by status without throwing during parse", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
		});
		expect(
			await transport.createPaymentIntent({
				orderId: "ord-7",
				amountCents: 2500,
				currency: "usd",
				idempotencyKey: "key-7",
				secretKey: SK,
				description: "1 × Widget",
			}),
		).toEqual({ ok: false, class: "retryable", status: 502 });
	});

	test("a hung request is bounded by requestTimeoutMs and classifies retryable", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			requestTimeoutMs: 10,
			fetch: ((_target: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new Error("The operation was aborted"));
					});
				})) as unknown as typeof fetch,
		});
		expect(
			await transport.createPaymentIntent({
				orderId: "ord-7",
				amountCents: 2500,
				currency: "usd",
				idempotencyKey: "key-7",
				secretKey: SK,
				description: "1 × Widget",
			}),
		).toMatchObject({ ok: false, class: "retryable" });
	});
});
