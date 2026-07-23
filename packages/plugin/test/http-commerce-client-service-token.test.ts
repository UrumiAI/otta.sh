import { describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";

// B6 (ADR-0007) — stub-fetch proof that the write-gate token is threaded as
// `X-Service-Token` on EVERY request when configured (incl. GET reads and the
// POST *read* `getCommerceBatch`), that `logout` carries BOTH the session
// Bearer AND the service token, and that WITHOUT a token no request grows one
// (byte-identical to the pre-gate wire).

const TOKEN = "SVC-TOKEN-abc123";
const BASE = "https://commerce.test";

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

/** A permissive stub that satisfies every client method's response parsing. */
function stubClient(serviceToken: string | undefined): {
	client: HttpCommerceClient;
	requests: Recorded[];
} {
	const requests: Recorded[] = [];
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		requests.push({ url, init });
		return new Response(
			JSON.stringify({
				ok: true,
				cartId: "c1",
				cart: { id: "c1", lines: [] },
				line: { id: "l1" },
				items: [],
				active: true,
				sessionToken: "sess",
				expiresAt: "2026-07-12T00:00:00.000Z",
				orders: [],
				addresses: [],
				order: { id: "o1" },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	const client = new HttpCommerceClient({
		fetch,
		baseUrl: BASE,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
	return { client, requests };
}

/** Case-insensitive header lookup over a plain-object headers init. */
function header(init: RequestInit | undefined, name: string): string | undefined {
	const headers = (init?.headers ?? {}) as Record<string, string>;
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === name.toLowerCase()) return v;
	}
	return undefined;
}

/** Drive one call per HTTP surface the client exposes (read + write + logout). */
async function driveAll(client: HttpCommerceClient): Promise<void> {
	await client.upsertProductCommerce("p1", { sku: "S" }, "k1"); // PUT (write)
	await client.getProductCommerce("p1"); // GET (read)
	await client.softDeleteProductCommerce("p1", "k2"); // DELETE
	await client.activateProductCommerce("p1", "k3", "2026-07-12T00:00:00.000Z"); // POST
	await client.deactivateProductCommerce("p1", "k4", "2026-07-12T00:00:00.000Z"); // POST
	await client.getCommerceBatch(["p1"]); // POST read (gated!)
	await client.createCart("USD"); // POST
	await client.getCart("c1"); // GET
	await client.addCartLine("c1", "S", "p1", 1, "k5"); // POST
	await client.adjustCartLine("c1", "l1", 2, "k6"); // PATCH
	await client.removeCartLine("c1", "l1", "k7"); // DELETE
	await client.checkEntitlement({ orderId: "o1" }, "S"); // GET
	await client.requestLoginLink("a@b.io"); // POST (login pre-auth)
	await client.verifyLogin("ch1", "t1"); // POST (login pre-auth)
	await client.listMyOrders("sess"); // GET (session)
	await client.getMyOrder("sess", "o1"); // GET (session)
	await client.listMyAddresses("sess"); // GET (session)
	await client.logout("sess"); // POST (session) — dual-header
}

describe("HttpCommerceClient X-Service-Token threading (ADR-0007)", () => {
	test("with a token: EVERY request carries X-Service-Token, and logout carries BOTH it and the session Bearer", async () => {
		const { client, requests } = stubClient(TOKEN);
		await driveAll(client);

		expect(requests.length).toBe(18);
		for (const r of requests) {
			expect(header(r.init, "X-Service-Token")).toBe(TOKEN);
		}

		// logout is the LAST call: it is the dual-header session path — the write
		// gate's X-Service-Token AND the customer session Bearer, side by side.
		const logout = requests.at(-1)!;
		expect(logout.url).toBe(`${BASE}/auth/logout`);
		expect(header(logout.init, "authorization")).toBe("Bearer sess");
		expect(header(logout.init, "X-Service-Token")).toBe(TOKEN);
	});

	test("without a token: NO request carries X-Service-Token (byte-identical pre-gate wire)", async () => {
		const { client, requests } = stubClient(undefined);
		await driveAll(client);

		expect(requests.length).toBe(18);
		for (const r of requests) {
			expect(header(r.init, "X-Service-Token")).toBeUndefined();
		}
		// logout still carries its session Bearer — only the gate header is absent.
		const logout = requests.at(-1)!;
		expect(header(logout.init, "authorization")).toBe("Bearer sess");
	});
});
