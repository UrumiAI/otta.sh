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
import { STRIPE_API_HOST } from "../src/manifest.js";
import { startStripeApiStub } from "./helpers/stripe-api-stub.js";

let sandbox: SandboxHandle | undefined;

afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
});

/** Places a paid order directly against the same storage the isolate's
 *  `ctx.storage` bridges to — the state the `order-emails` cron leg drains
 *  into `ctx.email`. Trimmed to what one send needs; the full
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
		// Email no longer goes over `ctx.http` (ADR-0031), so the simplest REAL
		// egress this isolate makes is Stripe's: saving the Stripe secret key reads
		// the account's country (`GET /v1/account`, issue #382). Stripe's host is
		// hard-coded, so the stub stands behind workerd's `globalOutbound`; the
		// plugin's own allowlist check still runs first, against `api.stripe.com`.
		// This is the harness's own foundational proof that the ctx.http bridge it
		// hands every other sandbox suite actually works and is gated.
		// The admin route builds its clients over `ctx.storage`, whose bridge the
		// stub must forward to (it is the host's side, not plugin egress).
		const bridge = await storageBridge();
		const stripe = await startStripeApiStub({ forwardTo: [bridge.baseUrl] });
		try {
			const key = ["sk_test_", "HarnessFixture0000000000"].join("");
			const save = (handle: SandboxHandle) =>
				handle.invokeRoute("admin", {
					type: "form_submit",
					action_id: "save-stripe-secret-key",
					values: { stripeSecretKey: key },
				});

			sandbox = await loadPluginInSandbox({
				allowedHosts: [STRIPE_API_HOST],
				storage: true,
				globalOutbound: stripe.address,
			});
			expect(await save(sandbox)).not.toHaveProperty("error");
			expect(stripe.requests.some((r) => r.method === "GET" && r.path === "/v1/account")).toBe(
				true,
			);
			await sandbox.close();
			stripe.reset();

			// SAME request, host NOT granted this time — ctx.http.fetch must reject
			// before any byte reaches the stub.
			sandbox = await loadPluginInSandbox({
				allowedHosts: ["definitely-not-the-stub.example"],
				storage: true,
				globalOutbound: stripe.address,
			});
			expect(await save(sandbox)).not.toHaveProperty("error");
			expect(stripe.requests).toHaveLength(0);
			expect(stripe.refused).toHaveLength(0);
		} finally {
			await stripe.close();
		}
	}, 180_000);

	test("ctx.email reaches the boot's EmDash email provider; without one the send is refused as unconfigured", async () => {
		// ADR-0031: the cron tick's order email goes to the host's `ctx.email`. With
		// `email: true` the harness records it; without, the host's sandbox bridge
		// says "Email is not configured" and the leg reports `skipped`.
		const { storage } = await storageBridge();

		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true, email: true });
		await placePaidOrder(storage, "granted");
		const granted = await tick(sandbox);
		expect(granted.skipped).toBeUndefined();
		expect(granted.count).toBeGreaterThanOrEqual(1);
		expect(sandbox.sentEmails().map((m) => m.to)).toContain("buyer-harness-granted@example.test");
		await sandbox.close();

		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		await placePaidOrder(storage, "refused");
		expect(await tick(sandbox)).toMatchObject({ count: 0, skipped: true });
		expect(sandbox.sentEmails()).toEqual([]);
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
