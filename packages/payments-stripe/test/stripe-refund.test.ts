import { cents, currency, idempotencyKey, orderId, type RefundInput } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	createStripeHttpTransport,
	StripePaymentGateway,
	type StripeCreatePaymentIntentResult,
	type StripeCreateRefundResult,
	type StripePreflightResult,
	type StripeTransport,
} from "../src/index.js";

const WEBHOOK = "whsec_test";
const SK = "sk_test_123";
const USD = currency("USD");

/** A scripted transport recording every call, with settable read/create results —
 *  keeps the refund suite OFFLINE (the same philosophy as the fake-Stripe webhook
 *  driver) while exercising the pre-flight → issue path + the error taxonomy. */
class MockTransport implements StripeTransport {
	preflight: StripePreflightResult = {
		ok: true,
		view: { amountRefunded: 0, amountCaptured: 1000, currency: "usd" },
	};
	create: StripeCreateRefundResult = {
		ok: true,
		refundId: "re_123",
		amountCents: 0,
		currency: "usd",
	};
	readonly reads: Array<{ providerRef: string; secretKey: string }> = [];
	readonly creates: Array<{
		providerRef: string;
		amountCents: number;
		idempotencyKey: string;
		secretKey: string;
	}> = [];

	async readRefundedAmount(input: {
		providerRef: string;
		secretKey: string;
	}): Promise<StripePreflightResult> {
		this.reads.push(input);
		return this.preflight;
	}
	/** The refund suite never creates intents; the seam's third method is
	 *  implemented only to satisfy the (now required) interface. */
	async createPaymentIntent(): Promise<StripeCreatePaymentIntentResult> {
		throw new Error("createPaymentIntent is not exercised by the refund suite");
	}
	async createRefund(input: {
		providerRef: string;
		amountCents: number;
		idempotencyKey: string;
		secretKey: string;
	}): Promise<StripeCreateRefundResult> {
		this.creates.push(input);
		// Echo the requested amount unless a test overrode the result explicitly.
		if (this.create.ok && this.create.amountCents === 0) {
			return { ...this.create, amountCents: input.amountCents };
		}
		return this.create;
	}
}

function refundInput(overrides: Partial<RefundInput> = {}): RefundInput {
	return {
		orderId: orderId("ord-1"),
		providerRef: "pi_1",
		amount: cents(500),
		currency: USD,
		priorRefunded: cents(0),
		idempotencyKey: idempotencyKey("rf-1"),
		...overrides,
	};
}

describe("StripePaymentGateway.refund (ADR-0008; offline mock transport)", () => {
	test("refundable is false without a secretKey, true with one", () => {
		expect(new StripePaymentGateway({ webhookSecret: WEBHOOK }).refundable).toBe(false);
		expect(
			new StripePaymentGateway({
				webhookSecret: WEBHOOK,
				secretKey: SK,
				transport: new MockTransport(),
			}).refundable,
		).toBe(true);
	});

	test("no secretKey ⇒ refund returns UNSUPPORTED (never a blind call)", async () => {
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK });
		expect(await gw.refund(refundInput())).toEqual({ ok: false, reason: "UNSUPPORTED" });
	});

	test("happy path: pre-flight read THEN refunds.create, passing our idempotency key", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const res = await gw.refund(refundInput({ amount: cents(500) }));
		expect(res).toEqual({ ok: true, refundRef: "re_123", amount: 500, currency: USD });
		// Pre-flight ran BEFORE the create (the mandatory read), both with the secret.
		expect(transport.reads).toHaveLength(1);
		expect(transport.reads[0]).toEqual({ providerRef: "pi_1", secretKey: SK });
		expect(transport.creates).toHaveLength(1);
		expect(transport.creates[0]?.idempotencyKey).toBe("rf-1");
		expect(transport.creates[0]?.amountCents).toBe(500);
	});

	test("fail closed: provider already refunded MORE than our view ⇒ PROVIDER_ALREADY_REFUNDED, nothing issued", async () => {
		const transport = new MockTransport();
		// Provider reports 500 already refunded; our local view says 0 ⇒ divergence.
		transport.preflight = {
			ok: true,
			view: { amountRefunded: 500, amountCaptured: 1000, currency: "usd" },
		};
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const res = await gw.refund(refundInput({ amount: cents(300), priorRefunded: cents(0) }));
		// The provider's own figures ride along (review round 1), so the domain can
		// tell a FULL refund outside Otta from a partial one.
		expect(res).toEqual({
			ok: false,
			reason: "PROVIDER_ALREADY_REFUNDED",
			provider: { refunded: 500, captured: 1000 },
		});
		expect(transport.creates, "nothing issued").toHaveLength(0);
	});

	test("fail closed: this refund would push provider past captured ⇒ PROVIDER_ALREADY_REFUNDED", async () => {
		const transport = new MockTransport();
		// 800 already refunded (matches our view), captured 1000; +300 would be 1100.
		transport.preflight = {
			ok: true,
			view: { amountRefunded: 800, amountCaptured: 1000, currency: "usd" },
		};
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const res = await gw.refund(refundInput({ amount: cents(300), priorRefunded: cents(800) }));
		expect(res).toEqual({
			ok: false,
			reason: "PROVIDER_ALREADY_REFUNDED",
			provider: { refunded: 800, captured: 1000 },
		});
		expect(transport.creates).toHaveLength(0);
	});

	test("pre-flight READ failures map to RETRYABLE / TERMINAL (nothing issued)", async () => {
		for (const [cls, reason] of [
			["retryable", "RETRYABLE"],
			["terminal", "TERMINAL"],
		] as const) {
			const transport = new MockTransport();
			transport.preflight = { ok: false, class: cls };
			const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
			expect(await gw.refund(refundInput())).toEqual({ ok: false, reason });
			expect(transport.creates).toHaveLength(0);
		}
	});

	test("createRefund failure classes: retryable → RETRYABLE, terminal → TERMINAL, ambiguous → UNVERIFIED", async () => {
		for (const [cls, reason] of [
			["retryable", "RETRYABLE"],
			["terminal", "TERMINAL"],
			["ambiguous", "UNVERIFIED"],
		] as const) {
			const transport = new MockTransport();
			transport.create = { ok: false, class: cls };
			const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
			expect(await gw.refund(refundInput())).toEqual({ ok: false, reason });
		}
	});

	test("the ambiguous timeout is NEVER a clean failure — it surfaces as UNVERIFIED (re-check, don't retry blind)", async () => {
		const transport = new MockTransport();
		transport.create = { ok: false, class: "ambiguous" };
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
		const res = await gw.refund(refundInput());
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("UNVERIFIED");
	});
});

/** A fetch that NEVER answers on its own — it settles only by rejecting when the
 *  request's abort signal fires, exactly as the platform `fetch` does. `answer`
 *  lets a test serve some calls (e.g. the pre-flight GET) and hang the rest.
 *  Every `init` is recorded so a test can assert the signal was passed. */
function hangingFetch(
	seen: RequestInit[],
	answer: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
): typeof fetch {
	return ((target: Parameters<typeof fetch>[0], init?: RequestInit) => {
		seen.push(init ?? {});
		const served = answer(String(target), init);
		if (served !== undefined) return Promise.resolve(served);
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				reject(new Error("The operation was aborted"));
			});
		});
	}) as unknown as typeof fetch;
}

/** Races a call against a generous ceiling so a regression (an unbounded call)
 *  fails fast and legibly instead of hanging the suite until vitest's timeout. */
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

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
		handler(String(target), init)) as unknown as typeof fetch;
}

describe("createStripeHttpTransport (default live transport; stub fetch — NO network)", () => {
	test("reads the PaymentIntent's latest_charge for amount_refunded + captured", async () => {
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((url) => {
				expect(url).toContain("/v1/payment_intents/pi_1");
				return new Response(
					JSON.stringify({
						latest_charge: { amount_refunded: 200, amount_captured: 1000, currency: "usd" },
					}),
					{ status: 200 },
				);
			}),
		});
		const res = await transport.readRefundedAmount({ providerRef: "pi_1", secretKey: SK });
		expect(res).toEqual({
			ok: true,
			view: { amountRefunded: 200, amountCaptured: 1000, currency: "usd" },
		});
	});

	test("createRefund posts amount + native Idempotency-Key; a network reject is AMBIGUOUS", async () => {
		let seenIdemHeader: string | undefined;
		const ok = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: stubFetch((url, init) => {
				expect(url).toContain("/v1/refunds");
				const headers = new Headers(init?.headers);
				seenIdemHeader = headers.get("idempotency-key") ?? undefined;
				return new Response(JSON.stringify({ id: "re_9", amount: 500, currency: "usd" }), {
					status: 200,
				});
			}),
		});
		expect(
			await ok.createRefund({
				providerRef: "pi_1",
				amountCents: 500,
				idempotencyKey: "rf-9",
				secretKey: SK,
			}),
		).toEqual({ ok: true, refundId: "re_9", amountCents: 500, currency: "usd" });
		expect(seenIdemHeader).toBe("rf-9");

		const netFail = createStripeHttpTransport({
			baseUrl: "https://api.example",
			fetch: (() => {
				throw new Error("ECONNRESET");
			}) as unknown as typeof fetch,
		});
		expect(
			await netFail.createRefund({
				providerRef: "pi_1",
				amountCents: 500,
				idempotencyKey: "rf-9",
				secretKey: SK,
			}),
		).toEqual({ ok: false, class: "ambiguous" });
	});

	test("a 5xx on create is ambiguous; a 429/409 is retryable; a 4xx is terminal", async () => {
		// 429 (rate-limited) is throttled at the gate — the refund was NOT processed,
		// so it is RETRYABLE, never conflated with a 5xx (which Stripe may have
		// processed → ambiguous) or a plain 4xx rejection (terminal). 409 is Stripe's
		// "Idempotency-Key still processing": the ORIGINAL request may yet succeed —
		// mapping it terminal would void the reservation (releasing capacity) while
		// the money may still move, so it is RETRYABLE (reservation kept; a same-key
		// resume dedupes provider-side).
		for (const [status, cls] of [
			[500, "ambiguous"],
			[429, "retryable"],
			[409, "retryable"],
			[400, "terminal"],
		] as const) {
			const transport = createStripeHttpTransport({
				baseUrl: "https://api.example",
				fetch: stubFetch(() => new Response("{}", { status })),
			});
			expect(
				await transport.createRefund({
					providerRef: "pi_1",
					amountCents: 500,
					idempotencyKey: "rf",
					secretKey: SK,
				}),
			).toEqual({ ok: false, class: cls });
		}
	});

	test("a 429 on the pre-flight READ is retryable (nothing issued), a 4xx terminal", async () => {
		for (const [status, cls] of [
			[429, "retryable"],
			[500, "retryable"],
			[404, "terminal"],
		] as const) {
			const transport = createStripeHttpTransport({
				baseUrl: "https://api.example",
				fetch: stubFetch(() => new Response("{}", { status })),
			});
			expect(await transport.readRefundedAmount({ providerRef: "pi_1", secretKey: SK })).toEqual({
				ok: false,
				class: cls,
			});
		}
	});
	test("a hung pre-flight READ is bounded by requestTimeoutMs and classifies retryable", async () => {
		const seen: RequestInit[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			requestTimeoutMs: 20,
			fetch: hangingFetch(seen),
		});
		// A timed-out READ issued nothing — retryable, exactly like a network error.
		expect(
			await settlesWithin(
				1_000,
				transport.readRefundedAmount({ providerRef: "pi_1", secretKey: SK }),
			),
		).toEqual({ ok: false, class: "retryable" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("a hung refund CREATE is bounded by requestTimeoutMs and classifies ambiguous", async () => {
		const seen: RequestInit[] = [];
		const transport = createStripeHttpTransport({
			baseUrl: "https://api.example",
			requestTimeoutMs: 20,
			fetch: hangingFetch(seen),
		});
		// The POST may have reached Stripe before the abort: fate UNKNOWN — never a
		// clean failure, never retried blind.
		expect(
			await settlesWithin(
				1_000,
				transport.createRefund({
					providerRef: "pi_1",
					amountCents: 500,
					idempotencyKey: "rf-t",
					secretKey: SK,
				}),
			),
		).toEqual({ ok: false, class: "ambiguous" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("the gateway's OWN requestTimeoutMs bounds its default transport — the settle webhook's refund cannot outlast Stripe's delivery timeout", async () => {
		// The settle route refunds a late payment INSIDE the webhook request. Stripe
		// gives a delivery ~10 s before treating it as failed, so a refund pinned to
		// the 30 s default could still be running when Stripe gives up and redelivers.
		const seen: RequestInit[] = [];
		const gw = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			fetch: hangingFetch(seen),
			requestTimeoutMs: 20,
		});
		expect(await settlesWithin(1_000, gw.refund(refundInput()))).toEqual({
			ok: false,
			reason: "RETRYABLE",
		});
		expect(seen).toHaveLength(1);
	});

	test("requestTimeoutMs may be a FUNCTION, asked at each call — a cron leg bounds every call by the time it has left", async () => {
		let left = 5_000;
		const asked: number[] = [];
		const seen: RequestInit[] = [];
		const gw = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			fetch: hangingFetch(seen),
			requestTimeoutMs: () => {
				asked.push(left);
				return left;
			},
		});
		left = 20; // the leg's budget shrank before the call
		expect(await settlesWithin(1_000, gw.refund(refundInput()))).toEqual({
			ok: false,
			reason: "RETRYABLE",
		});
		expect(asked).toEqual([20]);
	});

	test("beforeRefundCreate=false after the pre-flight ⇒ NOT_STARTED and NO create — never start a create that is bound to time out", async () => {
		const transport = new MockTransport();
		const gw = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			transport,
			beforeRefundCreate: () => false,
		});
		expect(await gw.refund(refundInput())).toEqual({ ok: false, reason: "NOT_STARTED" });
		expect(transport.reads).toHaveLength(1);
		expect(transport.creates).toHaveLength(0);
	});

	test("the create gets its FIXED bound (refundCreateTimeoutMs), however little the caller's shrinking budget says is left", async () => {
		const seen: { method: string | undefined; at: number }[] = [];
		const gw = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			requestTimeoutMs: () => 5,
			refundCreateTimeoutMs: 80,
			fetch: hangingFetch([], (_url, init) => {
				seen.push({ method: init?.method, at: Date.now() });
				return init?.method === "GET"
					? new Response(
							JSON.stringify({
								latest_charge: { amount_refunded: 0, amount_captured: 1000, currency: "usd" },
							}),
							{ status: 200 },
						)
					: undefined;
			}),
		});
		const started = Date.now();
		expect(await settlesWithin(2_000, gw.refund(refundInput()))).toEqual({
			ok: false,
			reason: "UNVERIFIED",
		});
		// Aborted at ITS bound (80 ms), not at the 5 ms the caller had left.
		expect(Date.now() - started).toBeGreaterThanOrEqual(70);
		expect(seen.map((x) => x.method)).toEqual(["GET", "POST"]);
	});

	test("through the gateway: a hung READ is RETRYABLE (nothing issued), a hung CREATE is UNVERIFIED", async () => {
		const readSeen: RequestInit[] = [];
		const hungRead = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			transport: createStripeHttpTransport({
				baseUrl: "https://api.example",
				requestTimeoutMs: 20,
				fetch: hangingFetch(readSeen),
			}),
		});
		expect(await settlesWithin(1_000, hungRead.refund(refundInput()))).toEqual({
			ok: false,
			reason: "RETRYABLE",
		});
		expect(
			readSeen.map((init) => init.method),
			"no refund POST after a failed read",
		).toEqual(["GET"]);

		const createSeen: RequestInit[] = [];
		const hungCreate = new StripePaymentGateway({
			webhookSecret: WEBHOOK,
			secretKey: SK,
			transport: createStripeHttpTransport({
				baseUrl: "https://api.example",
				requestTimeoutMs: 20,
				// Serve the pre-flight GET cleanly; hang only the refund POST.
				fetch: hangingFetch(createSeen, (_url, init) =>
					init?.method === "GET"
						? new Response(
								JSON.stringify({
									latest_charge: { amount_refunded: 0, amount_captured: 1000, currency: "usd" },
								}),
								{ status: 200 },
							)
						: undefined,
				),
			}),
		});
		expect(await settlesWithin(1_000, hungCreate.refund(refundInput()))).toEqual({
			ok: false,
			reason: "UNVERIFIED",
		});
		expect(createSeen.map((init) => init.method)).toEqual(["GET", "POST"]);
		for (const init of createSeen) expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});
