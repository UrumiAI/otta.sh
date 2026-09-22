/**
 * Stripe payment gateway, in-process — the missing half of INC-C5's pattern.
 *
 * See `src/payments/stripe-wiring.ts`'s module doc for why BOTH
 * `settings:stripeSecretKey` and `settings:stripeWebhookSecret` are required
 * before a gateway is wired at all, mirroring `x402-wiring.test.ts`'s
 * fail-closed shape.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import { stripeGatewayFromCtx } from "../src/payments/stripe-wiring.js";
import type { PluginContext } from "../src/types.js";

const SECRET_KEY = "sk_test_abc123";
const WEBHOOK_SECRET = "whsec_abc123";

function makeCtx(
	seed: Record<string, unknown> = {},
	failingKeys: ReadonlySet<string> = new Set(),
): { ctx: PluginContext; calls: Array<{ url: string; init: RequestInit | undefined }> } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const ctx: PluginContext = {
		http: {
			fetch: (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return Promise.resolve(
					new Response(JSON.stringify({ id: "pi_test", client_secret: "pi_test_secret" }), {
						status: 200,
					}),
				);
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (failingKeys.has(k)) throw new Error(`kv unavailable: ${k}`);
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, calls };
}

describe("stripeGatewayFromCtx", () => {
	test("neither secret configured ⇒ no gateway", async () => {
		const { ctx } = makeCtx();
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("only the secret key ⇒ no gateway (a live intent nothing could ever verify)", async () => {
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SECRET_KEY });
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("only the webhook secret ⇒ no gateway (verification with nothing that can create)", async () => {
		const { ctx } = makeCtx({ [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET });
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("both configured ⇒ a refundable stripe gateway", async () => {
		const { ctx } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SECRET_KEY,
			[STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET,
		});
		const gateway = await stripeGatewayFromCtx(ctx);
		expect(gateway?.id).toBe("stripe");
		expect(gateway?.refundable).toBe(true);
	});

	test("a kv rejection on either key degrades to no gateway, never a thrown route", async () => {
		const { ctx } = makeCtx(
			{ [STRIPE_SECRET_KEY_KEY]: SECRET_KEY, [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET },
			new Set([STRIPE_SECRET_KEY_KEY]),
		);
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("createIntent's live call goes over ctx.http, not the global fetch", async () => {
		const { ctx, calls } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SECRET_KEY,
			[STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET,
		});
		const gateway = await stripeGatewayFromCtx(ctx);
		const handle = await gateway?.createIntent({
			orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
			amount: cents(2599),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_1"),
			lines: [],
		});
		expect(handle?.clientAction).toEqual({
			kind: "stripe_client_secret",
			clientSecret: "pi_test_secret",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("api.stripe.com");
		expect(
			((calls[0]?.init?.headers ?? {}) as Record<string, string>)["authorization"] ??
				((calls[0]?.init?.headers ?? {}) as Record<string, string>)["Authorization"],
		).toContain(SECRET_KEY);
	});
});
