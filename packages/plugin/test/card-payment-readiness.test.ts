/**
 * Issue #499: card checkout is offered only when Stripe is FULLY set up — the
 * publishable key, the secret key and the webhook signing secret, each present
 * and usable — not on the publishable key alone. This suite pins:
 *
 *  - `storefront/payment-config` says `cardPaymentReady` only for a full set
 *    (the checkout pages then show "Card payment isn't set up" up front and
 *    create no order);
 *  - `storefront/checkout/place` on a store with no gateway answers the typed
 *    `STRIPE_NOT_CONFIGURED`, not the guard's generic `RENDER_FAILED`, touches no
 *    commerce storage (so no order), and logs ONE operator line naming what is
 *    missing — never a value;
 *  - Settings states one "Card payments: ready / not ready (missing: …)" line.
 *
 * Driven over a fake kv, like `settings-publishable-key.test.ts`; commerce
 * storage refuses every call, which is how "no order was created" is asserted.
 */
import type { StorageAccess, StorageCollection } from "@urumi.ai/otta-store-emdash";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSettingsFormHandler } from "../src/admin/settings-form.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import { STRIPE_PUBLISHABLE_KEY_KEY } from "../src/payments/stripe-publishable-key.js";
import { createCheckoutPlaceRouteHandler } from "../src/storefront/checkout-routes.js";
import { createPaymentConfigRouteHandler } from "../src/storefront/payment-config-route.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { contextTexts, type LooseBlock } from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

// Fixtures in the shapes Stripe issues. None is a real credential.
const PK_TEST = ["pk_test_", "51QaFixtureKey000000000000"].join("");
const PK_LIVE = ["pk_live_", "51QaFixtureKey000000000000"].join("");
const SK_TEST = ["sk_test_", "51QaFixtureKey000000000000"].join("");
const SK_LIVE = ["sk_live_", "51QaFixtureKey000000000000"].join("");
const WHSEC = ["whsec_", "0123456789abcdef0123456789abcdef"].join("");

const FULL_TEST = {
	[STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST,
	[STRIPE_SECRET_KEY_KEY]: SK_TEST,
	[STRIPE_WEBHOOK_SECRET_KEY]: WHSEC,
};

const storageTouched: string[] = [];

function makeRefusingStorage(): StorageAccess {
	return Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [
			name,
			new Proxy({} as StorageCollection, {
				get: (_t, method) => () => {
					storageTouched.push(`${name}.${String(method)}`);
					throw new Error("this suite asserts that no commerce storage is touched");
				},
			}),
		]),
	);
}

function makeCtx(
	seed: Record<string, unknown> = {},
	options: { failingKeys?: readonly string[] } = {},
): PluginContext {
	const kv = new Map<string, unknown>(Object.entries(seed));
	return {
		storage: makeRefusingStorage(),
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (options.failingKeys?.includes(k) === true) throw new Error("kv unavailable");
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
}

afterEach(() => {
	storageTouched.length = 0;
	vi.restoreAllMocks();
});

describe("storefront/payment-config — cardPaymentReady", () => {
	const route = createPaymentConfigRouteHandler();
	const call = (ctx: PluginContext) => route({ input: {}, request: req } as never, ctx);

	test.each([
		["the publishable key alone", { [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST }],
		[
			"no webhook signing secret",
			{ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST, [STRIPE_SECRET_KEY_KEY]: SK_TEST },
		],
		[
			"no secret key",
			{ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST, [STRIPE_WEBHOOK_SECRET_KEY]: WHSEC },
		],
		["a malformed webhook secret", { ...FULL_TEST, [STRIPE_WEBHOOK_SECRET_KEY]: "whsec_x" }],
		[
			"a test publishable key beside a live secret key",
			{ ...FULL_TEST, [STRIPE_SECRET_KEY_KEY]: SK_LIVE },
		],
	])("%s is not ready (the key itself is still answered)", async (_name, seed) => {
		expect(await call(makeCtx(seed))).toEqual({
			ok: true,
			stripePublishableKey: PK_TEST,
			cardPaymentReady: false,
		});
	});

	test("an unreadable secret is not ready", async () => {
		expect(await call(makeCtx(FULL_TEST, { failingKeys: [STRIPE_SECRET_KEY_KEY] }))).toEqual({
			ok: true,
			stripePublishableKey: PK_TEST,
			cardPaymentReady: false,
		});
	});

	test("both secrets but no publishable key is not ready", async () => {
		expect(
			await call(makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST, [STRIPE_WEBHOOK_SECRET_KEY]: WHSEC })),
		).toEqual({ ok: true, stripePublishableKey: null, cardPaymentReady: false });
	});

	test.each([
		["test", FULL_TEST, PK_TEST],
		[
			"live",
			{
				[STRIPE_PUBLISHABLE_KEY_KEY]: PK_LIVE,
				[STRIPE_SECRET_KEY_KEY]: SK_LIVE,
				[STRIPE_WEBHOOK_SECRET_KEY]: WHSEC,
			},
			PK_LIVE,
		],
	])("all three values (%s) is ready", async (_mode, seed, key) => {
		expect(await call(makeCtx(seed))).toEqual({
			ok: true,
			stripePublishableKey: key,
			cardPaymentReady: true,
		});
	});

	test("never answers a secret", async () => {
		const answer = JSON.stringify(await call(makeCtx(FULL_TEST)));
		expect(answer).not.toContain(SK_TEST);
		expect(answer).not.toContain(WHSEC);
	});
});

describe("storefront/checkout/place on a store whose Stripe is not set up", () => {
	const route = createCheckoutPlaceRouteHandler();
	const place = (ctx: PluginContext) =>
		route(
			{
				input: {
					cartId: "cart-499",
					buyerRef: "buyer@example.com",
					idempotencyKey: "checkout:cart-499",
				},
				request: req,
			} as never,
			ctx,
		);

	test("the publishable key alone: STRIPE_NOT_CONFIGURED, no order, one line naming both secrets", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await place(makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST }));

		expect(result).toEqual({ ok: false, reason: "STRIPE_NOT_CONFIGURED" });
		expect(storageTouched).toEqual([]);
		expect(logged).toHaveBeenCalledTimes(1);
		const line = logged.mock.calls[0]!.map(String).join(" ");
		expect(line).toContain("missing: secret key, webhook signing secret");
	});

	test("the secret key saved, the webhook secret not: names only the webhook secret, never the key", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await place(
			makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST, [STRIPE_SECRET_KEY_KEY]: SK_TEST }),
		);

		expect(result).toEqual({ ok: false, reason: "STRIPE_NOT_CONFIGURED" });
		expect(storageTouched).toEqual([]);
		const line = logged.mock.calls.flat().map(String).join(" ");
		expect(line).toContain("missing: webhook signing secret");
		expect(line).not.toContain("secret key,");
		expect(line).not.toContain(SK_TEST);
		expect(line).not.toContain(PK_TEST);
	});
});

describe("Settings — the card payments line", () => {
	async function cardLine(seed: Record<string, unknown>): Promise<string | undefined> {
		const handler = createSettingsFormHandler();
		const page = (await handler(
			{ input: { type: "page_load" }, request: req },
			makeCtx(seed),
		)) as unknown as { blocks: LooseBlock[] };
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
		return contextTexts(page.blocks).find((t) => t.startsWith("Card payments:"));
	}

	test.each([
		[
			"nothing saved",
			{},
			"Card payments: not ready (missing: publishable key, secret key, webhook signing secret).",
		],
		[
			"the publishable key alone",
			{ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST },
			"Card payments: not ready (missing: secret key, webhook signing secret).",
		],
		[
			"no webhook signing secret",
			{ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST, [STRIPE_SECRET_KEY_KEY]: SK_TEST },
			"Card payments: not ready (missing: webhook signing secret).",
		],
		[
			"a malformed publishable key",
			{ ...FULL_TEST, [STRIPE_PUBLISHABLE_KEY_KEY]: "not-a-key" },
			"Card payments: not ready (missing: publishable key).",
		],
		[
			"test and live keys mixed",
			{ ...FULL_TEST, [STRIPE_SECRET_KEY_KEY]: SK_LIVE },
			"Card payments: not ready (the publishable and secret keys are from different Stripe modes).",
		],
		["all three", FULL_TEST, "Card payments: ready."],
	] as const)("%s", async (_name, seed, expected) => {
		const line = await cardLine(seed);
		expect(line).toBe(expected);
		expect(line!.length).toBeLessThanOrEqual(200);
	});
});
