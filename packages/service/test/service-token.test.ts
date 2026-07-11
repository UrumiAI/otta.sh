import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryAddressStore,
	InMemoryCartStore,
	InMemoryCouponStore,
	InMemoryCredentialVerifier,
	InMemoryCustomerStore,
	InMemoryEntitlementStore,
	InMemoryInventoryStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	InMemoryProductCommerceStore,
	InMemoryReportingStore,
	InMemorySessionStore,
	InMemorySettingsStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
} from "@urumi/domain/testing";
import { StripePaymentGateway } from "@urumi/payments-stripe";
import type { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// D9 — the SERVICE_API_TOKEN write gate at the app level, over the IO-free
// in-memory stores via `app.request()` (no server, no PG). Token set ⇒ every
// non-GET/HEAD method on every path needs `Authorization: Bearer <token>`;
// GET/HEAD (and /health) stay open; token unset ⇒ exactly today's behavior.
interface TestApp {
	app: Hono;
	inventory: InMemoryInventoryStore;
	internalToken: string | undefined;
}

function makeApp(options: { serviceToken?: string; internalToken?: string } = {}): TestApp {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
	const cartStore = new InMemoryCartStore({
		idGen: new CountingIdGen("cart"),
		reservationState: (id) => {
			try {
				return inventory.reservationState(id);
			} catch {
				return undefined;
			}
		},
		releaseHold: (id) => {
			void inventory.release(id);
		},
	});
	const productCommerce = new InMemoryProductCommerceStore({
		clock,
		inventoryOnHand: (s) => inventory.onHand(s),
	});
	const idGen = new CountingIdGen("id");
	const customerStore = new InMemoryCustomerStore({ idGen, clock });
	const app = createApp({
		store: inventory,
		productCommerce,
		cartStore,
		orderStore: new InMemoryOrderStore({ idGen, clock }),
		entitlementStore: new InMemoryEntitlementStore({ idGen, clock }),
		paymentEventStore: new InMemoryPaymentEventStore(),
		shippingRules: new InMemoryShippingRulesStore(),
		taxRules: new InMemoryTaxRulesStore(),
		couponStore: new InMemoryCouponStore({ idGen }),
		reportingStore: new InMemoryReportingStore(),
		settingsStore: new InMemorySettingsStore(),
		customerStore,
		addressStore: new InMemoryAddressStore({ idGen, clock }),
		sessionStore: new InMemorySessionStore({ idGen, clock }),
		credentialVerifier: new InMemoryCredentialVerifier({ customerStore, idGen, clock }),
		emailSender: new FakeEmailSender(),
		idGen,
		// A REAL Stripe gateway with a test secret so the webhook route's OWN
		// auth (Stripe-Signature HMAC over raw bytes) is live in these tests.
		gateways: { stripe: new StripePaymentGateway({ webhookSecret: "whsec_gate_test", clock }) },
		clock,
		serviceToken: options.serviceToken,
		internalToken: options.internalToken,
	});
	return { app, inventory, internalToken: options.internalToken };
}

const TOKEN = "svc-secret";
const bearer = { Authorization: `Bearer ${TOKEN}` };
const json = { "content-type": "application/json" };

describe("SERVICE_API_TOKEN write gate (token set)", () => {
	test.each([
		["POST", "/inventory/reserve", { sku: "S", qty: 1 }],
		["POST", "/carts", {}],
		["PUT", "/products/p1/commerce", { sku: "S" }],
		["POST", "/catalog/commerce/batch", { productIds: ["p1"] }],
		["POST", "/internal/expire-holds", undefined],
		// Phase 4 mutating routes are gated too: checkout and the internal order
		// sweep are CMS-/first-party-server-called (they can carry the Bearer);
		// /entitlements/grant is service-authenticated and server-called likewise.
		["POST", "/checkout/orders", { cartId: "c1", paymentMethod: "stripe", buyerRef: "b@x.io" }],
		["POST", "/internal/expire-orders", undefined],
		["POST", "/entitlements/grant", {}],
	] as const)("%s %s without Authorization is 401", async (method, path, body) => {
		const { app } = makeApp({ serviceToken: TOKEN });
		const res = await app.request(path, {
			method,
			headers: json,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test("a wrong Bearer token is 401", async () => {
		const { app } = makeApp({ serviceToken: TOKEN });
		const res = await app.request("/carts", {
			method: "POST",
			headers: { ...json, Authorization: "Bearer wrong" },
			body: "{}",
		});
		expect(res.status).toBe(401);
	});

	test("the correct Bearer token reaches the routes (full cart write path)", async () => {
		const { app, inventory } = makeApp({ serviceToken: TOKEN });
		inventory.seed("SKU-1", 5);

		const created = await app.request("/carts", {
			method: "POST",
			headers: { ...json, ...bearer },
			body: "{}",
		});
		expect(created.status).toBe(201);
		const { cartId } = (await created.json()) as { cartId: string };

		const added = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, ...bearer, "Idempotency-Key": "k1" },
			body: JSON.stringify({ sku: "SKU-1", qty: 2 }),
		});
		expect(added.status).toBe(200);
		expect(inventory.onHand("SKU-1")).toBe(3);
	});

	test("GET/HEAD and /health stay open as the storefront read surface", async () => {
		const { app } = makeApp({ serviceToken: TOKEN });
		expect((await app.request("/health")).status).toBe(200);
		expect((await app.request("/health", { method: "HEAD" })).status).toBe(200);
		// GET /carts/:id (unknown id) reaches the route: 404, not 401.
		expect((await app.request("/carts/nope")).status).toBe(404);
		// GET /products/:id/commerce reaches the route (200 view), not 401.
		expect((await app.request("/products/nope/commerce")).status).toBe(200);
	});

	test("POST /webhooks/stripe is EXEMPT from the Bearer gate — its own Stripe-Signature auth still applies", async () => {
		const { app } = makeApp({ serviceToken: TOKEN });
		// No Authorization header, garbage signature: the request REACHES the
		// webhook route (never 401 from the gate) and is rejected by the route's
		// own HMAC verification (400 INVALID_SIGNATURE). Stripe cannot carry our
		// Bearer token — signature auth is the exemption's justification.
		const res = await app.request("/webhooks/stripe", {
			method: "POST",
			headers: { ...json, "Stripe-Signature": "t=1,v1=deadbeef" },
			body: JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	test("the webhook exemption is exact method+path: other paths AND other verbs stay gated", async () => {
		const { app } = makeApp({ serviceToken: TOKEN });
		const otherPath = await app.request("/webhooks/other", { method: "POST", headers: json });
		expect(otherPath.status).toBe(401);
		// Same path, different verb: only POST carries Stripe's signature auth.
		const put = await app.request("/webhooks/stripe", { method: "PUT", headers: json });
		expect(put.status).toBe(401);
		const del = await app.request("/webhooks/stripe", { method: "DELETE" });
		expect(del.status).toBe(401);
	});

	test("/internal/expire-holds with both secrets set needs Bearer AND X-Internal-Token", async () => {
		const { app } = makeApp({ serviceToken: TOKEN, internalToken: "int-secret" });
		// Only the internal token: blocked at the Bearer gate.
		const onlyInternal = await app.request("/internal/expire-holds", {
			method: "POST",
			headers: { "X-Internal-Token": "int-secret" },
		});
		expect(onlyInternal.status).toBe(401);
		// Only the Bearer token: passes the gate, 401s at the internal check.
		const onlyBearer = await app.request("/internal/expire-holds", {
			method: "POST",
			headers: bearer,
		});
		expect(onlyBearer.status).toBe(401);
		// Both: 200.
		const both = await app.request("/internal/expire-holds", {
			method: "POST",
			headers: { ...bearer, "X-Internal-Token": "int-secret" },
		});
		expect(both.status).toBe(200);
		expect(await both.json()).toEqual({ ok: true, reclaimed: 0 });
	});

	test("/internal/expire-orders with both secrets set needs Bearer AND X-Internal-Token", async () => {
		const { app } = makeApp({ serviceToken: TOKEN, internalToken: "int-secret" });
		const onlyInternal = await app.request("/internal/expire-orders", {
			method: "POST",
			headers: { "X-Internal-Token": "int-secret" },
		});
		expect(onlyInternal.status).toBe(401); // blocked at the Bearer gate
		const onlyBearer = await app.request("/internal/expire-orders", {
			method: "POST",
			headers: bearer,
		});
		expect(onlyBearer.status).toBe(401); // passes the gate, 401s at the internal check
		const both = await app.request("/internal/expire-orders", {
			method: "POST",
			headers: { ...bearer, "X-Internal-Token": "int-secret" },
		});
		expect(both.status).toBe(200);
		expect(await both.json()).toEqual({ ok: true, expired: 0 });
	});

	test("/entitlements/grant with both secrets set needs Bearer AND X-Internal-Token", async () => {
		const { app } = makeApp({ serviceToken: TOKEN, internalToken: "int-secret" });
		const onlyInternal = await app.request("/entitlements/grant", {
			method: "POST",
			headers: { ...json, "X-Internal-Token": "int-secret" },
			body: "{}",
		});
		expect(onlyInternal.status).toBe(401); // blocked at the Bearer gate
		const onlyBearer = await app.request("/entitlements/grant", {
			method: "POST",
			headers: { ...json, ...bearer },
			body: "{}",
		});
		expect(onlyBearer.status).toBe(401); // passes the gate, 401s at the internal check
		// Both headers clear BOTH auth layers: the route's next check is the x402
		// gateway (unwired in this stub app → 503), proving auth was passed.
		const both = await app.request("/entitlements/grant", {
			method: "POST",
			headers: { ...json, ...bearer, "X-Internal-Token": "int-secret" },
			body: "{}",
		});
		expect(both.status).toBe(503);
		expect(await both.json()).toEqual({ ok: false, error: "x402 not configured" });
	});
});

describe("SERVICE_API_TOKEN unset (regression pin: exactly today's behavior)", () => {
	test("writes need no Authorization header", async () => {
		const { app, inventory } = makeApp();
		inventory.seed("SKU-2", 4);

		const created = await app.request("/carts", { method: "POST", headers: json, body: "{}" });
		expect(created.status).toBe(201);

		const reserve = await app.request("/inventory/reserve", {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "r1" },
			body: JSON.stringify({ sku: "SKU-2", qty: 1 }),
		});
		expect(reserve.status).toBe(200);

		const batch = await app.request("/catalog/commerce/batch", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ productIds: ["p1"] }),
		});
		expect(batch.status).toBe(200);
	});

	test("/internal/expire-holds keeps its own gate: 503 disabled, 401 mismatch", async () => {
		const disabled = makeApp();
		expect((await disabled.app.request("/internal/expire-holds", { method: "POST" })).status).toBe(
			503,
		);

		const enabled = makeApp({ internalToken: "int-secret" });
		expect(
			(
				await enabled.app.request("/internal/expire-holds", {
					method: "POST",
					headers: { "X-Internal-Token": "wrong" },
				})
			).status,
		).toBe(401);
	});
});
