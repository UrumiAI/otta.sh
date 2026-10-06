import { describe, expect, test } from "vitest";
import { fetchStripeAccountCountry, STRIPE_API_VERSION } from "../src/index.js";

// Issue #382: which country the Stripe ACCOUNT is in decides whether checkout
// must collect the buyer's name and address (an India-based account refuses
// export payments without them). `GET /v1/account` answers it. Offline: a stub
// `fetch` stands in for the wire.

const SK = "sk_test_51AccountCountry";

interface Seen {
	url: string;
	init: RequestInit | undefined;
}

function stubFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
	seen: Seen[] = [],
): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
		seen.push({ url: String(target), init });
		return handler(String(target), init);
	}) as unknown as typeof fetch;
}

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchStripeAccountCountry", () => {
	test("reads `country` off GET /v1/account, with the key as Bearer and the pinned version", async () => {
		const seen: Seen[] = [];
		const result = await fetchStripeAccountCountry({
			secretKey: SK,
			fetch: stubFetch(() => json(200, { id: "acct_1", object: "account", country: "IN" }), seen),
		});
		expect(result).toEqual({ ok: true, country: "IN" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("https://api.stripe.com/v1/account");
		expect(seen[0]?.init?.method).toBe("GET");
		expect(seen[0]?.init?.headers).toEqual({
			authorization: `Bearer ${SK}`,
			"stripe-version": STRIPE_API_VERSION,
		});
		expect(seen[0]?.init?.body).toBeUndefined();
	});

	test("a lowercase country is upper-cased; a non-code one is not a country (unavailable)", async () => {
		expect(
			await fetchStripeAccountCountry({
				secretKey: SK,
				fetch: stubFetch(() => json(200, { country: "us" })),
			}),
		).toEqual({ ok: true, country: "US" });
		for (const body of [{ country: "India" }, { country: null }, {}, "nope"]) {
			expect(
				await fetchStripeAccountCountry({ secretKey: SK, fetch: stubFetch(() => json(200, body)) }),
			).toEqual({ ok: false, reason: "unavailable" });
		}
	});

	test("403 — a restricted key without account read permission — is permission_denied", async () => {
		const result = await fetchStripeAccountCountry({
			secretKey: "rk_test_51Restricted",
			fetch: stubFetch(() =>
				json(403, {
					error: {
						type: "invalid_request_error",
						message:
							"The provided key 'rk_test_***' does not have the required permissions for this endpoint on account 'acct_1'.",
					},
				}),
			),
		});
		expect(result).toEqual({ ok: false, reason: "permission_denied" });
	});

	test("401 — a revoked or wrong key — is authentication_failed", async () => {
		expect(
			await fetchStripeAccountCountry({
				secretKey: SK,
				fetch: stubFetch(() => json(401, { error: { type: "invalid_request_error" } })),
			}),
		).toEqual({ ok: false, reason: "authentication_failed" });
	});

	test("5xx, 429, a non-JSON 2xx, a network error and a timeout are all unavailable", async () => {
		const answers: Array<() => Response | Promise<Response>> = [
			() => json(500, {}),
			() => json(429, {}),
			() => new Response("<html>", { status: 200 }),
			() => {
				throw new TypeError("network down");
			},
		];
		for (const answer of answers) {
			expect(await fetchStripeAccountCountry({ secretKey: SK, fetch: stubFetch(answer) })).toEqual({
				ok: false,
				reason: "unavailable",
			});
		}
		// A hung Stripe: the call gives up at its own bound.
		const hung = stubFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const startedAt = Date.now();
		expect(await fetchStripeAccountCountry({ secretKey: SK, fetch: hung, timeoutMs: 50 })).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	test("the key never appears in what comes back", async () => {
		const result = await fetchStripeAccountCountry({
			secretKey: SK,
			fetch: stubFetch(() => json(403, { error: { message: `bad key ${SK}` } })),
		});
		expect(JSON.stringify(result)).not.toContain(SK);
	});
});
