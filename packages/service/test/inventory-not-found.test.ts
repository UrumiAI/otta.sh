import { type InventoryStore, ReservationNotFoundError } from "@urumi/domain";
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
} from "@urumi/domain/testing";
import { StripePaymentGateway } from "@urumi/payments-stripe";
import type { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// PR B (typed 404 for unknown reservation): IO-free HTTP tests over
// `app.request()` — no server, no PG — proving the route mapping introduced
// alongside `ReservationNotFoundError` (see the domain port contract tests in
// `packages/domain/src/testing/inventory-store-contract.ts` for the store-level
// behavior, run against all three harnesses).
interface TestApp {
	app: Hono;
	inventory: InMemoryInventoryStore;
}

/** A mutable box so the vanished id can be set AFTER the store (and app) are
 *  constructed — the reservation only exists once a real `reserve()` runs. */
interface VanishedIdBox {
	id: string | undefined;
}

/** Wraps a real InMemoryInventoryStore, forcing `adjust` to throw
 *  `ReservationNotFoundError` for one chosen reservation id while every other
 *  call (including `reservationState`, used by the cart store's live fence
 *  read) passes through untouched. Models the KNOWN ASYMMETRY the port
 *  docblock documents: `adjust` shares `commit`/`release`'s choke point and
 *  throws the same typed error on a vanished reservation, but nothing at the
 *  HTTP boundary maps it — so the cart PATCH still 500s. */
function withVanishingAdjust(inner: InMemoryInventoryStore, box: VanishedIdBox): InventoryStore {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			if (prop === "adjust") {
				return async (reservationId: string, newQty: number, key: unknown) => {
					if (reservationId === box.id) {
						throw new ReservationNotFoundError(reservationId);
					}
					return (target as unknown as InventoryStore).adjust(
						reservationId,
						newQty,
						key as Parameters<InventoryStore["adjust"]>[2],
					);
				};
			}
			const value = Reflect.get(target, prop, receiver) as unknown;
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	}) as unknown as InventoryStore;
}

function makeApp(store: InventoryStore, inventory: InMemoryInventoryStore): TestApp {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
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
		store,
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

function newInventory(): InMemoryInventoryStore {
	return new InMemoryInventoryStore({
		idGen: new CountingIdGen("res"),
		clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
	});
}

const json = { "content-type": "application/json" };

describe("POST /inventory/commit and /release: unknown reservationId", () => {
	test("commit of an unknown reservationId is 404 RESERVATION_NOT_FOUND", async () => {
		const inventory = newInventory();
		const { app } = makeApp(inventory, inventory);
		const res = await app.request("/inventory/commit", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ reservationId: "no-such-reservation" }),
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ ok: false, reason: "RESERVATION_NOT_FOUND" });
	});

	test("release of an unknown reservationId is 404 RESERVATION_NOT_FOUND", async () => {
		const inventory = newInventory();
		const { app } = makeApp(inventory, inventory);
		const res = await app.request("/inventory/release", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ reservationId: "no-such-reservation" }),
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ ok: false, reason: "RESERVATION_NOT_FOUND" });
	});

	test("anomaly path unchanged: commit of a released reservation still 500s internal_error", async () => {
		const inventory = newInventory();
		const { app } = makeApp(inventory, inventory);
		await inventory.seedOnHand("SKU-1", 5);
		const reserveRes = await app.request("/inventory/reserve", {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "k1" },
			body: JSON.stringify({ sku: "SKU-1", qty: 1 }),
		});
		const reserved = (await reserveRes.json()) as { ok: true; reservationId: string };
		expect(reserved.ok).toBe(true);

		const releaseRes = await app.request("/inventory/release", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ reservationId: reserved.reservationId }),
		});
		expect(releaseRes.status).toBe(200);

		const commitRes = await app.request("/inventory/commit", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ reservationId: reserved.reservationId }),
		});
		expect(commitRes.status).toBe(500);
		expect(await commitRes.json()).toEqual({ ok: false, error: "internal_error" });
	});

	test("happy path regression: reserve -> commit is 200; reserve -> release is 200 and returns stock", async () => {
		const inventory = newInventory();
		const { app } = makeApp(inventory, inventory);
		await inventory.seedOnHand("SKU-1", 5);

		const a = await app.request("/inventory/reserve", {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "ka" },
			body: JSON.stringify({ sku: "SKU-1", qty: 2 }),
		});
		const aBody = (await a.json()) as { ok: true; reservationId: string };
		expect(aBody.ok).toBe(true);
		const commitRes = await app.request("/inventory/commit", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ reservationId: aBody.reservationId }),
		});
		expect(commitRes.status).toBe(200);
		expect(await commitRes.json()).toEqual({ ok: true });

		const b = await app.request("/inventory/reserve", {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "kb" },
			body: JSON.stringify({ sku: "SKU-1", qty: 1 }),
		});
		const bBody = (await b.json()) as { ok: true; reservationId: string };
		expect(bBody.ok).toBe(true);
		expect(await inventory.onHand("SKU-1")).toBe(2);
		const releaseRes = await app.request("/inventory/release", {
			method: "POST",
			headers: json,
			body: JSON.stringify({ reservationId: bBody.reservationId }),
		});
		expect(releaseRes.status).toBe(200);
		expect(await releaseRes.json()).toEqual({ ok: true });
		expect(await inventory.onHand("SKU-1")).toBe(3);
	});
});

describe("known asymmetry (out of scope): cart PATCH against a vanished reservation still 500s", () => {
	test("PATCH /carts/:cartId/lines/:lineId whose reservation vanished is 500 internal_error, not 404", async () => {
		const inventory = newInventory();
		await inventory.seedOnHand("SKU-1", 5);

		const box: VanishedIdBox = { id: undefined };
		const store = withVanishingAdjust(inventory, box);
		const { app } = makeApp(store, inventory);

		const cartRes = await app.request("/carts", { method: "POST", headers: json, body: "{}" });
		const { cartId } = (await cartRes.json()) as { cartId: string };
		const lineRes = await app.request(`/carts/${cartId}/lines`, {
			method: "POST",
			headers: { ...json, "Idempotency-Key": "add1" },
			body: JSON.stringify({ sku: "SKU-1", qty: 1 }),
		});
		const lineBody = (await lineRes.json()) as {
			ok: true;
			line: { lineId: string; reservationId: string };
		};
		expect(lineBody.ok).toBe(true);
		box.id = lineBody.line.reservationId;

		const patchRes = await app.request(`/carts/${cartId}/lines/${lineBody.line.lineId}`, {
			method: "PATCH",
			headers: { ...json, "Idempotency-Key": "patch1" },
			body: JSON.stringify({ qty: 2 }),
		});
		expect(patchRes.status).toBe(500);
		expect(await patchRes.json()).toEqual({ ok: false, error: "internal_error" });
	});
});
