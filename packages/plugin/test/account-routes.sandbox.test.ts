/**
 * Step 5.9: the storefront account pages under the workerd-on-Node sandbox (not
 * trusted in-process — CLAUDE.md).
 *
 * WHAT INC-D3a CHANGED HERE. These routes used to reach a REAL service's
 * `/auth` + `/me` surface over `ctx.http`, and this suite stood that service up
 * on Postgres to answer them. The transport is gone — the routes run the
 * identity use-cases in process over `ctx.storage` — so there is no service to
 * start, no `commerceServiceBaseUrl` to hand the sandbox, and no Postgres in
 * this file at all. The document store IS the backend now, and the suite seeds
 * it through the same `@otta-sh/store-emdash` adapters the plugin composes.
 *
 * THE SUITE IS NO LONGER GATED, and that is deliberate rather than incidental:
 * a `PG_CONNECTION_STRING` gate is what let this file rot silently through a
 * whole retrofit, because a skipped suite is green.
 *
 * WHAT IS STILL DRIVEN THROUGH THE SANDBOX, unchanged: the login is redeemed by
 * the PLUGIN's own `storefront/account/login/verify` route, so the session every
 * case below carries was minted by the path a shopper actually takes. Only the
 * challenge is issued host-side — this transport dispatches no mail yet (see
 * `commerce-client-contract.in-process.test.ts`), so there is no message to
 * capture and the verifier is the only place a shopper's token can come from.
 *
 * EGRESS IS ASSERTED BY CONSTRUCTION: the boot declares NO allowed hosts, so any
 * `ctx.http` call from these routes throws. An account page that renders here
 * reached the network for nothing.
 *
 * ── Platform-verified deviation from plan §4's session-cookie wording ──────
 * The bearer session token is threaded as route input (the theme's first-party
 * cookie layer, per the deviation documented in `account-routes.ts`).
 */
import {
	cents,
	currency,
	email as toEmail,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashCredentialVerifier,
	EmdashCustomerStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OTTA_PLUGIN_CAPABILITIES } from "../src/manifest.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/** A namespace no other suite writes under — the document store is
 *  process-scoped and shared by every sandbox suite in this process. */
const NS = "acct";

let sandbox: SandboxHandle;
let storage: StorageAccess;
let orderStore: EmdashOrderStore;
let credentialVerifier: EmdashCredentialVerifier;

beforeAll(async () => {
	({ storage } = await storageBridge());
	const customerStore = new EmdashCustomerStore({ storage, idGen: uuidIdGen, clock: systemClock });
	// The verifier shares that ONE customer store, mirroring
	// `createInProcessCommerceStores`'s own wiring — a challenge resolves to the
	// same customer the isolate's login route will.
	credentialVerifier = new EmdashCredentialVerifier({
		storage,
		customerStore,
		idGen: uuidIdGen,
		clock: systemClock,
	});
	orderStore = new EmdashOrderStore({
		storage,
		inventory: new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock }),
		idGen: uuidIdGen,
		clock: systemClock,
	});
	// NO allowed hosts — see the module doc's egress note.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
});

/**
 * One GUEST order under `buyerRef=email`: it names an email and no customer,
 * which is the state every order is in until its buyer proves that inbox.
 * Logging in as the same address is what claims it, and that is the path the
 * ownership case below takes.
 */
async function createGuestOrder(input: { email: string; slug: string }): Promise<string> {
	const id = `order-${NS}-${input.slug}`;
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: input.email,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${NS}-${input.slug}`),
				sku: toSku(`SKU-${NS}-${input.slug.toUpperCase()}`),
				title: "Item",
				unitPrice: cents(1500),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: currency("USD") },
	});
	return id;
}

/** Drive the magic-link login THROUGH the plugin sandbox: issue the challenge on
 *  the verifier (nothing emails it yet), then redeem it via the plugin route,
 *  which returns the session-cookie descriptor. Returns the bearer token. */
async function loginThroughSandbox(email: string): Promise<string> {
	const issued = await credentialVerifier.issueChallenge(toEmail(email));
	if (!issued.ok) throw new Error(`login: challenge not issued (${issued.reason})`);
	const verify = await sandbox.invokeRoute("storefront/account/login/verify", {
		challengeId: issued.challengeId,
		token: issued.token,
	});
	expect("result" in verify).toBe(true);
	const result = (verify as { result: { ok: boolean; cookie?: { name: string; value: string } } })
		.result;
	expect(result.ok).toBe(true);
	expect(result.cookie?.name).toBe("otta_session");
	return result.cookie!.value;
}

describe("storefront account pages (workerd sandbox)", () => {
	test("a logged-in customer sees only their own orders on /account/orders", async () => {
		const orderA = await createGuestOrder({ email: `${NS}-a@example.test`, slug: "a" });
		const orderB = await createGuestOrder({ email: `${NS}-b@example.test`, slug: "b" });

		const tokenA = await loginThroughSandbox(`${NS}-a@example.test`);
		await loginThroughSandbox(`${NS}-b@example.test`); // claims B's order

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
		const noToken = await sandbox.invokeRoute("storefront/account/orders", {});
		expect(noToken).toEqual({ result: { ok: false, redirectTo: "/account/login" } });

		// A bogus/expired session token resolves to no customer → same redirect.
		const badToken = await sandbox.invokeRoute("storefront/account/orders", {
			sessionToken: "not-a-real-session",
		});
		expect(badToken).toEqual({ result: { ok: false, redirectTo: "/account/login" } });
	});

	test("the account pages add no new capability beyond network:request/allowedHosts", () => {
		// The §6 ADR's "service sends email directly" holds in practice: the plugin
		// declares no email:send — exactly the two capabilities. (`ctx.storage` needs
		// none: the host builds it ungated, ADR-0018.)
		expect([...OTTA_PLUGIN_CAPABILITIES]).toEqual(["content:read", "network:request"]);
	});
});
