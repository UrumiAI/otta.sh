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
import { describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CART_LINE_MAX_QTY, RESERVE_MAX_QTY } from "../src/schemas.js";

// PR C — wire-level qty caps (service-hardening plan §4). Zod-only bounds on
// the three qty sites that previously accepted any positive safe integer
// (including 1e9): `addLineBody`/`patchLineBody` get a shopper-facing
// CART_LINE_MAX_QTY (10,000); `reserveBody` gets the same 1,000,000,000 cap as
// the admin `stockMovementBody` precedent (the raw inventory primitive, a
// machine caller). The cap is a wire bound only — an over-cap request never
// reaches the store, so no reservation row (successful or failed) is minted.
// This does NOT fix junk-row/request-count amplification (see the linked
// follow-up issue); it only closes the "qty: 1e9 is a valid wire request" gap.
interface TestApp {
	app: Hono;
	inventory: InMemoryInventoryStore;
}

function makeApp(): TestApp {
	const clock = new FixedClock(new Date("2026-07-26T00:00:00.000Z"));
	const inventory = new InMemoryInventoryStore({
		idGen: new CountingIdGen("res"),
		clock,
		seed: [{ sku: "SKU-1", onHand: 20_000 }],
	});
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
	});
	return { app, inventory };
}

const json = { "content-type": "application/json" };

async function newCart(app: Hono): Promise<string> {
	const res = await app.request("/carts", { method: "POST", headers: json, body: "{}" });
	expect(res.status).toBe(201);
	const body = (await res.json()) as { cartId: string };
	return body.cartId;
}

describe("PR C — cart line qty cap (CART_LINE_MAX_QTY)", () => {
	test("POST /carts/:id/lines over cap is 400 with a structured error body", async () => {
		const { app } = makeApp();
		const cartId = await newCart(app);

		const res = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k1" },
			body: JSON.stringify({ sku: "SKU-1", qty: CART_LINE_MAX_QTY + 1 }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; issues: unknown };
		expect(body.error).toBe("invalid request body");
		expect(body.issues).toBeDefined();
	});

	test("...and the store is never touched: reserve() not called, onHand unchanged", async () => {
		const { app, inventory } = makeApp();
		const cartId = await newCart(app);
		const reserveSpy = vi.spyOn(inventory, "reserve");
		const before = inventory.onHand("SKU-1");

		const res = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k1b" },
			body: JSON.stringify({ sku: "SKU-1", qty: CART_LINE_MAX_QTY + 1 }),
		});

		expect(res.status).toBe(400);
		expect(reserveSpy).not.toHaveBeenCalled();
		expect(inventory.onHand("SKU-1")).toBe(before);
	});

	test("POST /carts/:id/lines at the CART_LINE_MAX_QTY boundary succeeds (200)", async () => {
		const { app } = makeApp();
		const cartId = await newCart(app);

		const res = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k2" },
			body: JSON.stringify({ sku: "SKU-1", qty: CART_LINE_MAX_QTY }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	async function existingLineId(app: Hono, cartId: string, key: string): Promise<string> {
		const addRes = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, "Idempotency-Key": key },
			body: JSON.stringify({ sku: "SKU-1", qty: 1 }),
		});
		const addBody = (await addRes.json()) as { line: { lineId: string } };
		return addBody.line.lineId;
	}

	test("PATCH /carts/:id/lines/:lineId over cap is 400", async () => {
		const { app } = makeApp();
		const cartId = await newCart(app);
		const lineId = await existingLineId(app, cartId, "k3");

		const overCap = await app.request(`/carts/${cartId}/lines/${lineId}`, {
			method: "PATCH",
			headers: { ...json, "Idempotency-Key": "k4" },
			body: JSON.stringify({ qty: CART_LINE_MAX_QTY + 1 }),
		});
		expect(overCap.status).toBe(400);
	});

	test("PATCH /carts/:id/lines/:lineId at the cap is 200", async () => {
		const { app } = makeApp();
		const cartId = await newCart(app);
		const lineId = await existingLineId(app, cartId, "k3b");

		const atCap = await app.request(`/carts/${cartId}/lines/${lineId}`, {
			method: "PATCH",
			headers: { ...json, "Idempotency-Key": "k5" },
			body: JSON.stringify({ qty: CART_LINE_MAX_QTY }),
		});
		expect(atCap.status).toBe(200);
	});

	test("the exact QA repro — qty: 1e9 on a cart line — is now 400", async () => {
		const { app } = makeApp();
		const cartId = await newCart(app);

		const res = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k6" },
			body: JSON.stringify({ sku: "SKU-1", qty: 1e9 }),
		});

		expect(res.status).toBe(400);
	});
});

describe("PR C — POST /inventory/reserve qty cap (RESERVE_MAX_QTY, aligned with stockMovementBody)", () => {
	test("qty: 1_000_000_001 is 400, reserve never called", async () => {
		const { app, inventory } = makeApp();
		const reserveSpy = vi.spyOn(inventory, "reserve");

		const res = await app.request("/inventory/reserve", {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k7" },
			body: JSON.stringify({ sku: "SKU-1", qty: RESERVE_MAX_QTY + 1 }),
		});

		expect(res.status).toBe(400);
		expect(reserveSpy).not.toHaveBeenCalled();
	});

	test("qty: 1_000_000_000 reaches the store (200, OUT_OF_STOCK since it exceeds seeded on-hand)", async () => {
		const { app } = makeApp();

		const res = await app.request("/inventory/reserve", {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k8" },
			body: JSON.stringify({ sku: "SKU-1", qty: RESERVE_MAX_QTY }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; reason?: string };
		expect(body.ok).toBe(false);
		expect(body.reason).toBe("OUT_OF_STOCK");
	});
});
