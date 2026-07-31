import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
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
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// PR D / ADR-0010 §2: `GET /orders/:orderId` is an unauthenticated,
// capability-URL-only read (guess/leak the order UUID ⇒ a read). Unauthenticated
// callers must get the redacted, guest-confirmation shape; a valid
// X-Internal-Token unlocks the full admin-equivalent view. IO-free, in-memory
// stores, `app.request()` — mirrors `test/service-token.test.ts`'s `makeApp`.

const INTERNAL_TOKEN = "internal-secret";
const CLOCK_START = new Date("2026-07-10T00:00:00.000Z");

interface TestApp {
	app: Hono;
	emailSender: FakeEmailSender;
	inventory: InMemoryInventoryStore;
	productCommerce: InMemoryProductCommerceStore;
}

function makeApp(
	options: { internalToken?: string | undefined } = { internalToken: INTERNAL_TOKEN },
): TestApp {
	const clock = new FixedClock(CLOCK_START);
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
	const emailSender = new FakeEmailSender();
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
		emailSender,
		idGen,
		gateways: { stripe: new StripePaymentGateway({ webhookSecret: "whsec_gate_test", clock }) },
		clock,
		internalToken: options.internalToken,
	});
	return { app, emailSender, inventory, productCommerce };
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

const jsonHeaders = { "content-type": "application/json" };

/** Seed one physical product with stock (directly on the stores, mirroring
 *  `helpers/start-test-server.ts`'s `seedProduct`), checkout a one-line cart for
 *  it, and return the created order id + its full (internal-view) body. */
async function checkoutOneLine(
	testApp: TestApp,
	opts: { sku?: string; productId?: string; buyerRef?: string } = {},
): Promise<{ orderId: string; order: Record<string, unknown> }> {
	const { app, inventory, productCommerce } = testApp;
	const sku = opts.sku ?? "SKU-A";
	const productId = opts.productId ?? "pa";
	const buyerRef = opts.buyerRef ?? "buyer@example.com";
	await productCommerce.upsert(
		{
			productId: toProductId(productId),
			sku: toSku(sku),
			price: money(cents(1200), toCurrency("USD")),
			title: "Widget A",
			productKind: "physical",
		},
		idempotencyKey(`seed-${productId}`),
	);
	await inventory.seedOnHand(sku, 5);
	const cartRes = await app.request("/carts", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify({ currency: "USD" }),
	});
	const cart = await json(cartRes);
	const cartId = cart["cartId"] as string;
	const addRes = await app.request(`/carts/${cartId}/lines`, {
		method: "POST",
		headers: { ...jsonHeaders, "Idempotency-Key": `add-${cartId}` },
		body: JSON.stringify({ sku, qty: 1, productId }),
	});
	expect(addRes.status).toBe(200);
	const coRes = await app.request("/checkout/orders", {
		method: "POST",
		headers: { ...jsonHeaders, "Idempotency-Key": `co-${cartId}` },
		body: JSON.stringify({
			cartId,
			paymentMethod: "stripe",
			buyerRef,
			shippingAddress: {
				name: "Ada Lovelace",
				line1: "12 Analytical Way",
				city: "London",
				postalCode: "EC1A 1BB",
				country: "GB",
				email: buyerRef,
			},
		}),
	});
	expect(coRes.status).toBe(201);
	const body = await json(coRes);
	const order = body["order"] as Record<string, unknown>;
	return { orderId: order["id"] as string, order };
}

async function getOrder(
	app: Hono,
	orderId: string,
	opts: { token?: string } = {},
): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = {};
	if (opts.token !== undefined) headers["X-Internal-Token"] = opts.token;
	const res = await app.request(`/orders/${orderId}`, { headers });
	expect(res.status).toBe(200);
	const body = await json(res);
	return body["order"] as Record<string, unknown>;
}

describe("public GET /orders/:orderId redaction (PR D / ADR-0010 §2)", () => {
	let testApp: TestApp;
	let app: Hono;
	let emailSender: FakeEmailSender;

	beforeEach(() => {
		testApp = makeApp();
		({ app, emailSender } = testApp);
	});

	test("omits buyerRef/customerId/shippingAddress/reconciliation* keys entirely (not null)", async () => {
		const { orderId } = await checkoutOneLine(testApp);
		const publicOrder = await getOrder(app, orderId);
		expect(publicOrder).not.toHaveProperty("buyerRef");
		expect(publicOrder).not.toHaveProperty("customerId");
		expect(publicOrder).not.toHaveProperty("shippingAddress");
		expect(publicOrder).not.toHaveProperty("reconciliationFlag");
		expect(publicOrder).not.toHaveProperty("reconciliationResolution");
	});

	test("keeps id/state/currency/paymentMethod/holdExpiresAt/createdAt/totals/lines", async () => {
		const { orderId, order: fullOrder } = await checkoutOneLine(testApp);
		const publicOrder = await getOrder(app, orderId);
		expect(publicOrder["id"]).toBe(fullOrder["id"]);
		expect(publicOrder["state"]).toBe(fullOrder["state"]);
		expect(publicOrder["currency"]).toBe(fullOrder["currency"]);
		expect(publicOrder["paymentMethod"]).toBe(fullOrder["paymentMethod"]);
		expect(publicOrder["holdExpiresAt"]).toEqual(fullOrder["holdExpiresAt"]);
		expect(publicOrder["createdAt"]).toBe(fullOrder["createdAt"]);
		expect(publicOrder["totals"]).toEqual(fullOrder["totals"]);
		expect(publicOrder["lines"]).toEqual(fullOrder["lines"]);
	});

	test("trims fulfillment: carrier/trackingNumber/trackingUrl/shippedAt present, recordedBy/recordedAt absent", async () => {
		const { orderId } = await checkoutOneLine(testApp);
		await app.request(`/admin/orders/${orderId}/transition`, {
			method: "POST",
			headers: { ...jsonHeaders, "X-Internal-Token": INTERNAL_TOKEN },
			body: JSON.stringify({ toState: "paid" }),
		});
		await app.request(`/admin/orders/${orderId}/transition`, {
			method: "POST",
			headers: { ...jsonHeaders, "X-Internal-Token": INTERNAL_TOKEN },
			body: JSON.stringify({ toState: "processing" }),
		});
		const fulfillRes = await app.request(`/admin/orders/${orderId}/fulfillment`, {
			method: "POST",
			headers: { ...jsonHeaders, "X-Internal-Token": INTERNAL_TOKEN },
			body: JSON.stringify({
				carrier: "UPS",
				trackingNumber: "1Z999",
				trackingUrl: "https://ups.example/track/1Z999",
				shippedAt: "2026-07-11T00:00:00.000Z",
				recordedBy: "ops-alice",
			}),
		});
		expect(fulfillRes.status).toBe(200);
		const publicOrder = await getOrder(app, orderId);
		const fulfillment = publicOrder["fulfillment"] as Record<string, unknown>;
		expect(fulfillment).toMatchObject({
			carrier: "UPS",
			trackingNumber: "1Z999",
			trackingUrl: "https://ups.example/track/1Z999",
			shippedAt: "2026-07-11T00:00:00.000Z",
		});
		expect(fulfillment).not.toHaveProperty("recordedBy");
		expect(fulfillment).not.toHaveProperty("recordedAt");
	});

	test("trims cancellation: reason/cancelledAt present, detail/cancelledBy absent", async () => {
		const { orderId } = await checkoutOneLine(testApp);
		const cancelRes = await app.request(`/admin/orders/${orderId}/cancel`, {
			method: "POST",
			headers: { ...jsonHeaders, "X-Internal-Token": INTERNAL_TOKEN },
			body: JSON.stringify({
				reason: "customer_request",
				detail: "buyer called to cancel",
				cancelledBy: "ops-bob",
			}),
		});
		expect(cancelRes.status).toBe(200);
		const publicOrder = await getOrder(app, orderId);
		const cancellation = publicOrder["cancellation"] as Record<string, unknown>;
		expect(cancellation).toMatchObject({ reason: "customer_request" });
		expect(typeof cancellation["cancelledAt"]).toBe("string");
		expect(cancellation).not.toHaveProperty("detail");
		expect(cancellation).not.toHaveProperty("cancelledBy");
	});

	test("a valid X-Internal-Token returns the full serializeOrder view", async () => {
		const { orderId, order: fullOrder } = await checkoutOneLine(testApp);
		const authorized = await getOrder(app, orderId, { token: INTERNAL_TOKEN });
		expect(authorized).toEqual(fullOrder);
		expect(authorized).toHaveProperty("buyerRef");
		expect(authorized).toHaveProperty("shippingAddress");
	});

	test("a WRONG X-Internal-Token degrades to the redacted view, status 200 (never 401/503)", async () => {
		const { orderId } = await checkoutOneLine(testApp);
		const res = await app.request(`/orders/${orderId}`, {
			headers: { "X-Internal-Token": "not-the-token" },
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		const order = body["order"] as Record<string, unknown>;
		expect(order).not.toHaveProperty("buyerRef");
		expect(order).not.toHaveProperty("shippingAddress");
	});

	test("server internalToken UNSET degrades to the redacted view, status 200 (guest read must not break)", async () => {
		const unset = makeApp({ internalToken: undefined });
		const { orderId } = await checkoutOneLine(unset);
		// Even presenting a (necessarily wrong, since none is configured) token
		// must not throw or 401/503 — tokenMatches(header, "") would be a bug.
		const res = await unset.app.request(`/orders/${orderId}`, {
			headers: { "X-Internal-Token": "anything" },
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		const order = body["order"] as Record<string, unknown>;
		expect(order).not.toHaveProperty("buyerRef");
		expect(order).not.toHaveProperty("shippingAddress");
	});

	test("server internalToken is the EMPTY STRING: behaves as unset ⇒ redacted view, 200 (mirrors auth.ts:52)", async () => {
		const empty = makeApp({ internalToken: "" });
		const { orderId } = await checkoutOneLine(empty);
		const res = await empty.app.request(`/orders/${orderId}`, {
			headers: { "X-Internal-Token": "" },
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		const order = body["order"] as Record<string, unknown>;
		expect(order).not.toHaveProperty("buyerRef");
		expect(order).not.toHaveProperty("shippingAddress");
	});

	test("regressions stay full: GET /me/orders/:id (session), GET /admin/orders/:id (internal token), POST /checkout/orders response", async () => {
		const buyerRef = "regression@example.com";
		const { orderId, order: checkoutOrder } = await checkoutOneLine(testApp, {
			sku: "SKU-REG",
			productId: "preg",
			buyerRef,
		});
		// POST /checkout/orders response is already full — assert directly.
		expect(checkoutOrder).toHaveProperty("buyerRef");
		expect(checkoutOrder).toHaveProperty("shippingAddress");

		// GET /admin/orders/:id (internal token) stays full.
		const adminRes = await app.request(`/admin/orders/${orderId}`, {
			headers: { "X-Internal-Token": INTERNAL_TOKEN },
		});
		expect(adminRes.status).toBe(200);
		const adminBody = await json(adminRes);
		const adminOrder = adminBody["order"] as Record<string, unknown>;
		expect(adminOrder).toHaveProperty("buyerRef");
		expect(adminOrder).toHaveProperty("shippingAddress");

		// GET /me/orders/:id (session) stays full: log the buyer in (this links
		// the guest order, matched by buyerRef === email, to the new customer).
		const reqRes = await app.request("/auth/login/request", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ email: buyerRef }),
		});
		expect(reqRes.status).toBe(200);
		const send = emailSender.sends.find((s) => s.template === "customer-login-link");
		expect(send).toBeDefined();
		const { challengeId, token } = send!.data as { challengeId: string; token: string };
		const verifyRes = await app.request("/auth/login/verify", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ challengeId, token }),
		});
		expect(verifyRes.status).toBe(200);
		const { sessionToken } = await json(verifyRes);
		const meRes = await app.request(`/me/orders/${orderId}`, {
			headers: { Authorization: `Bearer ${sessionToken as string}` },
		});
		expect(meRes.status).toBe(200);
		const meBody = await json(meRes);
		const meOrder = meBody["order"] as Record<string, unknown>;
		expect(meOrder).toHaveProperty("buyerRef");
		expect(meOrder).toHaveProperty("shippingAddress");
	});
});
