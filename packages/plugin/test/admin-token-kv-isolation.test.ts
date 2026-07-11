import {
	createReportsPageHandler,
	createSettingsFormHandler,
	type PluginContext,
} from "@urumi/plugin";
import { describe, expect, test } from "vitest";

// Review round J7 — defense-in-depth: the admin token (a credential) arrives as
// transient route INPUT and is forwarded to the service over ctx.http. It must
// NEVER be written into ctx.kv (non-secret display storage). Proven directly at
// the handler with a fake PluginContext whose kv is an inspectable Map.

const TOKEN = "SUPER-SECRET-ADMIN-TOKEN-9f3xQ";

interface FakeReq {
	url: string;
	init: RequestInit | undefined;
}

function makeCtx(): { ctx: PluginContext; kv: Map<string, unknown>; requests: FakeReq[] } {
	const kv = new Map<string, unknown>();
	const requests: FakeReq[] = [];
	const ctx: PluginContext = {
		http: {
			async fetch(url: string, init?: RequestInit): Promise<Response> {
				requests.push({ url, init });
				return new Response(
					JSON.stringify({ ok: true, settings: { holdTtlMinutes: 45, lowStockThreshold: 20 } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
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
	return { ctx, kv, requests };
}

const req = { method: "POST", url: "/route/admin/settings", headers: {} };

describe("admin token isolation (J7): the credential never lands in ctx.kv", () => {
	test("save-operational forwards the token to ctx.http but writes nothing token-bearing to ctx.kv", async () => {
		const { ctx, kv, requests } = makeCtx();
		const handler = createSettingsFormHandler();

		// A legitimate kv write first, so the assertion proves kv IS used yet holds
		// no token — not just that kv happens to be empty.
		await handler(
			{ input: { action_id: "save-display", values: { storeDisplayName: "Acme" } }, request: req },
			ctx,
		);
		expect(kv.get("settings:storeDisplayName")).toBe("Acme");

		// The privileged save carrying the admin token.
		await handler(
			{
				input: {
					action_id: "save-operational",
					values: { holdTtlMinutes: 45, lowStockThreshold: 20 },
					idempotencyKey: "k-op",
					adminToken: TOKEN,
				},
				request: req,
			},
			ctx,
		);

		// The token reached the WIRE (forwarded as X-Internal-Token on the PUT)…
		const put = requests.find((r) => (r.init?.method ?? "GET") === "PUT");
		expect(put).toBeDefined();
		expect(JSON.stringify(put?.init?.headers)).toContain(TOKEN);

		// …but ctx.kv holds ONLY the display name — no key or value bears the token.
		const kvDump = JSON.stringify([...kv.entries()]);
		expect(kvDump).not.toContain(TOKEN);
		expect(kv.get("settings:storeDisplayName")).toBe("Acme");
	});

	test("the Reports page forwards the token to ctx.http and writes nothing to ctx.kv at all", async () => {
		const { ctx, kv, requests } = makeCtx();
		const handler = createReportsPageHandler();
		await handler(
			{
				input: {
					from: "2026-07-10T00:00:00.000Z",
					to: "2026-07-12T23:59:59.999Z",
					adminToken: TOKEN,
				},
				request: { method: "POST", url: "/route/admin/reports", headers: {} },
			},
			ctx,
		);
		// The reports reads carried the token…
		expect(requests.length).toBeGreaterThan(0);
		for (const r of requests) {
			expect(JSON.stringify(r.init?.headers)).toContain(TOKEN);
		}
		// …and the page never wrote to kv (it only READS the display name).
		expect(kv.size).toBe(0);
	});
});
