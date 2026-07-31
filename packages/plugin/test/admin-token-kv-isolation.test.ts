import {
	createReportsPageHandler,
	createSettingsFormHandler,
	type PluginContext,
} from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";

// Review round J7 (adapted for the kv-backed token, this change) — the admin
// token is a credential. Under em-dash's admin shell the page_load/form_submit
// interaction carries NO token, so the token is persisted WRITE-ONLY to ctx.kv
// under `settings:internalToken` (the webhook-notifier `secret_input` pattern)
// and forwarded to the service over ctx.http. Defense-in-depth intent
// preserved: the credential lives in EXACTLY ONE kv key and must NEVER leak
// into the display-name kv path (or any other key).

const TOKEN = "SUPER-SECRET-ADMIN-TOKEN-9f3xQ";
const INTERNAL_TOKEN_KEY = "settings:internalToken";
const DISPLAY_NAME_KEY = "settings:storeDisplayName";

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

const req = { method: "POST", url: "/route/admin", headers: {} };

describe("admin token isolation (J7): the credential lives only under its own kv key", () => {
	test("save-token writes ONLY settings:internalToken; save-display never touches or leaks it; save-operational forwards it from kv", async () => {
		const { ctx, kv, requests } = makeCtx();
		const handler = createSettingsFormHandler();

		// The masked secret field persists the token WRITE-ONLY to its own key.
		await handler(
			{
				input: { action_id: "save-token", values: { internalToken: TOKEN } },
				request: req,
			},
			ctx,
		);
		expect(kv.get(INTERNAL_TOKEN_KEY)).toBe(TOKEN);

		// A legitimate display-name kv write — proves kv IS used for the cosmetic
		// pref yet the token stays confined to its own key.
		await handler(
			{ input: { action_id: "save-display", values: { storeDisplayName: "Acme" } }, request: req },
			ctx,
		);
		expect(kv.get(DISPLAY_NAME_KEY)).toBe("Acme");

		// The privileged save forwards the token from kv (NOT from the interaction).
		await handler(
			{
				input: {
					action_id: "save-operational",
					values: { holdTtlMinutes: 45, lowStockThreshold: 20 },
					idempotencyKey: "k-op",
				},
				request: req,
			},
			ctx,
		);

		// The token reached the WIRE (forwarded as X-Internal-Token on the PUT)…
		const put = requests.find((r) => (r.init?.method ?? "GET") === "PUT");
		expect(put).toBeDefined();
		expect(JSON.stringify(put?.init?.headers)).toContain(TOKEN);

		// …and it lives in EXACTLY ONE kv key: the display-name value bears no
		// token, and no key other than settings:internalToken holds it.
		expect(kv.get(DISPLAY_NAME_KEY)).toBe("Acme");
		expect(JSON.stringify(kv.get(DISPLAY_NAME_KEY))).not.toContain(TOKEN);
		for (const [key, value] of kv.entries()) {
			if (key !== INTERNAL_TOKEN_KEY) {
				expect(JSON.stringify(value)).not.toContain(TOKEN);
			}
		}
	});

	test("the Reports page forwards the kv-sourced token to ctx.http and writes NOTHING to kv", async () => {
		const { ctx, kv, requests } = makeCtx();
		// Pre-seed the write-only token key (as the Settings save-token would).
		kv.set(INTERNAL_TOKEN_KEY, TOKEN);

		const handler = createReportsPageHandler();
		await handler(
			{
				input: {
					from: "2026-07-10T00:00:00.000Z",
					to: "2026-07-12T23:59:59.999Z",
				},
				request: { method: "POST", url: "/route/admin", headers: {} },
			},
			ctx,
		);
		// The reports reads carried the token, sourced from kv…
		expect(requests.length).toBeGreaterThan(0);
		for (const r of requests) {
			expect(JSON.stringify(r.init?.headers)).toContain(TOKEN);
		}
		// …and the page never WROTE to kv (it only reads display name + token):
		// the seed remains the sole entry.
		expect([...kv.keys()]).toEqual([INTERNAL_TOKEN_KEY]);
	});
});
