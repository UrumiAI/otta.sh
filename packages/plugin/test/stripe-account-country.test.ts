/**
 * Issue #382 — the Stripe account's country, CACHED in plugin kv. Checkout asks
 * it on every render and every place, so it must cost a kv read there and reach
 * Stripe only when nothing usable is cached: once per key for a known country,
 * and again only after a back-off for the ways it can be unknown. No network:
 * `ctx.http` is a scripted, counting stand-in for `api.stripe.com`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	checkoutRequiresBuyerAddress,
	peekStripeAccountCountry,
	readStripeAccountCountry,
	refreshStripeAccountCountry,
	STRIPE_ACCOUNT_COUNTRY_KEY,
} from "../src/payments/stripe-account-country.js";
import { STRIPE_SECRET_KEY_KEY } from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";

const SK = ["sk_test_", "51AccountCountryFixture000"].join("");
const RK = ["rk_test_", "51AccountCountryFixture000"].join("");
const HOUR = 60 * 60 * 1000;

type Answer = { status: number; body: unknown } | "network-error";

function harness(seed: Record<string, unknown> = { [STRIPE_SECRET_KEY_KEY]: SK }) {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	let answer: Answer = { status: 200, body: { id: "acct_1", country: "US" } };
	const ctx: PluginContext = {
		http: {
			async fetch(url, init) {
				calls.push({ url, ...(init !== undefined ? { init } : {}) });
				if (answer === "network-error") throw new TypeError("fetch failed");
				return new Response(JSON.stringify(answer.body), { status: answer.status });
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
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
	return {
		ctx,
		kv,
		calls,
		answer(next: Answer) {
			answer = next;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the account country is fetched once and cached", () => {
	test("first read asks GET /v1/account with the key; every later read is kv only", async () => {
		const h = harness();
		h.answer({ status: 200, body: { id: "acct_1", country: "IN" } });
		const first = await readStripeAccountCountry(h.ctx);
		expect(first).toMatchObject({ status: "known", country: "IN" });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.url).toBe("https://api.stripe.com/v1/account");
		expect(h.calls[0]?.init?.method).toBe("GET");

		for (let i = 0; i < 5; i += 1) {
			expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(true);
		}
		// A known country is a fact about the account, and an account never changes
		// country: not re-asked even much later, for the same key.
		const later = Date.now() + 90 * 24 * HOUR;
		expect(await readStripeAccountCountry(h.ctx, { now: later })).toMatchObject({
			status: "known",
			country: "IN",
		});
		expect(h.calls).toHaveLength(1);
	});

	test("the cache holds no part of the key — only a digest that ties it to the key", async () => {
		const h = harness();
		await readStripeAccountCountry(h.ctx);
		const stored = JSON.stringify(h.kv.get(STRIPE_ACCOUNT_COUNTRY_KEY));
		expect(stored).not.toContain(SK);
		expect(stored).not.toContain(SK.slice(8, 20));
	});

	test("a different key is a different account: the cache does not carry over", async () => {
		const h = harness();
		h.answer({ status: 200, body: { country: "US" } });
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(false);
		h.kv.set(STRIPE_SECRET_KEY_KEY, ["sk_live_", "51OtherAccountFixture0000"].join(""));
		h.answer({ status: 200, body: { country: "IN" } });
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(true);
		expect(h.calls).toHaveLength(2);
	});

	test("refresh asks Stripe even over a cached answer (the Settings save)", async () => {
		const h = harness();
		await readStripeAccountCountry(h.ctx);
		h.answer({ status: 200, body: { country: "IN" } });
		expect(await refreshStripeAccountCountry(h.ctx)).toMatchObject({
			status: "known",
			country: "IN",
		});
		expect(h.calls).toHaveLength(2);
		expect(await peekStripeAccountCountry(h.ctx)).toMatchObject({ status: "known", country: "IN" });
		expect(h.calls).toHaveLength(2);
	});

	test("peek never reaches Stripe — not even with nothing cached", async () => {
		const h = harness();
		expect(await peekStripeAccountCountry(h.ctx)).toEqual({ status: "not_checked" });
		expect(h.calls).toHaveLength(0);
	});
});

describe("only an India account requires the buyer's address", () => {
	test("US, GB, DE: not required", async () => {
		for (const country of ["US", "GB", "DE"]) {
			const h = harness();
			h.answer({ status: 200, body: { country } });
			expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(false);
		}
	});

	test("IN: required", async () => {
		const h = harness();
		h.answer({ status: 200, body: { country: "IN" } });
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(true);
	});
});

describe("when the country is unknown, checkout does NOT require the address — and says so in the log", () => {
	test("no Stripe key: not configured, nothing asked", async () => {
		const h = harness({});
		expect(await readStripeAccountCountry(h.ctx)).toEqual({ status: "not_configured" });
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(false);
		expect(h.calls).toHaveLength(0);
	});

	test("a restricted key without account read (403): permission_denied, cached for a day", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = harness({ [STRIPE_SECRET_KEY_KEY]: RK });
		h.answer({ status: 403, body: { error: { type: "invalid_request_error" } } });
		const now = Date.now();
		expect(await readStripeAccountCountry(h.ctx, { now })).toMatchObject({
			status: "permission_denied",
		});
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(false);
		expect(warn.mock.calls.flat().join(" ")).toMatch(/restricted key/i);
		// Not re-asked on every checkout — retrying soon cannot help.
		await readStripeAccountCountry(h.ctx, { now: now + 23 * HOUR });
		expect(h.calls).toHaveLength(1);
		// …but asked again after a day, in case the merchant granted the permission.
		h.answer({ status: 200, body: { country: "IN" } });
		expect(await readStripeAccountCountry(h.ctx, { now: now + 25 * HOUR })).toMatchObject({
			status: "known",
			country: "IN",
		});
		expect(h.calls).toHaveLength(2);
	});

	test("Stripe unreachable: unavailable, asked again after five minutes, not before", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = harness();
		h.answer("network-error");
		const now = Date.now();
		expect(await readStripeAccountCountry(h.ctx, { now })).toMatchObject({ status: "unavailable" });
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(false);
		await readStripeAccountCountry(h.ctx, { now: now + 4 * 60 * 1000 });
		expect(h.calls).toHaveLength(1);
		h.answer({ status: 200, body: { country: "IN" } });
		expect(await readStripeAccountCountry(h.ctx, { now: now + 6 * 60 * 1000 })).toMatchObject({
			status: "known",
		});
		expect(h.calls).toHaveLength(2);
	});

	test("a rejected key (401): authentication_failed, asked again after an hour", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = harness();
		h.answer({ status: 401, body: {} });
		const now = Date.now();
		expect(await readStripeAccountCountry(h.ctx, { now })).toMatchObject({
			status: "authentication_failed",
		});
		await readStripeAccountCountry(h.ctx, { now: now + 50 * 60 * 1000 });
		expect(h.calls).toHaveLength(1);
		await readStripeAccountCountry(h.ctx, { now: now + 61 * 60 * 1000 });
		expect(h.calls).toHaveLength(2);
	});

	test("kv failing is unknown too, never a thrown checkout", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = harness();
		h.ctx.kv.get = () => Promise.reject(new Error("kv down"));
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(false);
	});

	test("a cached record of the wrong shape is ignored and re-asked", async () => {
		const h = harness();
		h.kv.set(STRIPE_ACCOUNT_COUNTRY_KEY, { status: "known", country: 42 });
		h.answer({ status: 200, body: { country: "IN" } });
		expect(await checkoutRequiresBuyerAddress(h.ctx)).toBe(true);
		expect(h.calls).toHaveLength(1);
	});
});
