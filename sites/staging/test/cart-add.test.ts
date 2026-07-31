/**
 * `/cart/add` (item 3 — bogus SKU/garbage productId rejection): a
 * `productId` the theme can independently verify against the CMS (via
 * `getEmDashEntry`, the same "slug or id" lookup `[slug].astro` already
 * uses) is checked BEFORE the plugin's add-line route is ever called, so a
 * garbage/nonexistent productId — or a legit productId paired with a
 * forged/mismatched sku — is rejected with a specific token instead of
 * either a misleading `OUT_OF_STOCK` or silent acceptance (issue #80's
 * orderability re-break risk, named in add.ts's own comment).
 *
 * The legacy bare-add path (no productId at all) is intentionally
 * unaffected — there is no CMS lookup possible without a productId.
 *
 * Mock shapes below are NOT invented — they mirror what `getEmDashEntry`
 * actually returns, reproduced against a real `astro dev` instance backed by
 * the real `astro:content` live loader (browser-QA-reported gap: the
 * original mocks used a clean `{entry: null, error: undefined}` for "not
 * found," which the real dependency never produces). See `LiveEntryNotFoundError`
 * below and add.ts's inline comment for the full trace.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";

const { getEmDashEntry } = vi.hoisted(() => ({ getEmDashEntry: vi.fn() }));
vi.mock("emdash", () => ({ getEmDashEntry }));

import { STOREFRONT_CART_LINE_ADD_ROUTE, STOREFRONT_PRODUCT_ROUTE } from "@otta-sh/plugin";
import { POST } from "../src/pages/cart/add.js";

const SITE = "http://localhost:4321";

/**
 * Mirrors astro's actual `LiveEntryNotFoundError` (astro/dist/content/loaders/errors.js
 * — not exported by `emdash` or `astro:content`'s public surface, so
 * reproduced by shape here): a genuinely nonexistent-but-well-formed id does
 * NOT resolve to a clean `{entry: null}` — `getEmDashEntry`'s `resolveNormal`
 * passes this straight through as `error`. Observed live (dev console,
 * `getEmDashEntry("products", "product:does-not-exist-xyz")`):
 *   { entry: null, error: LiveEntryNotFoundError, isPreview: false, cacheHint: {} }
 * with `error instanceof Error === true`, `error.name === "LiveEntryNotFoundError"`,
 * message `Entry _emdash → {"type":"products","id":"..."} was not found.`
 */
class LiveEntryNotFoundError extends Error {
	constructor(collection: string, id: string) {
		super(`Entry ${collection} → ${JSON.stringify({ type: "products", id })} was not found.`);
		this.name = "LiveEntryNotFoundError";
	}
}

interface HandlerCall {
	route: string;
	body: Record<string, unknown>;
}

/** A configurable fake of `locals.emdash.handlePublicPluginApiRoute`
 *  (`dispatchOttaRoute`'s in-process dispatch target) — routes by path,
 *  records every call so a test can assert the add-line route was NEVER
 *  reached. */
function makeHandler(opts: { productResult?: unknown; addLineResult?: unknown }): {
	handler: NonNullable<APIContext["locals"]["emdash"]>["handlePublicPluginApiRoute"];
	calls: HandlerCall[];
} {
	const calls: HandlerCall[] = [];
	const handler = async (_pluginId: string, _method: string, path: string, request: Request) => {
		const route = path.replace(/^\//, "");
		const body = (await request.json()) as Record<string, unknown>;
		calls.push({ route, body });
		if (route === STOREFRONT_PRODUCT_ROUTE) {
			return { success: true, data: opts.productResult ?? { ok: false, error: "RENDER_FAILED" } };
		}
		if (route === STOREFRONT_CART_LINE_ADD_ROUTE) {
			return {
				success: true,
				data: opts.addLineResult ?? {
					ok: true,
					line: {
						lineId: "line-1",
						sku: body["sku"],
						productId: body["productId"] ?? null,
						qty: body["qty"],
						reservationId: "res-1",
						expiresAt: null,
					},
				},
			};
		}
		return { success: false };
	};
	return { handler: handler as never, calls };
}

function makeContext(form: Record<string, string>, handler: unknown): APIContext {
	const body = new URLSearchParams(form);
	const url = new URL("/cart/add", SITE);
	const request = new Request(url, {
		method: "POST",
		headers: {
			origin: SITE,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
	});
	const cookieStore = new Map<string, string>();
	cookieStore.set("otta_cart", "cart-existing");
	return {
		request,
		url,
		cookies: {
			get: (name: string) => {
				const value = cookieStore.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => cookieStore.set(name, value),
			delete: (name: string) => cookieStore.delete(name),
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (path: string, status = 302) =>
			new Response(null, { status, headers: { location: path } }),
	} as unknown as APIContext;
}

const VALID_PRODUCT_RESULT = {
	ok: true,
	product: {
		id: "prod-1",
		title: "Bamboo Water Bottle",
		purchasable: true,
		sku: "SKU-1",
		price: null,
		availability: "in_stock",
		slots: { addToCart: null },
	},
};

beforeEach(() => {
	getEmDashEntry.mockReset();
});

describe("POST /cart/add — productId pre-check (item 3)", () => {
	test("a productId that resolves to NO CMS entry redirects with PRODUCT_NOT_FOUND, and the add-line route is never called (real shape: entry:null PLUS a LiveEntryNotFoundError, not a clean null)", async () => {
		getEmDashEntry.mockResolvedValue({
			entry: null,
			error: new LiveEntryNotFoundError("_emdash", "prod-does-not-exist"),
		});
		const { handler, calls } = makeHandler({});
		const context = makeContext(
			{ sku: "SKU-GARBAGE", productId: "prod-does-not-exist", idempotencyKey: "idem-1" },
			handler,
		);

		const response = await POST(context);

		expect(response.status).toBe(303);
		const location = response.headers.get("location")!;
		expect(location).toContain("error=PRODUCT_NOT_FOUND");
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("a productId that resolves to a bare {entry:null} with no error at all ALSO redirects with PRODUCT_NOT_FOUND (defensive fallback matching EntryResult's documented, if presently unobserved, contract)", async () => {
		getEmDashEntry.mockResolvedValue({ entry: null, error: undefined });
		const { handler, calls } = makeHandler({});
		const context = makeContext(
			{ sku: "SKU-GARBAGE", productId: "prod-does-not-exist-2", idempotencyKey: "idem-1b" },
			handler,
		);

		const response = await POST(context);

		expect(response.headers.get("location")).toContain("error=PRODUCT_NOT_FOUND");
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("a productId that resolves but whose live sku disagrees with the submitted sku redirects with PRODUCT_UNAVAILABLE, and the add-line route is never called", async () => {
		getEmDashEntry.mockResolvedValue({
			entry: { data: { id: "prod-1", slug: "bamboo", title: "Bamboo Water Bottle" } },
			error: undefined,
		});
		const { handler, calls } = makeHandler({ productResult: VALID_PRODUCT_RESULT });
		const context = makeContext(
			{ sku: "SKU-FORGED", productId: "prod-1", idempotencyKey: "idem-2" },
			handler,
		);

		const response = await POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("error=PRODUCT_UNAVAILABLE");
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("an inactive/not-purchasable product redirects with PRODUCT_UNAVAILABLE even when the sku matches", async () => {
		getEmDashEntry.mockResolvedValue({
			entry: { data: { id: "prod-1", slug: "bamboo", title: "Bamboo Water Bottle" } },
			error: undefined,
		});
		const notPurchasable = {
			ok: true,
			product: { ...VALID_PRODUCT_RESULT.product, purchasable: false, sku: null },
		};
		const { handler, calls } = makeHandler({ productResult: notPurchasable });
		const context = makeContext(
			{ sku: "SKU-1", productId: "prod-1", idempotencyKey: "idem-3" },
			handler,
		);

		const response = await POST(context);

		expect(response.headers.get("location")).toContain("error=PRODUCT_UNAVAILABLE");
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("the CMS lookup itself erroring (transient) redirects with SERVICE_UNAVAILABLE, NOT PRODUCT_NOT_FOUND — a plain Error, distinct by .name from LiveEntryNotFoundError", async () => {
		// Real shape: `resolveNormal`'s catch / `loadEntry`'s catch both do
		// `new Error("Failed to load entry: ...")` — a plain Error whose
		// `.name` is the default `"Error"`, never `"LiveEntryNotFoundError"`.
		getEmDashEntry.mockResolvedValue({
			entry: null,
			error: new Error("Failed to load entry: D1_ERROR: database is locked"),
		});
		const { handler, calls } = makeHandler({});
		const context = makeContext(
			{ sku: "SKU-1", productId: "prod-1", idempotencyKey: "idem-4" },
			handler,
		);

		const response = await POST(context);

		expect(response.headers.get("location")).toContain("error=SERVICE_UNAVAILABLE");
		expect(response.headers.get("location")).not.toContain("PRODUCT_NOT_FOUND");
		expect(calls.some((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE)).toBe(false);
	});

	test("a VALID productId+sku pair reaches the add-line route and succeeds", async () => {
		getEmDashEntry.mockResolvedValue({
			entry: { data: { id: "prod-1", slug: "bamboo", title: "Bamboo Water Bottle" } },
			error: undefined,
		});
		const { handler, calls } = makeHandler({ productResult: VALID_PRODUCT_RESULT });
		const context = makeContext(
			{ sku: "SKU-1", productId: "prod-1", idempotencyKey: "idem-5" },
			handler,
		);

		const response = await POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/cart");
		const addCall = calls.find((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE);
		expect(addCall).toBeDefined();
		expect(addCall!.body["sku"]).toBe("SKU-1");
		expect(addCall!.body["productId"]).toBe("prod-1");
		expect(getEmDashEntry).toHaveBeenCalledWith("products", "prod-1");
	});

	test("legacy bare add (no productId) is UNAFFECTED — no CMS lookup, still reaches the add-line route", async () => {
		const { handler, calls } = makeHandler({});
		const context = makeContext({ sku: "SKU-LEGACY", idempotencyKey: "idem-6" }, handler);

		const response = await POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/cart");
		expect(getEmDashEntry).not.toHaveBeenCalled();
		const addCall = calls.find((c) => c.route === STOREFRONT_CART_LINE_ADD_ROUTE);
		expect(addCall).toBeDefined();
		expect(addCall!.body["productId"]).toBeUndefined();
	});
});
