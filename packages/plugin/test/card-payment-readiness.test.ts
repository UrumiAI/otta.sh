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
import { STRIPE_ACCOUNT_COUNTRY_KEY } from "../src/payments/stripe-account-country.js";
import { STRIPE_PUBLISHABLE_KEY_KEY } from "../src/payments/stripe-publishable-key.js";
import { createCheckoutPlaceRouteHandler } from "../src/storefront/checkout-routes.js";
import { createPaymentConfigRouteHandler } from "../src/storefront/payment-config-route.js";
import type { PluginContext } from "../src/types.js";
import { STRIPE_WEBHOOK_LAST_VERIFIED_KEY } from "../src/webhooks/stripe-webhook-last-verified.js";
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

	test.each([STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY])(
		"a failed read of %s is busy, never 'not set up'",
		async (key) => {
			expect(await call(makeCtx(FULL_TEST, { failingKeys: [key] }))).toEqual({
				ok: false,
				error: "RENDER_FAILED",
			});
		},
	);

	test("the dev-only offline arm stands in for the secret key, as it does for the gateway", async () => {
		const seed = { [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST, [STRIPE_WEBHOOK_SECRET_KEY]: WHSEC };
		expect(await call(makeCtx(seed))).toMatchObject({ cardPaymentReady: false });
		vi.stubGlobal("__OTTA_DEV_STRIPE_OFFLINE__", true);
		vi.stubEnv("DEV", true);
		try {
			expect(await call(makeCtx(seed))).toMatchObject({ cardPaymentReady: true });
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
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

	test("a failed secret read is NOT reported as unconfigured: the generic retry stands, nothing is named missing", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await place(
			makeCtx(FULL_TEST, { failingKeys: [STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY] }),
		);

		expect(result).toMatchObject({ ok: false });
		expect(result).not.toEqual({ ok: false, reason: "STRIPE_NOT_CONFIGURED" });
		expect(logged.mock.calls.flat().map(String).join(" ")).not.toContain("missing:");
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

/** The stored account-country record for `secretKey`, as the Settings save writes
 *  it (`stripe-account-country.ts`): the answer, tied to the key by its digest. */
async function storedAccountCountry(secretKey: string, status: string): Promise<unknown> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secretKey)),
	);
	return {
		keyDigest: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
		status,
		...(status === "known" ? { country: "US" } : {}),
		checkedAt: new Date().toISOString(),
	};
}

async function settingsTexts(
	seed: Record<string, unknown>,
	options: { failingKeys?: readonly string[] } = {},
): Promise<string[]> {
	const handler = createSettingsFormHandler();
	const page = (await handler(
		{ input: { type: "page_load" }, request: req },
		makeCtx(seed, options),
	)) as unknown as { blocks: LooseBlock[] };
	assertBlockContract(page.blocks, { screen: "settings", level: "list" });
	return contextTexts(page.blocks);
}

describe("Settings — #531: a key Stripe refused is not 'ready'", () => {
	test("all three saved, but the stored account check says Stripe refused the secret key", async () => {
		const texts = await settingsTexts({
			...FULL_TEST,
			[STRIPE_ACCOUNT_COUNTRY_KEY]: await storedAccountCountry(SK_TEST, "authentication_failed"),
		});
		const line = texts.find((t) => t.startsWith("Card payments:"));
		expect(line).toBe("Card payments: keys saved, but Stripe refused the secret key.");
		expect(line!.length).toBeLessThanOrEqual(200);
		expect(line).not.toContain(SK_TEST);
	});

	test("a stored answer that is not a refusal leaves 'ready' alone", async () => {
		const texts = await settingsTexts({
			...FULL_TEST,
			[STRIPE_ACCOUNT_COUNTRY_KEY]: await storedAccountCountry(SK_TEST, "known"),
		});
		expect(texts.find((t) => t.startsWith("Card payments:"))).toBe("Card payments: ready.");
	});

	test("not ready stays not ready: the missing values are the more useful answer", async () => {
		const texts = await settingsTexts({
			[STRIPE_SECRET_KEY_KEY]: SK_TEST,
			[STRIPE_ACCOUNT_COUNTRY_KEY]: await storedAccountCountry(SK_TEST, "authentication_failed"),
		});
		expect(texts.find((t) => t.startsWith("Card payments:"))).toBe(
			"Card payments: not ready (missing: publishable key, webhook signing secret).",
		);
	});
});

function lastVerified(texts: string[]): string | undefined {
	return texts.find((t) => t.startsWith("Last verified Stripe webhook:"));
}

describe("Settings — #531: the last verified Stripe webhook", () => {
	test("none recorded: 'never', right after the card payments line", async () => {
		const texts = await settingsTexts(FULL_TEST);
		expect(lastVerified(texts)).toBe("Last verified Stripe webhook: never.");
		const at = texts.findIndex((t) => t.startsWith("Card payments:"));
		expect(texts[at + 1]).toBe(lastVerified(texts));
	});

	test("once one is recorded, its time (UTC, to the minute)", async () => {
		const texts = await settingsTexts({
			...FULL_TEST,
			[STRIPE_WEBHOOK_LAST_VERIFIED_KEY]: "2026-10-22T14:03:27.000Z",
		});
		const line = lastVerified(texts);
		expect(line).toBe("Last verified Stripe webhook: 2026-10-22 14:03 UTC.");
		expect(line!.length).toBeLessThanOrEqual(200);
	});

	test("a garbled record reads as 'never', not as a time", async () => {
		const texts = await settingsTexts({
			...FULL_TEST,
			[STRIPE_WEBHOOK_LAST_VERIFIED_KEY]: "not a time",
		});
		expect(lastVerified(texts)).toBe("Last verified Stripe webhook: never.");
	});

	test.each([
		["nothing saved", {}],
		[
			"the publishable key and webhook secret, but no secret key",
			{
				[STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST,
				[STRIPE_WEBHOOK_SECRET_KEY]: WHSEC,
			},
		],
	] as const)("Stripe not set up (%s): no line at all", async (_name, seed) => {
		expect(lastVerified(await settingsTexts(seed))).toBeUndefined();
	});

	test("a failed read says so, never 'never'", async () => {
		const texts = await settingsTexts(FULL_TEST, {
			failingKeys: [STRIPE_WEBHOOK_LAST_VERIFIED_KEY],
		});
		expect(lastVerified(texts)).toBe(
			"Last verified Stripe webhook: unknown (it couldn't be read). Reload to try again.",
		);
	});
});
