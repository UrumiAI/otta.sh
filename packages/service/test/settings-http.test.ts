import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	STRIPE_WEBHOOK_SECRET,
	startTestServer,
	type TestServer,
} from "./helpers/start-test-server.js";

// Phase 7 §7 Step 5: wire ⇄ port fidelity for /settings, plus the settings-tiering
// SECURITY test — no secret-shaped field is ever in a /settings response body.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("settings HTTP contract", () => {
	let server: TestServer;
	let token: string;
	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	function put(body: unknown, opts: { token?: string; key?: string } = {}): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (opts.token !== undefined) headers["X-Internal-Token"] = opts.token;
		if (opts.key !== undefined) headers["Idempotency-Key"] = opts.key;
		return fetch(`${server.baseUrl}/settings`, {
			method: "PUT",
			headers,
			body: JSON.stringify(body),
		});
	}

	test("GET /settings returns the operational defaults before any write", async () => {
		const body = await json(await fetch(`${server.baseUrl}/settings`));
		expect(body).toEqual({ ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } });
	});

	test("PUT /settings persists and GET reflects it", async () => {
		const res = await put({ holdTtlMinutes: 45, lowStockThreshold: 20 }, { token, key: "k-1" });
		expect(res.status).toBe(200);
		expect((await json(res)).settings).toEqual({ holdTtlMinutes: 45, lowStockThreshold: 20 });
		const read = await json(await fetch(`${server.baseUrl}/settings`));
		expect(read.settings).toEqual({ holdTtlMinutes: 45, lowStockThreshold: 20 });
	});

	test("PUT /settings replayed with the same Idempotency-Key does not double-apply", async () => {
		const first = await json(await put({ holdTtlMinutes: 30 }, { token, key: "k-rep" }));
		await put({ holdTtlMinutes: 99 }, { token, key: "k-other" });
		const replay = await json(await put({ holdTtlMinutes: 30 }, { token, key: "k-rep" }));
		expect(replay.settings).toEqual(first.settings);
		const read = await json(await fetch(`${server.baseUrl}/settings`));
		expect((read.settings as Record<string, unknown>).holdTtlMinutes).toBe(99);
	});

	test("PUT /settings with holdTtlMinutes=0 returns 400 with a structured validation error", async () => {
		const res = await put({ holdTtlMinutes: 0 }, { token, key: "k-bad" });
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.ok).toBe(false);
		expect(body.error).toBe("validation_error");
	});

	test("PUT /settings with a non-integer lowStockThreshold returns 400", async () => {
		const res = await put({ lowStockThreshold: 2.5 }, { token, key: "k-frac" });
		expect(res.status).toBe(400);
	});

	test("PUT /settings without the Idempotency-Key header returns 400", async () => {
		const res = await put({ holdTtlMinutes: 20 }, { token });
		expect(res.status).toBe(400);
	});

	test("PUT /settings without the internal token is rejected (not silently open)", async () => {
		const res = await put({ holdTtlMinutes: 20 }, { key: "k-noauth" });
		expect(res.status).toBe(401);
	});

	test("SECURITY: no secret-shaped field is ever returned from GET /settings", async () => {
		// Change settings so the row exists, then read it back.
		await put({ holdTtlMinutes: 42, lowStockThreshold: 7 }, { token, key: "k-sec" });
		const res = await fetch(`${server.baseUrl}/settings`);
		const raw = await res.text();
		const body = JSON.parse(raw) as { settings: Record<string, unknown> };

		// The response shape is EXACTLY the two operational fields — nothing else.
		expect(Object.keys(body.settings).toSorted()).toEqual(["holdTtlMinutes", "lowStockThreshold"]);

		// No secret-shaped key, at any depth of the serialized body.
		expect(raw).not.toMatch(/secret|password|stripe|webhook|x402|dbUrl|connectionString|apiKey/i);
		// And the actual known secret value never appears.
		expect(raw).not.toContain(STRIPE_WEBHOOK_SECRET);
	});
});
