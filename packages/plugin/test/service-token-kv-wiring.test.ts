import { describe, expect, test } from "vitest";
import type { PluginContext } from "../src/types.js";
import { SERVICE_TOKEN_KEY } from "../src/manifest.js";
import { INTERNAL_TOKEN_KEY, createSettingsFormHandler } from "../src/admin/settings-form.js";
import { createAfterSaveHandler } from "../src/sync/hooks.js";
import { createCartLineAddRouteHandler } from "../src/storefront/cart-routes.js";
import { createAccountOrdersHandler } from "../src/storefront/account-routes.js";
import { createOrdersConsoleHandler } from "../src/admin/orders-console-route.js";

// ADR-0007 — every plugin client sources the write-gate token from write-only
// kv (`settings:serviceToken`) at runtime and forwards it as `X-Service-Token`.
// These per-site tests mirror the admin-token kv tests: a fake ctx with a seeded
// kv + a capturing `ctx.http.fetch`, asserting the header rides each construction
// site (sync hook, storefront write, dual-header session read, admin panel write,
// settings PUT, admin transition), that an unset kv attaches NO header, and that
// the Settings provisioning field persists write-only and never renders back.
//
// The Orders transition is driven through the CONSOLE route (INC-R2): the Block
// Kit Orders screen it used to be driven through was retired by ADR-0015, and the
// console branch is now the only construction site for an Orders write.

const SERVICE_TOKEN = "SVC-9f3xQ-write-gate";
const INTERNAL_TOKEN = "INT-admin-token";

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

function makeCtx(seed: Record<string, string> = {}): {
	ctx: PluginContext;
	kv: Map<string, unknown>;
	requests: Recorded[];
} {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const requests: Recorded[] = [];
	const ctx: PluginContext = {
		http: {
			async fetch(url: string, init?: RequestInit): Promise<Response> {
				requests.push({ url, init });
				return new Response(
					JSON.stringify({
						ok: true,
						transitioned: true,
						cart: { id: "c1", lines: [] },
						line: { id: "l1" },
						orders: [],
						settings: { holdTtlMinutes: 45, lowStockThreshold: 20 },
						order: { id: "o1", state: "paid", lines: [], totals: { currency: "USD" } },
						allowedTransitions: [],
					}),
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

const req = { method: "POST", url: "/route", headers: {} };

function header(init: RequestInit | undefined, name: string): string | undefined {
	const headers = (init?.headers ?? {}) as Record<string, string>;
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === name.toLowerCase()) return v;
	}
	return undefined;
}

function find(requests: Recorded[], method: string, urlPart: string): Recorded | undefined {
	return requests.find((r) => (r.init?.method ?? "GET") === method && r.url.includes(urlPart));
}

describe("service token rides every construction site from write-only kv (ADR-0007)", () => {
	test("sync afterSave upsert (PUT) carries X-Service-Token", async () => {
		const { ctx, requests } = makeCtx({ [SERVICE_TOKEN_KEY]: SERVICE_TOKEN });
		await createAfterSaveHandler()(
			{
				collection: "products",
				isNew: false,
				content: {
					id: "p1",
					updatedAt: "2026-07-12",
					// The write only fires when the commerce field derives a valid,
					// sellable row (issue #81 rework — afterSave is the sole write path).
					// `title` sits in `data` beside `commerce`: em-dash's ContentItem has
					// no top-level title — every non-system column lands in `data`.
					data: { title: "Blue Mug", commerce: { sku: "S1", price: 1000, currency: "USD" } },
				},
			},
			ctx,
		);
		const put = find(requests, "PUT", "/products/p1/commerce");
		expect(put).toBeDefined();
		expect(header(put?.init, "X-Service-Token")).toBe(SERVICE_TOKEN);
	});

	test("storefront cart line add (POST) carries X-Service-Token", async () => {
		const { ctx, requests } = makeCtx({ [SERVICE_TOKEN_KEY]: SERVICE_TOKEN });
		await createCartLineAddRouteHandler()(
			{ input: { cartId: "c1", sku: "S", qty: 1, idempotencyKey: "k1" }, request: req },
			ctx,
		);
		const post = find(requests, "POST", "/carts/c1/lines");
		expect(post).toBeDefined();
		expect(header(post?.init, "X-Service-Token")).toBe(SERVICE_TOKEN);
	});

	test("account session read (GET /me/orders) carries BOTH X-Service-Token and the session Bearer", async () => {
		const { ctx, requests } = makeCtx({ [SERVICE_TOKEN_KEY]: SERVICE_TOKEN });
		await createAccountOrdersHandler()(
			{ input: { sessionToken: "sess-123" }, request: { method: "GET", url: "/r", headers: {} } },
			ctx,
		);
		const get = find(requests, "GET", "/me/orders");
		expect(get).toBeDefined();
		expect(header(get?.init, "X-Service-Token")).toBe(SERVICE_TOKEN);
		expect(header(get?.init, "authorization")).toBe("Bearer sess-123");
	});

	test("Settings save-operational PUT carries BOTH X-Service-Token and X-Internal-Token", async () => {
		const { ctx, requests } = makeCtx({
			[SERVICE_TOKEN_KEY]: SERVICE_TOKEN,
			[INTERNAL_TOKEN_KEY]: INTERNAL_TOKEN,
		});
		await createSettingsFormHandler()(
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
		const put = find(requests, "PUT", "/settings");
		expect(put).toBeDefined();
		expect(header(put?.init, "X-Service-Token")).toBe(SERVICE_TOKEN);
		expect(header(put?.init, "X-Internal-Token")).toBe(INTERNAL_TOKEN);
	});

	test("admin Orders transition POST carries BOTH X-Service-Token and X-Internal-Token", async () => {
		const { ctx, requests } = makeCtx({
			[SERVICE_TOKEN_KEY]: SERVICE_TOKEN,
			[INTERNAL_TOKEN_KEY]: INTERNAL_TOKEN,
		});
		await createOrdersConsoleHandler()(
			{
				// DA-6: the transition ids are per-state and DERIVED from the plugin's
				// closed `ORDER_STATES`, so the target comes from the id, never from
				// the operator-alterable `value.toState`.
				input: {
					type: "otta_console_act",
					action_id: "orders:transition-paid",
					// `state` is the DA-2a watermark the control rendered with. It is not
					// optional: with it absent the handler refuses instead of writing
					// unchecked, so a token-wiring test has to send the real payload shape.
					value: { orderId: "o1", toState: "paid", state: "paid" },
				},
				request: req,
			},
			ctx,
		);
		const post = find(requests, "POST", "/admin/orders/o1/transition");
		expect(post).toBeDefined();
		expect(header(post?.init, "X-Service-Token")).toBe(SERVICE_TOKEN);
		expect(header(post?.init, "X-Internal-Token")).toBe(INTERNAL_TOKEN);
	});

	// -- omission: no token in kv ⇒ no X-Service-Token header anywhere -----------

	test("kv unset: a storefront write attaches NO X-Service-Token", async () => {
		const { ctx, requests } = makeCtx(); // empty kv
		await createCartLineAddRouteHandler()(
			{ input: { cartId: "c1", sku: "S", qty: 1, idempotencyKey: "k1" }, request: req },
			ctx,
		);
		const post = find(requests, "POST", "/carts/c1/lines");
		expect(post).toBeDefined();
		expect(header(post?.init, "X-Service-Token")).toBeUndefined();
	});

	test("kv unset: an admin transition attaches NO X-Service-Token (internal token still flows)", async () => {
		const { ctx, requests } = makeCtx({ [INTERNAL_TOKEN_KEY]: INTERNAL_TOKEN });
		await createOrdersConsoleHandler()(
			{
				// DA-6: the transition ids are per-state and DERIVED from the plugin's
				// closed `ORDER_STATES`, so the target comes from the id, never from
				// the operator-alterable `value.toState`.
				input: {
					type: "otta_console_act",
					action_id: "orders:transition-paid",
					// `state` is the DA-2a watermark the control rendered with. It is not
					// optional: with it absent the handler refuses instead of writing
					// unchecked, so a token-wiring test has to send the real payload shape.
					value: { orderId: "o1", toState: "paid", state: "paid" },
				},
				request: req,
			},
			ctx,
		);
		const post = find(requests, "POST", "/admin/orders/o1/transition");
		expect(post).toBeDefined();
		expect(header(post?.init, "X-Service-Token")).toBeUndefined();
		expect(header(post?.init, "X-Internal-Token")).toBe(INTERNAL_TOKEN);
	});
});

describe("Settings provisioning of the service token (write-only, ADR-0007)", () => {
	test("save-service-token persists ONLY to settings:serviceToken and is never rendered back", async () => {
		const { ctx, kv } = makeCtx();
		const handler = createSettingsFormHandler();

		const res = await handler(
			{
				input: { action_id: "save-service-token", values: { serviceToken: SERVICE_TOKEN } },
				request: req,
			},
			ctx,
		);
		expect(kv.get(SERVICE_TOKEN_KEY)).toBe(SERVICE_TOKEN);
		// The re-rendered page NEVER echoes the secret into any block/toast.
		expect(JSON.stringify(res)).not.toContain(SERVICE_TOKEN);
		// It lives in EXACTLY its own key.
		for (const [key, value] of kv.entries()) {
			if (key !== SERVICE_TOKEN_KEY) expect(JSON.stringify(value)).not.toContain(SERVICE_TOKEN);
		}
	});

	test("a blank save-service-token submit does NOT clobber an existing token", async () => {
		const { ctx, kv } = makeCtx({ [SERVICE_TOKEN_KEY]: SERVICE_TOKEN });
		await createSettingsFormHandler()(
			{ input: { action_id: "save-service-token", values: { serviceToken: "" } }, request: req },
			ctx,
		);
		expect(kv.get(SERVICE_TOKEN_KEY)).toBe(SERVICE_TOKEN);
	});
});
