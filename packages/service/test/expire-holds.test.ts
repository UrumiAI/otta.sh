import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

const PG = process.env.PG_CONNECTION_STRING;

// D2 — POST /internal/expire-holds reclaims globally-expired holds (the sweep).
describe.skipIf(PG === undefined)("POST /internal/expire-holds [live server, Postgres]", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startTestServer();
	});
	afterAll(async () => {
		await server.stop();
	});

	async function req(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const res = await fetch(`${server.baseUrl}${path}`, {
			method,
			headers: { "content-type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	test("the sweep endpoint reclaims a lapsed hold's stock", async () => {
		await server.seed("SKU-SWEEP", 5);
		const cart = await req("POST", "/carts", {});
		const cartId = cart.body.cartId as string;
		await req(
			"POST",
			`/carts/${cartId}/lines`,
			{ sku: "SKU-SWEEP", qty: 3 },
			{ "Idempotency-Key": "s1" },
		);
		expect(await server.onHand("SKU-SWEEP")).toBe(2);

		// Before the TTL, the sweep reclaims nothing.
		const early = await req("POST", "/internal/expire-holds");
		expect(early.status).toBe(200);
		expect(early.body).toEqual({ ok: true, reclaimed: 0 });
		expect(await server.onHand("SKU-SWEEP")).toBe(2);

		// Past the TTL, the sweep reclaims the hold and returns its stock.
		server.advance(16 * 60 * 1000);
		const swept = await req("POST", "/internal/expire-holds");
		expect(swept.status).toBe(200);
		expect(swept.body).toEqual({ ok: true, reclaimed: 1 });
		expect(await server.onHand("SKU-SWEEP")).toBe(5);
	});
});
