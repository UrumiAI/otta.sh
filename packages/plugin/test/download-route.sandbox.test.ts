import { signStripeWebhook } from "@urumi/payments-stripe";
import { afterEach, describe, expect, test } from "vitest";
import {
	LIVE_STRIPE_WEBHOOK_SECRET,
	type LiveService,
	startLiveService,
} from "./helpers/start-live-service.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Step 4.9 (download leg): the entitlement-gated digital download under the
// workerd-on-Node sandbox. The plugin route authorizes delivery ONLY when the
// REAL service's entitlement check (reached via ctx.http + allowedHosts, the
// plugin's sole egress) returns an active row — the file is never served
// without one, and the plugin holds no secret (the webhook signing secret
// below is used exclusively test-side to pay the order through the service's
// own receiver; `SandboxOptions` has no secret field at all, so none can even
// be handed to the sandbox). Postgres-required (the live service).

const PG = process.env.PG_CONNECTION_STRING;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function setup(): Promise<{ live: LiveService; sandbox: SandboxHandle }> {
	const live = await startLiveService();
	cleanups.push(() => live.stop());
	const sandbox = await loadPluginInSandbox({
		allowedHosts: [live.host],
		commerceServiceBaseUrl: live.baseUrl,
	});
	cleanups.push(() => sandbox.close());
	return { live, sandbox };
}

const BUYER_REF = "buyer@example.com";

/** Seed a digital product (never reserves — §6) and check out a one-line
 *  order for it, paid via `paymentMethod: "stripe"`. */
async function createDigitalOrder(
	live: LiveService,
): Promise<{ orderId: string; totalCents: number }> {
	await fetch(`${live.baseUrl}/products/pdig/commerce`, {
		method: "PUT",
		headers: { "content-type": "application/json", "Idempotency-Key": "seed-pdig" },
		body: JSON.stringify({
			sku: "DIG-1",
			price: { amount: 900, currency: "USD" },
			title: "Digital Widget",
			productKind: "digital",
		}),
	});
	const cart = (await (
		await fetch(`${live.baseUrl}/carts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ currency: "USD" }),
		})
	).json()) as { cartId: string };
	await fetch(`${live.baseUrl}/carts/${cart.cartId}/lines`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": "add-dig-1" },
		body: JSON.stringify({ sku: "DIG-1", qty: 1, productId: "pdig" }),
	});
	const co = (await (
		await fetch(`${live.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "co-dig-1" },
			body: JSON.stringify({ cartId: cart.cartId, paymentMethod: "stripe", buyerRef: BUYER_REF }),
		})
	).json()) as { order: { id: string; totals: { totalCents: number } } };
	return { orderId: co.order.id, totalCents: co.order.totals.totalCents };
}

/** Settle the order through the service's own verified webhook receiver —
 *  on `paid` a digital line grants the entitlement (settle §5/§6). */
async function payOrder(live: LiveService, orderId: string, totalCents: number): Promise<void> {
	const signed = signStripeWebhook(
		{
			eventId: `evt_${orderId}`,
			type: "payment_intent.succeeded",
			paymentIntentId: `pi_${orderId}`,
			orderId,
			amountCents: totalCents,
			currency: "usd",
		},
		LIVE_STRIPE_WEBHOOK_SECRET,
	);
	const res = await fetch(`${live.baseUrl}/webhooks/stripe`, {
		method: "POST",
		headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
		body: signed.body,
	});
	expect(res.status).toBe(200);
}

/** Full magic-link login against the LIVE service → the bearer session token,
 *  exactly as the theme's first-party cookie layer would obtain it. */
async function loginSession(live: LiveService, email: string): Promise<string> {
	const reqRes = await fetch(`${live.baseUrl}/auth/login/request`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email }),
	});
	expect(reqRes.status).toBe(200);
	const sends = live.emailSender.sends.filter((s) => s.template === "customer-login-link");
	const last = sends[sends.length - 1]!;
	const verifyRes = await fetch(`${live.baseUrl}/auth/login/verify`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			challengeId: last.data["challengeId"],
			token: last.data["token"],
		}),
	});
	expect(verifyRes.status).toBe(200);
	return ((await verifyRes.json()) as { sessionToken: string }).sessionToken;
}

describe.skipIf(PG === undefined)("entitlement-gated download (workerd sandbox)", () => {
	test("a paid digital order's download is authorized — by orderId scope and by session scope", async () => {
		const { live, sandbox } = await setup();
		const { orderId, totalCents } = await createDigitalOrder(live);
		await payOrder(live, orderId, totalCents);

		const byOrder = await sandbox.invokeRoute("entitlements/download", { orderId, sku: "DIG-1" });
		expect(byOrder).toEqual({ result: { authorized: true, sku: "DIG-1" } });

		// Issue #33 / ADR-0008: a logged-in customer authorizes via their SESSION
		// (the service derives the email server-side) — the plugin never forwards
		// a raw email. `BUYER_REF` is the checkout email, and the session for it
		// hits the same entitlement row.
		const sessionToken = await loginSession(live, BUYER_REF);
		const bySession = await sandbox.invokeRoute("entitlements/download", {
			sessionToken,
			sku: "DIG-1",
		});
		expect(bySession).toEqual({ result: { authorized: true, sku: "DIG-1" } });
	});

	test("route input with a raw buyerRef is ignored — no orderId/session scope ⇒ INVALID_INPUT (the plugin never forwards emails)", async () => {
		const { live, sandbox } = await setup();
		const { orderId, totalCents } = await createDigitalOrder(live);
		await payOrder(live, orderId, totalCents);

		const byBuyer = await sandbox.invokeRoute("entitlements/download", {
			buyerRef: BUYER_REF,
			sku: "DIG-1",
		});
		expect(byBuyer).toEqual({ result: { authorized: false, reason: "INVALID_INPUT" } });
	});

	test("an invalid session (no orderId scope) is the typed UNAUTHENTICATED, not a throw", async () => {
		const { sandbox } = await setup();
		const bad = await sandbox.invokeRoute("entitlements/download", {
			sessionToken: "not-a-real-session-token",
			sku: "DIG-1",
		});
		expect(bad).toEqual({ result: { authorized: false, reason: "UNAUTHENTICATED" } });
	});

	test("an unpaid order (no entitlement row) is denied NOT_ENTITLED; a paid order's wrong sku is denied too", async () => {
		const { live, sandbox } = await setup();
		const { orderId } = await createDigitalOrder(live);
		// NOT paid — settle never ran, so no entitlement row exists.
		const unpaid = await sandbox.invokeRoute("entitlements/download", { orderId, sku: "DIG-1" });
		expect(unpaid).toEqual({ result: { authorized: false, reason: "NOT_ENTITLED" } });

		// And an entitlement never covers a sku it wasn't granted for.
		const wrongSku = await sandbox.invokeRoute("entitlements/download", {
			orderId,
			sku: "SOME-OTHER-SKU",
		});
		expect(wrongSku).toEqual({ result: { authorized: false, reason: "NOT_ENTITLED" } });
	});

	test("malformed input (no sku, or no orderId/session scope) is the typed INVALID_INPUT, not a throw", async () => {
		const { sandbox } = await setup();
		const noSku = await sandbox.invokeRoute("entitlements/download", { orderId: "o-1" });
		expect(noSku).toEqual({ result: { authorized: false, reason: "INVALID_INPUT" } });

		const noScope = await sandbox.invokeRoute("entitlements/download", { sku: "DIG-1" });
		expect(noScope).toEqual({ result: { authorized: false, reason: "INVALID_INPUT" } });
	});

	test("the route's only egress is the guarded ctx.http bridge: with the service host NOT in allowedHosts the check is blocked, nothing is authorized", async () => {
		const live = await startLiveService();
		cleanups.push(() => live.stop());
		const { orderId, totalCents } = await createDigitalOrder(live);
		await payOrder(live, orderId, totalCents);

		// Same live service, but the sandbox's allowlist excludes it. If the
		// route had ANY path to the network besides ctx.http+allowedHosts, this
		// entitled request could still verify and authorize; instead the bridge
		// rejects the fetch and the invocation surfaces an error — proving the
		// allowlist is the plugin's entire outbound surface (DEVELOPMENT.md §5).
		const sandbox = await loadPluginInSandbox({
			allowedHosts: ["definitely-not-the-service.example"],
			commerceServiceBaseUrl: live.baseUrl,
		});
		cleanups.push(() => sandbox.close());

		const outcome = await sandbox.invokeRoute("entitlements/download", { orderId, sku: "DIG-1" });
		expect("error" in outcome).toBe(true);
		if ("error" in outcome) {
			expect(outcome.error).toMatch(/not allowed to fetch/i);
		}
	});
});
