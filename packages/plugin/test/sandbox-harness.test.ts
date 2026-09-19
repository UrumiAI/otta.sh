import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterEach, describe, expect, test } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import type { CommerceSweepSummary, SweepLegOutcome } from "../src/cron/index.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;

afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

const EMAIL_PATH = "/email/send";
const EMAIL_FROM = "orders@harness.example";

/** Places a paid order directly against the same storage the isolate's
 *  `ctx.storage` bridges to — the state the `order-emails` cron leg drains
 *  into a real `ctx.http` POST. Trimmed to what one send needs; the full
 *  domain-level behavior of this leg belongs to `in-process-egress.sandbox.test.ts`,
 *  not here. */
async function placePaidOrder(storage: StorageAccess, suffix: string): Promise<void> {
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	const orderStore = new EmdashOrderStore({
		storage,
		inventory,
		idGen: uuidIdGen,
		clock: systemClock,
	});
	const sku = `HARNESS-${suffix}`;
	const id = `order-harness-${suffix}`;
	await inventory.seedOnHand(toSku(sku), 10);
	const held = await inventory.reserve(toSku(sku), 1, idempotencyKey(`res-harness-${suffix}`));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	const holdExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
	await inventory.stampHoldDeadline(held.reservationId, holdExpiresAt);
	await inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId(id),
		holdExpiresAt,
		now: new Date().toISOString(),
	});
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-harness-${suffix}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-harness-${suffix}`),
		holdExpiresAt,
		buyerRef: `buyer-harness-${suffix}@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-harness-${suffix}`),
				sku: toSku(sku),
				title: "Harness Widget",
				unitPrice: cents(1999),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(1999), total: cents(1999), currency: currency("USD") },
	});
	await orderStore.markPaid(toOrderId(id));
}

async function tick(handle: SandboxHandle): Promise<SweepLegOutcome> {
	const outcome = await handle.invokeHook("cron", {
		name: SWEEP_TASK_NAME,
		scheduledAt: new Date().toISOString(),
	});
	if ("error" in outcome) throw new Error(outcome.error);
	const summary = outcome.result as CommerceSweepSummary;
	const found = summary.legs.find((entry) => entry.leg === "order-emails");
	if (found === undefined) throw new Error("no order-emails leg in the summary");
	return found;
}

describe("workerd-on-Node sandbox harness (plan §6 step 1)", () => {
	test("loads @otta-sh/plugin under workerd-on-Node and executes a real route against real storage", async () => {
		// Commerce is folded into the plugin now (INC-D3a): the entitlement check
		// is an in-process storage read, not a request over ctx.http, so this proof
		// no longer needs a stub — only a real document store (`storage: true`) and
		// a real workerd process to run it in.
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const outcome = await sandbox.invokeRoute("entitlements/download", {
			orderId: "o1",
			sku: "SKU-1",
		});
		expect(outcome).toMatchObject({ result: { authorized: false } });
	});

	test("ctx.http.fetch reaches a real granted host, and is rejected for a host NOT in allowedHosts", async () => {
		// The commerce-service stub is gone along with the deployment it used to
		// stand in for; the email adapter is now the simplest REAL egress this
		// isolate still makes (INC-C5), driven by one cron tick over one paid
		// order. This is the harness's own foundational proof that the ctx.http
		// bridge it hands every other sandbox suite actually works and is gated —
		// the exhaustive granted/refused matrix for both surviving egress
		// adapters lives in `in-process-egress.sandbox.test.ts`, not here.
		const { storage } = await storageBridge();

		stub = await startStubCommerceServer();
		stub.respondWith("POST", () => ({ status: 202, body: { queued: true } }));

		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			storage: true,
			emailApiUrl: `${stub.baseUrl}${EMAIL_PATH}`,
		});
		const configured = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { emailFrom: EMAIL_FROM },
		});
		if ("error" in configured) throw new Error(configured.error);

		await placePaidOrder(storage, "granted");
		const granted = await tick(sandbox);
		expect(granted.skipped).toBeUndefined();
		expect(granted.count).toBeGreaterThanOrEqual(1);
		expect(stub.requests.some((r) => r.method === "POST" && r.url === EMAIL_PATH)).toBe(true);

		await sandbox.close();
		stub.requests.length = 0;

		// SAME baked URL, host NOT granted this time — ctx.http.fetch must reject
		// before any byte reaches the stub.
		sandbox = await loadPluginInSandbox({
			allowedHosts: ["definitely-not-the-stub.example"],
			storage: true,
			emailApiUrl: `${stub.baseUrl}${EMAIL_PATH}`,
		});
		const reconfigured = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { emailFrom: EMAIL_FROM },
		});
		if ("error" in reconfigured) throw new Error(reconfigured.error);

		await placePaidOrder(storage, "refused");
		const refused = await tick(sandbox);
		// A sender WAS built (the URL is baked) — the send itself is what ctx.http
		// refuses, so the dispatcher's per-row catch leaves the row unsent rather
		// than throwing the whole tick.
		expect(refused.skipped).toBeUndefined();
		expect(refused.count).toBe(0);
		expect(stub.requests).toHaveLength(0);
	}, 180_000);

	test("the plugin registers NO Stripe webhook route — Stripe posts direct-to-service (review G1)", async () => {
		// EmDash's handleSandboxedRoute parses the request body as JSON
		// (`await request.json()`, em-dash packages/core/src/emdash-runtime.ts) —
		// the raw bytes a Stripe HMAC needs are destroyed before any plugin route
		// runs, and the route's return value is wrapped `{success, data}` at
		// HTTP 200, so a proxy could never surface Stripe's retry-driving status
		// codes either. A byte-exact proxy is structurally impossible on the real
		// host contract; the webhook endpoint is `webhooks/stripe/settle`, verified
		// inside the isolate (see `stripe-settle-route.sandbox.test.ts`).
		sandbox = await loadPluginInSandbox({ allowedHosts: [] });

		const outcome = await sandbox.invokeRoute("webhooks/stripe", { bodyBase64: "e30=" });
		expect(outcome).toEqual({ error: "unknown route: webhooks/stripe" });
	});

	test("an unknown hook/route name resolves to a 404-shaped result, not a crash", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [] });

		const hookOutcome = await sandbox.invokeHook("content:doesNotExist", {});
		expect(hookOutcome).toEqual({ error: "unknown hook: content:doesNotExist" });

		const routeOutcome = await sandbox.invokeRoute("does-not-exist", {});
		expect(routeOutcome).toEqual({ error: "unknown route: does-not-exist" });
	});
});
