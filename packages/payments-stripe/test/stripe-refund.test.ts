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
		expect(res).toEqual({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
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
		expect(res).toEqual({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
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
});
