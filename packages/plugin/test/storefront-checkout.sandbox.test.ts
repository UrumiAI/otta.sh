/**
 * B4 (storefront-checkout plan §3) — the plugin's checkout routes under the
 * REAL workerd sandbox (DEVELOPMENT.md §5: if it only works trusted, it's
 * broken), against a stub `@urumi/service`.
 *
 * The sandbox bakes a single `allowedHost` (the stub), so the ONLY reachable
 * egress is the service: the recorded stub requests ARE the plugin's entire
 * network surface, and "no other host" is structural, not aspirational.
 *
 * What this file pins that a unit test cannot:
 *  - `checkout/summary` composes THREE upstream calls IN ORDER, and the
 *    commerce batch is ONE call regardless of line count (the N+1 guard);
 *  - a typed upstream failure (`CART_EMPTY`, `PRODUCT_NOT_PRICED`, …) reaches
 *    the caller as that reason — never `RENDER_FAILED`, never a partial
 *    `ok: true` view with a payable-looking button on it;
 *  - `checkout/place` forwards `Idempotency-Key` verbatim and passes
 *    `clientAction` through UNMODIFIED (the client secret is data in transit,
 *    not something the plugin parses);
 *  - a 502 `PAYMENT_INTENT_FAILED` is a legible business outcome;
 *  - `storefront/order` never sends `X-Internal-Token` — with it the service
 *    would answer the full admin projection on a guest-readable page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type RecordedRequest,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

let stubServer: StubCommerceServer;
let sandboxHandle: SandboxHandle;

interface FakeLine {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
}

/** Test-configurable upstream behaviour, reset per test. */
let cartLines: FakeLine[];
let cartFound: boolean;
let commerceCatalog: Record<string, { amount: number; currency: string; sku: string }>;
let quoteOverride: { status: number; body: unknown } | null;
let checkoutOverride: { status: number; body: unknown } | null;
let orderOverride: { status: number; body: unknown } | null;

const CART_ID = "cart-1";

const BREAKDOWN = {
	currency: "USD",
	subtotalCents: 5997,
	discountCents: 0,
	shippingCents: 0,
	taxCents: 0,
	totalCents: 5997,
	appliedCouponCode: null,
};

const ORDER = {
	id: "order-1",
	state: "pending",
	currency: "USD",
	paymentMethod: "stripe",
	holdExpiresAt: "2099-01-01T00:00:00.000Z",
	createdAt: "2026-07-27T00:00:00.000Z",
	totals: { ...BREAKDOWN, shippingZoneId: null },
	lines: [
		{
			sku: "SKU-1",
			title: "Bamboo Water Bottle",
			unitPriceCents: 1999,
			currency: "USD",
			quantity: 3,
			fulfillmentKind: "physical",
		},
	],
	fulfillment: null,
	cancellation: null,
};

const STRIPE_INTENT = {
	gateway: "stripe",
	intentId: "pi_live_123",
	clientAction: { kind: "stripe_client_secret", clientSecret: "pi_live_123_secret_abcdef" },
};

function line(n: number, productId: string | null): FakeLine {
	return {
		lineId: `line-${n}`,
		sku: `SKU-${n}`,
		productId,
		qty: n,
		reservationId: `res-${n}`,
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
}

/** A faithful-enough fake of the service's checkout surface. */
function installFakeService(): void {
	stubServer.respondWith("POST", (req: RecordedRequest) => {
		if (req.url === "/catalog/commerce/batch") {
			const productIds = (req.body as { productIds?: string[] }).productIds ?? [];
			return {
				status: 200,
				body: {
					items: productIds
						.filter((id) => id in commerceCatalog)
						.map((id) => {
							const item = commerceCatalog[id]!;
							return {
								productId: id,
								sku: item.sku,
								price: { amount: item.amount, currency: item.currency },
								inStock: true,
								active: true,
							};
						}),
				},
			};
		}
		if (req.url === "/checkout/quote") {
			if (quoteOverride !== null) return quoteOverride;
			return { status: 200, body: { ok: true, breakdown: BREAKDOWN } };
		}
		if (req.url === "/checkout/orders") {
			if (checkoutOverride !== null) return checkoutOverride;
			return { status: 201, body: { ok: true, order: ORDER, intent: STRIPE_INTENT } };
		}
		return { status: 404, body: { error: "no route" } };
	});

	stubServer.respondWith("GET", (req: RecordedRequest) => {
		if (req.url.startsWith("/orders/")) {
			if (orderOverride !== null) return orderOverride;
			return { status: 200, body: { ok: true, order: ORDER } };
		}
		if (req.url === `/carts/${CART_ID}`) {
			if (!cartFound) return { status: 404, body: { ok: false, reason: "CART_NOT_FOUND" } };
			return {
				status: 200,
				body: {
					ok: true,
					cart: { cartId: CART_ID, state: "active", currency: "USD", lines: cartLines },
				},
			};
		}
		return { status: 404, body: { ok: false, reason: "CART_NOT_FOUND" } };
	});
}

beforeAll(async () => {
	stubServer = await startStubCommerceServer();
	sandboxHandle = await loadPluginInSandbox({
		allowedHosts: [stubServer.host],
		commerceServiceBaseUrl: stubServer.baseUrl,
	});
}, 120_000);

afterAll(async () => {
	await sandboxHandle?.close();
	await stubServer?.close();
});

beforeEach(() => {
	stubServer.requests.length = 0;
	cartFound = true;
	cartLines = [line(1, "prod-1"), line(2, "prod-2"), line(3, "prod-3")];
	commerceCatalog = {
		"prod-1": { amount: 1999, currency: "USD", sku: "SKU-1" },
		"prod-2": { amount: 1000, currency: "USD", sku: "SKU-2" },
		"prod-3": { amount: 333, currency: "USD", sku: "SKU-3" },
	};
	quoteOverride = null;
	checkoutOverride = null;
	orderOverride = null;
	installFakeService();
});

function resultOf(outcome: unknown): Record<string, unknown> {
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

/** The recorded egress as an ordered `[method, path]` sequence. */
function egress(): [string, string][] {
	return stubServer.requests.map((r) => [r.method, r.url] as [string, string]);
}

describe("storefront/checkout/summary (workerd sandbox)", () => {
	test("composes EXACTLY three upstream calls, in order — cart read → ONE commerce batch → quote — for a MULTI-line cart (the N+1 guard)", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
		);

		expect(result["ok"]).toBe(true);
		expect(egress()).toEqual([
			["GET", `/carts/${CART_ID}`],
			["POST", "/catalog/commerce/batch"],
			["POST", "/checkout/quote"],
		]);
		// One batch for three lines — never one call per line.
		const batch = stubServer.requests[1]!.body as { productIds: string[] };
		expect(batch.productIds).toEqual(["prod-1", "prod-2", "prod-3"]);
	});

	test("returns the QUOTE's totals as authoritative, with honest 'Not calculated' shipping/tax and per-line formatted money", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
		);

		const totals = result["totals"] as Record<string, { money: unknown; label: string }>;
		expect(totals["subtotal"]!.label).toBe("$59.97");
		expect(totals["total"]!.label).toBe("$59.97");
		expect(totals["shipping"]!.money).toBeNull();
		expect(totals["shipping"]!.label).toBe("Not calculated");
		expect(totals["tax"]!.money).toBeNull();
		expect(totals["tax"]!.label).toBe("Not calculated");

		const lines = result["lines"] as {
			sku: string;
			qty: number;
			lineTotal: { formatted: string };
		}[];
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatchObject({ sku: "SKU-1", qty: 1 });
		expect(lines[0]!.lineTotal.formatted).toBe("$19.99");
	});

	test("carries the STABLE per-cart idempotency key the form embeds (never a fresh one per render)", async () => {
		const first = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
		);
		const second = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
		);
		expect(first["idempotencyKey"]).toBe(`checkout:${CART_ID}`);
		expect(second["idempotencyKey"]).toBe(first["idempotencyKey"]);
	});

	test("an EMPTY cart surfaces the quote's typed CART_EMPTY — never RENDER_FAILED, never a partial ok:true view", async () => {
		cartLines = [];
		quoteOverride = { status: 409, body: { ok: false, reason: "CART_EMPTY" } };

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
		);

		// §1.7: "303 to /cart — never render an empty checkout with a
		// payable-looking button". The route's half of that contract is the
		// TYPED reason; the site's half is asserted in checkout-place.test.ts.
		expect(result).toEqual({ ok: false, reason: "CART_EMPTY" });
		expect(result["ok"]).not.toBe(true);
	});

	test.each(["PRODUCT_NOT_PRICED", "CURRENCY_MISMATCH"])(
		"a quote-leg %s surfaces as the typed reason, cleanly and legibly",
		async (reason) => {
			quoteOverride = { status: 409, body: { ok: false, reason } };
			const result = resultOf(
				await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
			);
			expect(result).toEqual({ ok: false, reason });
		},
	);

	test("a missing cart surfaces CART_NOT_FOUND from the cart leg, with NO further egress", async () => {
		cartFound = false;
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID }),
		);
		expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
		expect(egress()).toEqual([["GET", `/carts/${CART_ID}`]]);
	});

	test("a blank cartId is rejected BEFORE any egress", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/summary", {}));
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(stubServer.requests).toHaveLength(0);
	});
});

describe("storefront/checkout/place (workerd sandbox)", () => {
	const INPUT = {
		cartId: CART_ID,
		buyerRef: "Buyer@Example.com",
		idempotencyKey: `checkout:${CART_ID}`,
	};

	test("issues EXACTLY one call — POST /checkout/orders — forwarding Idempotency-Key verbatim and buyerRef un-rewritten", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));

		expect(result["ok"]).toBe(true);
		expect(egress()).toEqual([["POST", "/checkout/orders"]]);
		const req = stubServer.requests[0]!;
		expect(req.headers["idempotency-key"]).toBe(`checkout:${CART_ID}`);
		expect(req.body).toEqual({
			cartId: CART_ID,
			paymentMethod: "stripe",
			// Verbatim — NOT lowercased (ADR-0004 claiming is case-insensitive;
			// rewriting the buyer's own identifier buys nothing).
			buyerRef: "Buyer@Example.com",
		});
	});

	test("passes clientAction through UNMODIFIED — the client secret is data in transit", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect(result["clientAction"]).toEqual(STRIPE_INTENT.clientAction);
		expect(result["orderId"]).toBe("order-1");
		expect(result["state"]).toBe("pending");
		expect(result["alreadyPlaced"]).toBe(false);
	});

	test("NEVER echoes the order's private fields (buyerRef / shippingAddress) back to the caller", async () => {
		checkoutOverride = {
			status: 201,
			body: {
				ok: true,
				// The real service answers the FULL serializeOrder here.
				order: {
					...ORDER,
					buyerRef: "Buyer@Example.com",
					customerId: "cus-1",
					shippingAddress: { name: "A Buyer", line1: "1 Test St" },
				},
				intent: STRIPE_INTENT,
			},
		};
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect(JSON.stringify(result)).not.toContain("Buyer@Example.com");
		expect(result).not.toHaveProperty("order");
		expect(result).not.toHaveProperty("shippingAddress");
	});

	test("forwards the optional ship-to snapshot (ADR-0009 slice c)", async () => {
		await sandboxHandle.invokeRoute("storefront/checkout/place", {
			...INPUT,
			shippingAddress: {
				name: "A Buyer",
				line1: "1 Test St",
				city: "Testville",
				postalCode: "12345",
				country: "Testland",
			},
		});
		expect((stubServer.requests[0]!.body as Record<string, unknown>)["shippingAddress"]).toEqual({
			name: "A Buyer",
			line1: "1 Test St",
			city: "Testville",
			postalCode: "12345",
			country: "Testland",
		});
	});

	test("a REPLAY of an order that has left pending (clientAction none, intentId '') is alreadyPlaced — not an error", async () => {
		checkoutOverride = {
			status: 201,
			body: {
				ok: true,
				order: { ...ORDER, state: "paid" },
				intent: { gateway: "stripe", intentId: "", clientAction: { kind: "none" } },
			},
		};
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect(result["ok"]).toBe(true);
		expect(result["alreadyPlaced"]).toBe(true);
		expect(result["orderId"]).toBe("order-1");
		expect(result["state"]).toBe("paid");
	});

	test("returns the ORDER's own total, formatted — the figure the pay button states", async () => {
		// From `serializeOrder`'s totals block, i.e. what this order will actually
		// charge, and formatted HERE because this package owns the one sanctioned
		// money→string boundary. The site stashes it beside the client secret so
		// the pay step can say "Pay $59.97" without a commerce read against a cart
		// that is still live.
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect(result["total"]).toEqual({
			amount: 5997,
			currency: "USD",
			formatted: "$59.97",
		});
	});

	test("the total honours the requested locale, and falls back rather than failing", async () => {
		const german = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/place", { ...INPUT, locale: "de-DE" }),
		);
		// Asserted on the SEPARATOR, not on the whole string: ICU spells the space
		// before a trailing symbol with a non-breaking codepoint whose exact
		// identity is an ICU-version detail, and pinning an invisible character is
		// how a correct implementation fails this suite on a runtime upgrade.
		const formatted = (german["total"] as Record<string, unknown>)["formatted"] as string;
		expect(formatted).toContain("59,97");
		expect(formatted).not.toBe("$59.97");
		// A malformed tag is display input, not order input: it must not cost the
		// buyer an order.
		const junk = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/place", { ...INPUT, locale: "!!" }),
		);
		expect(junk["ok"]).toBe(true);
		expect((junk["total"] as Record<string, unknown>)["formatted"]).toBe("$59.97");
	});

	test("a REPLAY still carries the total — an order always has one", async () => {
		checkoutOverride = {
			status: 201,
			body: {
				ok: true,
				order: { ...ORDER, state: "paid" },
				intent: { gateway: "stripe", intentId: "", clientAction: { kind: "none" } },
			},
		};
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect((result["total"] as Record<string, unknown>)["formatted"]).toBe("$59.97");
	});

	/**
	 * THE ORDER OUTRANKS ITS LABEL.
	 *
	 * `buildOrderTotal` validates through `cents()`/`currency()`, which throw,
	 * and it runs AFTER `createOrder` succeeded — the order exists, its stock is
	 * held, its client secret is in the reply being formatted. A totals block
	 * this package cannot read must therefore drop the amount off the button and
	 * hand the payment on regardless; letting the throw reach `renderGuard`
	 * would answer RENDER_FAILED, strand a live order, and do it again on every
	 * idempotent replay (which returns the same stored order verbatim).
	 */
	describe("an unformattable total costs the button its amount, never the payment", () => {
		function replyWithOrder(order: unknown): void {
			checkoutOverride = { status: 201, body: { ok: true, order, intent: STRIPE_INTENT } };
		}

		test("a reply with NO totals block still places the order — total simply absent", async () => {
			const { totals: _dropped, ...totalless } = ORDER;
			replyWithOrder(totalless);
			const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
			expect(result["ok"]).toBe(true);
			expect(result).not.toHaveProperty("total");
			expect(result["orderId"]).toBe("order-1");
			expect(result["state"]).toBe("pending");
			expect(result["clientAction"]).toEqual(STRIPE_INTENT.clientAction);
		});

		test.each([
			// `currency()` demands /^[A-Z]{3}$/ — a lowercase code and a symbol both
			// throw, and neither is worth an order.
			["a lowercase currency", { ...BREAKDOWN, currency: "usd", shippingZoneId: null }],
			["a symbol for a currency", { ...BREAKDOWN, currency: "US$", shippingZoneId: null }],
			// `cents()` demands a non-negative safe integer.
			["a fractional total", { ...BREAKDOWN, totalCents: 59.97, shippingZoneId: null }],
			["a null total", { ...BREAKDOWN, totalCents: null, shippingZoneId: null }],
		])("%s drops the total and keeps the order", async (_label, totals) => {
			replyWithOrder({ ...ORDER, totals });
			const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
			expect(result["ok"]).toBe(true);
			expect(result).not.toHaveProperty("total");
			expect(result["orderId"]).toBe("order-1");
			expect(result["clientAction"]).toEqual(STRIPE_INTENT.clientAction);
		});
	});

	test("a 502 becomes the typed PAYMENT_INTENT_FAILED, never RENDER_FAILED", async () => {
		checkoutOverride = { status: 502, body: { ok: false, reason: "PAYMENT_INTENT_FAILED" } };
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect(result).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
	});

	test.each(["CART_CHECKED_OUT", "RESERVATION_LOST", "PRODUCT_NOT_PRICED"])(
		"a 409 %s becomes the typed reason",
		async (reason) => {
			checkoutOverride = { status: 409, body: { ok: false, reason } };
			const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
			expect(result).toEqual({ ok: false, reason });
		},
	);

	test("a 400 INVALID_SHIPPING_ADDRESS becomes the typed reason", async () => {
		checkoutOverride = { status: 400, body: { ok: false, reason: "INVALID_SHIPPING_ADDRESS" } };
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", INPUT));
		expect(result).toEqual({ ok: false, reason: "INVALID_SHIPPING_ADDRESS" });
	});

	test.each([
		["a blank buyerRef", { ...INPUT, buyerRef: "  " }],
		["a missing idempotencyKey", { cartId: CART_ID, buyerRef: "a@b.co" }],
		["a malformed ship-to", { ...INPUT, shippingAddress: { name: "A", line1: 42 } }],
	])("%s is rejected BEFORE any egress", async (_label, input) => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", input));
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(stubServer.requests).toHaveLength(0);
	});
});

describe("storefront/order (workerd sandbox)", () => {
	test("reads the public projection over ctx.http and NEVER sends X-Internal-Token", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: "order-1" }),
		);

		expect(result["ok"]).toBe(true);
		expect(egress()).toEqual([["GET", "/orders/order-1"]]);
		const headerNames = Object.keys(stubServer.requests[0]!.headers).map((h) => h.toLowerCase());
		expect(headerNames).not.toContain("x-internal-token");
	});

	test("renders the order's OWN state plus formatted totals and lines", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: "order-1" }),
		);
		const order = result["order"] as Record<string, unknown>;
		expect(order["state"]).toBe("pending");
		expect((order["totals"] as Record<string, { label: string }>)["total"]!.label).toBe("$59.97");
		const lines = order["lines"] as { title: string; lineTotal: { formatted: string } }[];
		expect(lines[0]!.title).toBe("Bamboo Water Bottle");
		expect(lines[0]!.lineTotal.formatted).toBe("$59.97");
	});

	test("a 404 surfaces the typed ORDER_NOT_FOUND", async () => {
		orderOverride = { status: 404, body: { ok: false, reason: "ORDER_NOT_FOUND" } };
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: "nope" }),
		);
		expect(result).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
	});

	test("a blank orderId is rejected BEFORE any egress", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/order", {}));
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(stubServer.requests).toHaveLength(0);
	});
});

describe("checkout egress is the whole story", () => {
	test("across a full summary → place → order cycle, the plugin reaches EXACTLY ONE host: the commerce service", async () => {
		await sandboxHandle.invokeRoute("storefront/checkout/summary", { cartId: CART_ID });
		await sandboxHandle.invokeRoute("storefront/checkout/place", {
			cartId: CART_ID,
			buyerRef: "a@b.co",
			idempotencyKey: `checkout:${CART_ID}`,
		});
		await sandboxHandle.invokeRoute("storefront/order", { orderId: "order-1" });

		// The sandbox bakes ONE allowedHost; every call above is recorded here,
		// so this list being complete IS the "no other host" proof.
		expect(egress()).toEqual([
			["GET", `/carts/${CART_ID}`],
			["POST", "/catalog/commerce/batch"],
			["POST", "/checkout/quote"],
			["POST", "/checkout/orders"],
			["GET", "/orders/order-1"],
		]);
		// And nothing reached js.stripe.com: card entry is a BROWSER hop
		// (ADR-0012 decision 3), never plugin egress.
		expect(stubServer.requests.every((r) => !r.url.includes("stripe.com"))).toBe(true);
	});
});
