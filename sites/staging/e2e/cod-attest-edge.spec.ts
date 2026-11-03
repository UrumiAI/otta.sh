/**
 * ADR-0044 §7 (review round 2 M1, round 3 R3-1): the cash-on-delivery attestation
 * header is the site's own — its in-process dispatch from /checkout/place sets it,
 * and only with the per-IP write limit. Pinned here through the REAL chain: an
 * outside HTTP request that carries it is refused by the site's middleware with a
 * 400 text/plain before any plugin route runs, however the path or the header name
 * is spelled. The control — the same POST without the header — is not that 400.
 */
import { COD_ATTEST_HEADER, COD_ATTEST_VALUE } from "@urumi.ai/otta-plugin";
import { E2E_BASE_URL, expect, skipWithoutSite, test } from "./harness.js";

const PLACE = "/_emdash/api/plugins/otta/storefront/checkout/place";
const BODY = {
	cartId: "cart-attest-probe",
	buyerRef: "probe@example.test",
	idempotencyKey: "checkout:cart-attest-probe",
	paymentMethod: "cod",
};

test.describe("an outside request carrying the COD attestation", () => {
	const cases: Array<{ name: string; method: "POST" | "GET"; path: string; header: string }> = [
		{
			name: "POST to the plugin's place route",
			method: "POST",
			path: PLACE,
			header: COD_ATTEST_HEADER,
		},
		{
			name: "the same path with %2F encoding",
			method: "POST",
			path: "/_emdash/api/plugins/otta/storefront%2Fcheckout%2Fplace",
			header: COD_ATTEST_HEADER,
		},
		{ name: "a trailing slash", method: "POST", path: `${PLACE}/`, header: COD_ATTEST_HEADER },
		{
			name: "GET, mixed-case header name",
			method: "GET",
			path: PLACE,
			header: "X-Otta-COD-Attest",
		},
		{
			name: "the site's own /checkout/place",
			method: "POST",
			path: "/checkout/place",
			header: COD_ATTEST_HEADER,
		},
	];

	for (const c of cases) {
		test(`${c.name} is refused 400 text/plain by the site`, async ({ request }, testInfo) => {
			await skipWithoutSite(testInfo);
			const res = await request.fetch(`${E2E_BASE_URL}${c.path}`, {
				method: c.method,
				headers: {
					[c.header]: COD_ATTEST_VALUE,
					origin: E2E_BASE_URL,
					"content-type": "application/json",
				},
				...(c.method === "POST" ? { data: BODY } : {}),
				maxRedirects: 0,
			});
			expect(res.status()).toBe(400);
			expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
			expect(await res.text()).toBe("Bad request");
		});
	}

	test("control: the same POST without the header is not the middleware's 400", async ({
		request,
	}, testInfo) => {
		await skipWithoutSite(testInfo);
		const res = await request.fetch(`${E2E_BASE_URL}${PLACE}`, {
			method: "POST",
			headers: { origin: E2E_BASE_URL, "content-type": "application/json" },
			data: BODY,
			maxRedirects: 0,
		});
		expect(res.status()).not.toBe(400);
		expect(await res.text()).not.toBe("Bad request");
	});
});
