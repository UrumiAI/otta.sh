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
	InMemoryOrderNotesStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	InMemoryProductCommerceStore,
	InMemoryReportingStore,
	InMemorySessionStore,
	InMemorySettingsStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
} from "@otta-sh/domain/testing";
import { StripePaymentGateway } from "@otta-sh/payments-stripe";
import type { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// Issue #33 (ADR-0011): GET /entitlements/check auth-precedence branches that
// need NO entitlement row to exercise — the reviewer flagged that the pg
// contract suite's cases 1, 2, 9, 10, 11, 14 (`entitlements-check-auth.http.
// contract.pg.test.ts`) never actually depend on a paid order or a granted
// entitlement: each returns 400/401/503 from auth/schema checks BEFORE the
// route ever reaches `entitlementStore.check`. Duplicated here at the
// `app.request()` level (IO-free in-memory stores, no server, no PG — same
// harness as `service-token.test.ts`) so plain `pnpm test` exercises this
// precedence logic without the Postgres gate. The PG suite remains the
// source of truth for the full 17-case matrix, including the entitled cases.

function makeApp(options: { internalToken?: string } = {}): { app: Hono } {
	const clock = new FixedClock(new Date("2026-07-14T00:00:00.000Z"));
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
		// NOTE: `InMemoryInventoryStore.onHand` returns 0 for an unseeded sku, so
		// this wiring COLLAPSES null -> 0. Fine for the coarse `inStock` boolean
		// these suites exercise; do NOT assert the products-list `onHand`
		// projection through it (the list must distinguish "no inventory row"
		// from "out of stock" — see the divergence note in
		// `packages/domain/src/ports/inventory-store.ts`'s `getOnHand` doc).
		inventoryOnHand: (s) => inventory.onHand(s),
	});
	const idGen = new CountingIdGen("id");
	const customerStore = new InMemoryCustomerStore({ idGen, clock });
	const app = createApp({
		store: inventory,
		productCommerce,
		cartStore,
		orderStore: new InMemoryOrderStore({ idGen, clock }),
		orderNotesStore: new InMemoryOrderNotesStore({ idGen, clock }),
		entitlementStore: new InMemoryEntitlementStore({ idGen, clock }),
		paymentEventStore: new InMemoryPaymentEventStore(),
		shippingRules: new InMemoryShippingRulesStore(),
		taxRules: new InMemoryTaxRulesStore(),
		couponStore: new InMemoryCouponStore({ idGen, clock }),
		reportingStore: new InMemoryReportingStore(),
		settingsStore: new InMemorySettingsStore(),
		customerStore,
		addressStore: new InMemoryAddressStore({ idGen, clock }),
		sessionStore: new InMemorySessionStore({ idGen, clock }),
		credentialVerifier: new InMemoryCredentialVerifier({ customerStore, idGen, clock }),
		emailSender: new FakeEmailSender(),
		idGen,
		gateways: { stripe: new StripePaymentGateway({ webhookSecret: "whsec_gate_test", clock }) },
		clock,
		internalToken: options.internalToken,
	});
	return { app };
}

function check(app: Hono, query: Record<string, string>, headers: Record<string, string> = {}) {
	const qs = new URLSearchParams(query).toString();
	return app.request(`/entitlements/check?${qs}`, { headers });
}

describe("GET /entitlements/check auth precedence — no-entitlement-row cases (no PG required)", () => {
	test("1. buyerRef scope, no credentials → 401 (oracle closed, no `active`)", async () => {
		const { app } = makeApp({ internalToken: "int-secret" });
		const res = await check(app, { buyerRef: "buyer@example.com", sku: "DIG-1" });
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toEqual({ ok: false, error: "unauthorized" });
		expect(body).not.toHaveProperty("active");
	});

	test("2. buyerRef scope, wrong X-Internal-Token → 401", async () => {
		const { app } = makeApp({ internalToken: "int-secret" });
		const res = await check(
			app,
			{ buyerRef: "buyer@example.com", sku: "DIG-1" },
			{ "X-Internal-Token": "not-the-token" },
		);
		expect(res.status).toBe(401);
	});

	test("4 (fingerprint, kept as-is). buyerRef scope on a server with internalToken DISABLED → 503 (never silently open)", async () => {
		const { app } = makeApp(); // internalToken unset
		const res = await check(app, { buyerRef: "buyer@example.com", sku: "DIG-1" });
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body).not.toHaveProperty("active");
	});

	test("9. sku-only + valid X-Internal-Token, no Bearer → 401 (the token gates buyerRef, it is not a scope)", async () => {
		const { app } = makeApp({ internalToken: "int-secret" });
		const res = await check(app, { sku: "DIG-1" }, { "X-Internal-Token": "int-secret" });
		expect(res.status).toBe(401);
	});

	test("10. sku missing → 400 (schema)", async () => {
		const { app } = makeApp({ internalToken: "int-secret" });
		const res = await check(
			app,
			{ buyerRef: "buyer@example.com" },
			{ "X-Internal-Token": "int-secret" },
		);
		expect(res.status).toBe(400);
	});

	test("11. no scope, no credentials → 401", async () => {
		const { app } = makeApp({ internalToken: "int-secret" });
		const res = await check(app, { sku: "DIG-1" });
		expect(res.status).toBe(401);
	});

	test("14. session scope: garbage bearer token → 401", async () => {
		const { app } = makeApp({ internalToken: "int-secret" });
		const res = await check(app, { sku: "DIG-1" }, { Authorization: "Bearer not-a-real-token" });
		expect(res.status).toBe(401);
	});
});
