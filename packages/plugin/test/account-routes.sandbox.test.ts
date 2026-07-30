import { afterEach, describe, expect, test } from "vitest";
import { OTTA_PLUGIN_CAPABILITIES } from "../src/manifest.js";
import { type LiveService, startLiveService } from "./helpers/start-live-service.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Step 5.9: the storefront account pages under the workerd-on-Node sandbox (not
// trusted in-process — CLAUDE.md). The plugin routes reach the REAL service's
// /auth + /me surface via ctx.http + allowedHosts (its sole egress); the bearer
// session token is threaded as route input (the theme's first-party cookie
// layer, per the platform-verified deviation in account-routes.ts).
// Postgres-required (the live service).

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

/** Seed + check out a one-line physical order under `buyerRef=email`. */
async function createGuestOrder(
	live: LiveService,
	input: { email: string; sku: string; productId: string },
): Promise<string> {
	await fetch(`${live.baseUrl}/products/${input.productId}/commerce`, {
		method: "PUT",
		headers: { "content-type": "application/json", "Idempotency-Key": `seed-${input.productId}` },
		body: JSON.stringify({
			sku: input.sku,
			price: { amount: 1500, currency: "USD" },
			title: "Item",
			productKind: "physical",
			initialOnHand: 5,
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
		headers: { "content-type": "application/json", "Idempotency-Key": `add-${cart.cartId}` },
		body: JSON.stringify({ sku: input.sku, qty: 1, productId: input.productId }),
	});
	const co = (await (
		await fetch(`${live.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": `co-${cart.cartId}` },
			body: JSON.stringify({ cartId: cart.cartId, paymentMethod: "stripe", buyerRef: input.email }),
		})
	).json()) as { order: { id: string } };
	return co.order.id;
}

/** Drive the magic-link login THROUGH the plugin sandbox: request the link on
 *  the service, read the emitted token, then verify via the plugin route (which
 *  returns the session-cookie descriptor). Returns the bearer session token. */
async function loginThroughSandbox(
	live: LiveService,
	sandbox: SandboxHandle,
	email: string,
): Promise<string> {
	await fetch(`${live.baseUrl}/auth/login/request`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email }),
	});
	const sends = live.emailSender.sends.filter((s) => s.template === "customer-login-link");
	const last = sends[sends.length - 1]!;
	const verify = await sandbox.invokeRoute("storefront/account/login/verify", {
		challengeId: last.data["challengeId"] as string,
		token: last.data["token"] as string,
	});
	expect("result" in verify).toBe(true);
	const result = (verify as { result: { ok: boolean; cookie?: { name: string; value: string } } })
		.result;
	expect(result.ok).toBe(true);
	expect(result.cookie?.name).toBe("otta_session");
	return result.cookie!.value;
}

describe.skipIf(PG === undefined)("storefront account pages (workerd sandbox)", () => {
	test("a logged-in customer sees only their own orders on /account/orders", async () => {
		const { live, sandbox } = await setup();
		const orderA = await createGuestOrder(live, {
			email: "a@example.com",
			sku: "SA",
			productId: "pa",
		});
		const orderB = await createGuestOrder(live, {
			email: "b@example.com",
			sku: "SB",
			productId: "pb",
		});

		const tokenA = await loginThroughSandbox(live, sandbox, "a@example.com");
		await loginThroughSandbox(live, sandbox, "b@example.com"); // links B's order

		const orders = await sandbox.invokeRoute("storefront/account/orders", { sessionToken: tokenA });
		expect("result" in orders).toBe(true);
		const body = (orders as { result: { ok: boolean; orders: Array<{ id: string }> } }).result;
		expect(body.ok).toBe(true);
		expect(body.orders.map((o) => o.id)).toEqual([orderA]);

		// B's order, by id, as A → NOT_FOUND (no existence leak), not the order.
		const foreign = await sandbox.invokeRoute("storefront/account/order", {
			sessionToken: tokenA,
			orderId: orderB,
		});
		expect(foreign).toEqual({ result: { ok: false, error: "NOT_FOUND" } });
	});

	test("an unauthenticated request to /account/orders redirects to /account/login", async () => {
		const { sandbox } = await setup();
		const noToken = await sandbox.invokeRoute("storefront/account/orders", {});
		expect(noToken).toEqual({ result: { ok: false, redirectTo: "/account/login" } });

		// A bogus/expired session token → the service answers 401 → same redirect.
		const badToken = await sandbox.invokeRoute("storefront/account/orders", {
			sessionToken: "not-a-real-session",
		});
		expect(badToken).toEqual({ result: { ok: false, redirectTo: "/account/login" } });
	});

	test("the account pages add no new capability beyond network:request/allowedHosts", () => {
		// The §6 ADR's "service sends email directly" holds in practice: the plugin
		// declares no email:send, no ctx.storage — exactly the two capabilities.
		expect([...OTTA_PLUGIN_CAPABILITIES]).toEqual(["content:read", "network:request"]);
	});
});
