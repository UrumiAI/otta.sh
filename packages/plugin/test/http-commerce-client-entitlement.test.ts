import { describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";

// Issue #33 / ADR-0008 — stub-fetch proof of the client's entitlement-check wire
// shape: the orderId scope carries NO auth header and NEVER a buyerRef param, the
// session scope threads `authorization: Bearer`, and a 401 is normalized to a
// typed UNAUTHENTICATED result (never a thrown CommerceClientError). Pure wire
// checks, so no live service / Postgres.

const BASE = "https://commerce.test";

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

function stubClient(
	status: number,
	active: boolean,
): {
	client: HttpCommerceClient;
	requests: Recorded[];
} {
	const requests: Recorded[] = [];
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		requests.push({ url, init });
		const body = status === 401 ? { ok: false, error: "unauthorized" } : { ok: true, active };
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { client: new HttpCommerceClient({ fetch, baseUrl: BASE }), requests };
}

function header(init: RequestInit | undefined, name: string): string | undefined {
	const headers = (init?.headers ?? {}) as Record<string, string>;
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === name.toLowerCase()) return v;
	}
	return undefined;
}

describe("HttpCommerceClient.checkEntitlement (ADR-0008)", () => {
	test("orderId scope: no auth header, no buyerRef param, returns {ok,active}", async () => {
		const { client, requests } = stubClient(200, true);
		const result = await client.checkEntitlement({ orderId: "o1" }, "DIG-1");
		expect(result).toEqual({ ok: true, active: true });

		const req = requests[0]!;
		const url = new URL(req.url);
		expect(url.searchParams.get("orderId")).toBe("o1");
		expect(url.searchParams.get("sku")).toBe("DIG-1");
		expect(url.searchParams.has("buyerRef")).toBe(false);
		expect(header(req.init, "authorization")).toBeUndefined();
	});

	test("session scope: sends Authorization: Bearer and never a buyerRef param", async () => {
		const { client, requests } = stubClient(200, true);
		await client.checkEntitlement({}, "DIG-1", { sessionToken: "sess-abc" });

		const req = requests[0]!;
		const url = new URL(req.url);
		expect(header(req.init, "authorization")).toBe("Bearer sess-abc");
		expect(url.searchParams.has("buyerRef")).toBe(false);
		expect(url.searchParams.has("orderId")).toBe(false);
	});

	test("a 401 surfaces as a typed UNAUTHENTICATED result, not a thrown error", async () => {
		const { client } = stubClient(401, false);
		const result = await client.checkEntitlement({}, "DIG-1", { sessionToken: "expired" });
		expect(result).toEqual({ ok: false, reason: "UNAUTHENTICATED" });
	});
});
