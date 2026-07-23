import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { totalQty, type CartWire } from "../src/index.js";
import {
	startStubCommerceServer,
	type RecordedRequest,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * Phase 3 §7 step E1 — the plugin's storefront cart routes, exercised under
 * the REAL workerd sandbox against a stub `@urumi/service` (the same harness
 * the PDP/PLP sandbox tests use). Every cart route is a pure proxy over
 * `ctx.http` to `@urumi/service`'s `/carts` REST surface (cart-routes.ts):
 * the sandbox bakes a single `allowedHost` (the stub), so the ONLY reachable
 * egress is the service — any other network/DB surface is structurally
 * unreachable, and the recorded stub requests ARE the plugin's full egress.
 *
 * Cookie note: per cart-routes.ts's platform-verified deviation, a sandboxed
 * route cannot emit `Set-Cookie` (the runner serializes its return value to
 * plain JSON), so `cart/create` returns a cookie DESCRIPTOR for a first-party
 * theme shim to apply on its own response — that descriptor is what "sets the
 * cart cookie" means here, and is what this test asserts.
 */

/** The stub's fake stock ceiling per sku — an add/adjust past this yields the
 *  typed OUT_OF_STOCK token (a 200 body per adapter rule #2), not a throw. */
const STUB_STOCK = 5;

interface FakeLine {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
}
interface FakeCart {
	cartId: string;
	state: string;
	currency: string;
	lines: FakeLine[];
}

let stubServer: StubCommerceServer;
let sandboxHandle: SandboxHandle;
/** In-memory cart truth the stub mutates — reset per test. */
let carts: Map<string, FakeCart>;
let seq: number;

function matchLines(url: string): string | null {
	const m = /^\/carts\/([^/]+)\/lines$/.exec(url);
	return m ? decodeURIComponent(m[1]!) : null;
}
function matchLine(url: string): { cartId: string; lineId: string } | null {
	const m = /^\/carts\/([^/]+)\/lines\/([^/]+)$/.exec(url);
	return m ? { cartId: decodeURIComponent(m[1]!), lineId: decodeURIComponent(m[2]!) } : null;
}
function matchCart(url: string): string | null {
	const m = /^\/carts\/([^/]+)$/.exec(url);
	return m ? decodeURIComponent(m[1]!) : null;
}

/** Install a faithful-enough fake of `@urumi/service`'s `/carts` routes
 *  across all four verbs (the stub keys responders by method; each branches
 *  on the request URL). Mirrors `routes/carts.ts`'s wire shapes 1:1. */
function installFakeCartService(): void {
	stubServer.respondWith("POST", (req: RecordedRequest) => {
		if (req.url === "/carts") {
			const currency = (req.body as { currency?: string }).currency ?? "USD";
			const cartId = `cart-${++seq}`;
			carts.set(cartId, { cartId, state: "active", currency, lines: [] });
			return { status: 201, body: { cartId } };
		}
		const cartId = matchLines(req.url);
		if (cartId !== null) {
			const cart = carts.get(cartId);
			if (!cart) return { status: 404, body: { ok: false, reason: "CART_NOT_FOUND" } };
			const { sku, qty, productId } = req.body as {
				sku: string;
				qty: number;
				productId?: string;
			};
			if (qty > STUB_STOCK) return { status: 200, body: { ok: false, reason: "OUT_OF_STOCK" } };
			const lineId = `line-${++seq}`;
			const line: FakeLine = {
				lineId,
				sku,
				// Mirror the service: an add carrying a productId persists it; an
				// absent productId stays null (issue #80 — legacy bare add).
				productId: productId ?? null,
				qty,
				reservationId: `res-${seq}`,
				expiresAt: "2099-01-01T00:00:00.000Z",
			};
			cart.lines.push(line);
			return { status: 200, body: { ok: true, line } };
		}
		return { status: 404, body: { error: "no route" } };
	});

	stubServer.respondWith("GET", (req: RecordedRequest) => {
		const cartId = matchCart(req.url);
		const cart = cartId === null ? undefined : carts.get(cartId);
		if (!cart) return { status: 404, body: { ok: false, reason: "CART_NOT_FOUND" } };
		return { status: 200, body: { ok: true, cart } };
	});

	stubServer.respondWith("PATCH", (req: RecordedRequest) => {
		const hit = matchLine(req.url);
		const cart = hit === null ? undefined : carts.get(hit.cartId);
		if (!cart) return { status: 404, body: { ok: false, reason: "CART_NOT_FOUND" } };
		const line = cart.lines.find((l) => l.lineId === hit!.lineId);
		if (!line) return { status: 404, body: { ok: false, reason: "LINE_NOT_FOUND" } };
		const { qty } = req.body as { qty: number };
		if (qty > STUB_STOCK) return { status: 200, body: { ok: false, reason: "OUT_OF_STOCK" } };
		line.qty = qty;
		return { status: 200, body: { ok: true, line } };
	});

	stubServer.respondWith("DELETE", (req: RecordedRequest) => {
		const hit = matchLine(req.url);
		const cart = hit === null ? undefined : carts.get(hit.cartId);
		if (!cart) return { status: 404, body: { ok: false, reason: "CART_NOT_FOUND" } };
		const idx = cart.lines.findIndex((l) => l.lineId === hit!.lineId);
		if (idx === -1) return { status: 404, body: { ok: false, reason: "LINE_NOT_FOUND" } };
		cart.lines.splice(idx, 1);
		return { status: 200, body: { ok: true } };
	});
}

beforeAll(async () => {
	stubServer = await startStubCommerceServer();
	sandboxHandle = await loadPluginInSandbox({
		allowedHosts: [stubServer.host],
		commerceServiceBaseUrl: stubServer.baseUrl,
	});
}, 60_000);

afterAll(async () => {
	await sandboxHandle?.close();
	await stubServer?.close();
});

beforeEach(() => {
	stubServer.requests.length = 0;
	carts = new Map();
	seq = 0;
	installFakeCartService();
});

/** Unwrap a sandbox `{ result }` outcome to its route result object. */
function resultOf(outcome: unknown): Record<string, unknown> {
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

describe("storefront cart routes (workerd sandbox)", () => {
	test("cart/create proxies POST /carts and returns the cart-cookie descriptor for the theme shim", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/create", { currency: "USD" }),
		);

		expect(result["ok"]).toBe(true);
		expect(typeof result["cartId"]).toBe("string");
		// The cookie INTENT the plugin cannot itself enact (module doc): a
		// descriptor the first-party theme applies on its own response.
		expect(result["cookie"]).toMatchObject({
			name: "urumi_cart",
			value: result["cartId"],
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
		});

		// Egress: exactly one call, to the service's POST /carts — nothing else.
		expect(stubServer.requests).toHaveLength(1);
		expect(stubServer.requests[0]?.method).toBe("POST");
		expect(stubServer.requests[0]?.url).toBe("/carts");
	});

	test("cart/create rejects a malformed currency BEFORE any egress (pure route validation)", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/create", { currency: "dollars" }),
		);
		expect(result).toEqual({ ok: false, error: "INVALID_CURRENCY" });
		// A validation reject never reaches the service.
		expect(stubServer.requests).toHaveLength(0);
	});

	test("add-to-cart route THREADS productId to the service body and returns the line carrying it (issue #80)", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;
		stubServer.requests.length = 0;

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId,
				sku: "SKU-CART-1",
				productId: "prod-1",
				qty: 2,
				idempotencyKey: "idem-add-1",
			}),
		);

		expect(result["ok"]).toBe(true);
		expect(result["line"]).toMatchObject({ sku: "SKU-CART-1", qty: 2, productId: "prod-1" });

		// Proxied to POST /carts/:id/lines, and the idempotency key rode as the
		// `Idempotency-Key` header (CLAUDE.md: every command carries one). The
		// service body now carries productId (the join key to product_commerce).
		expect(stubServer.requests).toHaveLength(1);
		const req = stubServer.requests[0]!;
		expect(req.method).toBe("POST");
		expect(req.url).toBe(`/carts/${cartId}/lines`);
		expect(req.headers["idempotency-key"]).toBe("idem-add-1");
		expect(req.body).toEqual({ sku: "SKU-CART-1", qty: 2, productId: "prod-1" });
	});

	test("add-to-cart WITHOUT productId (legacy caller) omits it from the body — absent, never a fabricated value; the line's productId stays null", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;
		stubServer.requests.length = 0;

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId,
				sku: "SKU-CART-1",
				qty: 1,
				idempotencyKey: "idem-legacy",
			}),
		);

		expect(result["ok"]).toBe(true);
		expect(result["line"]).toMatchObject({ sku: "SKU-CART-1", productId: null });
		// The wire stays byte-identical to the pre-#80 shape when no productId is
		// supplied — no `productId: null` key leaks onto the body.
		expect(stubServer.requests[0]!.body).toEqual({ sku: "SKU-CART-1", qty: 1 });
	});

	test("add-to-cart rejects a present-but-blank productId before any egress (validated, not silently dropped)", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId: "cart-x",
				sku: "SKU-CART-1",
				productId: "",
				qty: 1,
				idempotencyKey: "idem-blank-pid",
			}),
		);
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(stubServer.requests).toHaveLength(0);
	});

	test("add-to-cart surfaces the typed OUT_OF_STOCK token (a normalized non-throw result), not an error", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId,
				sku: "SKU-CART-2",
				qty: STUB_STOCK + 1,
				idempotencyKey: "idem-add-oos",
			}),
		);
		expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
	});

	test("add-to-cart rejects invalid input (non-positive qty) before any egress", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId: "cart-x",
				sku: "SKU-CART-3",
				qty: 0,
				idempotencyKey: "idem-bad",
			}),
		);
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(stubServer.requests).toHaveLength(0);
	});

	test("cart/read proxies GET /carts/:id and returns the live cart, from which totals derive", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;
		await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
			cartId,
			sku: "SKU-A",
			qty: 2,
			idempotencyKey: "k-a",
		});
		await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
			cartId,
			sku: "SKU-B",
			qty: 3,
			idempotencyKey: "k-b",
		});

		const result = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", { cartId }));
		expect(result["ok"]).toBe(true);
		const cart = result["cart"] as CartWire;
		expect(cart.lines.map((l) => ({ sku: l.sku, qty: l.qty }))).toEqual([
			{ sku: "SKU-A", qty: 2 },
			{ sku: "SKU-B", qty: 3 },
		]);
		// `totalQty` (a plugin export) is the one total honestly computable
		// from the price-free cart-line wire — the "live total" this route
		// backs (see cart-routes.ts's read-handler doc).
		expect(totalQty(cart)).toBe(5);
	});

	test("cart/read maps an unknown cart to the typed CART_NOT_FOUND reason (not a thrown error)", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/read", { cartId: "nope" }),
		);
		expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
	});

	test("cart/read rejects a missing cartId before any egress", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", {}));
		expect(result).toEqual({ ok: false, error: "INVALID_CART_ID" });
		expect(stubServer.requests).toHaveLength(0);
	});

	test("cart/lines/update proxies PATCH with the target qty and Idempotency-Key", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;
		const added = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId,
				sku: "SKU-U",
				qty: 1,
				idempotencyKey: "k-u",
			}),
		);
		const lineId = (added["line"] as { lineId: string }).lineId;
		stubServer.requests.length = 0;

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/update", {
				cartId,
				lineId,
				qty: 4,
				idempotencyKey: "k-u2",
			}),
		);
		expect(result["ok"]).toBe(true);
		expect(result["line"]).toMatchObject({ qty: 4 });
		const req = stubServer.requests[0]!;
		expect(req.method).toBe("PATCH");
		expect(req.url).toBe(`/carts/${cartId}/lines/${lineId}`);
		expect(req.headers["idempotency-key"]).toBe("k-u2");
		expect(req.body).toEqual({ qty: 4 });
	});

	test("cart/lines/remove proxies DELETE and returns a bare ok:true; the line is gone on re-read", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;
		const added = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
				cartId,
				sku: "SKU-R",
				qty: 1,
				idempotencyKey: "k-r",
			}),
		);
		const lineId = (added["line"] as { lineId: string }).lineId;

		const removed = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/remove", {
				cartId,
				lineId,
				idempotencyKey: "k-r2",
			}),
		);
		expect(removed).toEqual({ ok: true });

		const read = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", { cartId }));
		expect((read["cart"] as CartWire).lines).toEqual([]);
	});

	test("a full create→add→read flow reaches the service ONLY via ctx.http — every recorded request is a /carts call", async () => {
		const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
		const cartId = created["cartId"] as string;
		await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
			cartId,
			sku: "SKU-ONLY",
			qty: 1,
			idempotencyKey: "k-only",
		});
		await sandboxHandle.invokeRoute("storefront/cart/read", { cartId });

		// The sandbox's allowedHosts is a single host (the stub); any non-service
		// egress is structurally impossible, so the recorded requests ARE the
		// plugin's entire outbound surface — and every one targets /carts.
		expect(stubServer.requests.length).toBeGreaterThan(0);
		for (const req of stubServer.requests) {
			expect(req.url.startsWith("/carts")).toBe(true);
		}
	});
});
