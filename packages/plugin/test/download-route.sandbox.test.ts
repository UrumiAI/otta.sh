/**
 * Step 4.9 (download leg): the entitlement-gated digital download under the
 * workerd-on-Node sandbox. The route authorizes delivery ONLY when an active
 * entitlement exists — the file is never served without one.
 *
 * WHAT INC-D3a CHANGED HERE. The check used to be a request to a REAL service
 * over `ctx.http`, and this suite stood that service up on Postgres to answer
 * it. The transport is gone — the check is a read against the plugin's own
 * document store on `ctx.storage` — so there is no service to start, no
 * `commerceServiceBaseUrl` to hand the sandbox, and no Postgres in this file at
 * all. The fixtures are written through the same `@otta-sh/store-emdash`
 * adapters the plugin composes, and the grant mirrors, key for key, what
 * `settleOrder` writes on a paid digital line (`ent:{order}:{sku}`, source
 * `order_paid`) — the settle path itself is proven by its own sandbox suite, so
 * repeating it here would only make this suite about a different subject.
 *
 * THE SUITE IS NO LONGER GATED, and that is deliberate rather than incidental:
 * a `PG_CONNECTION_STRING` gate is what let this file rot silently through a
 * whole retrofit, because a skipped suite is green.
 *
 * EGRESS IS ASSERTED BY CONSTRUCTION, more strictly than the old "the allowlist
 * blocked the service host" case could: the boot declares NO allowed hosts at
 * all, so any `ctx.http` call from this route throws. Every authorization below
 * is therefore reached without touching the network. What replaces that case is
 * the one failure mode the collapse introduced and the one this route must never
 * get wrong — a boot with NO document store authorizes NOTHING (last case).
 *
 * The plugin holds no secret either way: `SandboxOptions` has no secret field at
 * all, so none can even be handed to the sandbox.
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
	EmdashEntitlementStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MISSING_STORAGE_MESSAGE } from "../src/commerce/in-process-commerce-stores.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/** A namespace no other suite writes under — the document store is
 *  process-scoped and shared by every sandbox suite in this process. */
const NS = "dl";
const SKU = `SKU-${NS}-DIG`;
const BUYER_REF = `${NS}-buyer@example.test`;

let sandbox: SandboxHandle;
let storage: StorageAccess;
let orderStore: EmdashOrderStore;
let entitlementStore: EmdashEntitlementStore;
let credentialVerifier: EmdashCredentialVerifier;

beforeAll(async () => {
	({ storage } = await storageBridge());
	const customerStore = new EmdashCustomerStore({ storage, idGen: uuidIdGen, clock: systemClock });
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
	entitlementStore = new EmdashEntitlementStore({ storage, idGen: uuidIdGen, clock: systemClock });
	// NO allowed hosts — see the module doc's egress note.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
});

/** A one-line digital order (never reserves — §6) under `BUYER_REF`, UNPAID:
 *  it carries no entitlement of its own until {@link payOrder} runs. */
async function createDigitalOrder(slug: string): Promise<string> {
	const id = `order-${NS}-${slug}`;
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: BUYER_REF,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${NS}-dig`),
				sku: toSku(SKU),
				title: "Digital Widget",
				unitPrice: cents(900),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(900), total: cents(900), currency: currency("USD") },
	});
	return id;
}

/**
 * Pay the order, exactly as `settleOrder` does on a verified `paid` webhook:
 * flip the order and grant the digital line's entitlement under the SAME
 * deterministic grant-once key (`ent:{order}:{sku}`), scoped to both the order
 * id and the buyer ref — which is what makes the two download scopes below hit
 * the one row.
 */
async function payOrder(orderId: string): Promise<void> {
	await orderStore.markPaid(toOrderId(orderId));
	await entitlementStore.grant({
		orderId: toOrderId(orderId),
		productId: toProductId(`prod-${NS}-dig`),
		sku: toSku(SKU),
		buyerRef: BUYER_REF,
		source: "order_paid",
		grantIdempotencyKey: idempotencyKey(`ent:${orderId}:${SKU}`),
	});
}

/** A real session for `email`, redeemed THROUGH the plugin's own login route —
 *  the bearer a theme's first-party cookie layer would hold. */
async function loginSession(email: string): Promise<string> {
	const issued = await credentialVerifier.issueChallenge(toEmail(email));
	if (!issued.ok) throw new Error(`login: challenge not issued (${issued.reason})`);
	const verify = await sandbox.invokeRoute("storefront/account/login/verify", {
		challengeId: issued.challengeId,
		token: issued.token,
	});
	const result = (verify as { result?: { ok: boolean; cookie?: { value: string } } }).result;
	if (result === undefined || !result.ok || result.cookie === undefined) {
		throw new Error(`login: verify failed (${JSON.stringify(verify)})`);
	}
	return result.cookie.value;
}

describe("entitlement-gated download (workerd sandbox)", () => {
	test("a paid digital order's download is authorized — by orderId scope and by session scope", async () => {
		const orderId = await createDigitalOrder("paid");
		await payOrder(orderId);

		const byOrder = await sandbox.invokeRoute("entitlements/download", { orderId, sku: SKU });
		expect(byOrder).toEqual({ result: { authorized: true, sku: SKU } });

		// Issue #33 / ADR-0011: a logged-in customer authorizes via their SESSION
		// (the email is derived from the session's customer server-side) — the
		// plugin never forwards a raw email. `BUYER_REF` is the checkout email, and
		// the session for it hits the same entitlement row.
		const sessionToken = await loginSession(BUYER_REF);
		const bySession = await sandbox.invokeRoute("entitlements/download", {
			sessionToken,
			sku: SKU,
		});
		expect(bySession).toEqual({ result: { authorized: true, sku: SKU } });
	});

	// Precedence-bug coverage (review): when the theme supplies BOTH `orderId`
	// and `sessionToken`, an unrelated/stale orderId must not shadow the
	// logged-in customer's OWN entitlement — the route retries session-scoped on
	// an inactive orderId result (see the comment in download-route.ts).
	test("both orderId AND sessionToken present: a stale/unrelated orderId does not shadow the session's own entitlement", async () => {
		const orderId = await createDigitalOrder("prec-paid");
		await payOrder(orderId);
		const sessionToken = await loginSession(BUYER_REF);

		// A second, unrelated order for the same buyer — NEVER paid, so it carries
		// no entitlement of its own. A theme bug (or a stale query param from
		// another tab) supplies this orderId alongside a perfectly valid session.
		const staleOrderId = await createDigitalOrder("prec-stale");

		const result = await sandbox.invokeRoute("entitlements/download", {
			orderId: staleOrderId,
			sessionToken,
			sku: SKU,
		});
		expect(result).toEqual({ result: { authorized: true, sku: SKU } });
	});

	test("both orderId AND sessionToken present: a valid orderId authorizes even with an unrelated stranger's session", async () => {
		const orderId = await createDigitalOrder("stranger-paid");
		await payOrder(orderId);
		const strangerSession = await loginSession(`${NS}-stranger@example.test`);

		const result = await sandbox.invokeRoute("entitlements/download", {
			orderId,
			sessionToken: strangerSession,
			sku: SKU,
		});
		expect(result).toEqual({ result: { authorized: true, sku: SKU } });
	});

	test("both orderId AND sessionToken present: neither scope entitled → NOT_ENTITLED, not UNAUTHENTICATED", async () => {
		const staleOrderId = await createDigitalOrder("neither"); // unpaid
		const strangerSession = await loginSession(`${NS}-stranger2@example.test`);

		const result = await sandbox.invokeRoute("entitlements/download", {
			orderId: staleOrderId,
			sessionToken: strangerSession,
			sku: SKU,
		});
		expect(result).toEqual({ result: { authorized: false, reason: "NOT_ENTITLED" } });
	});

	test("route input with a raw buyerRef is ignored — no orderId/session scope ⇒ INVALID_INPUT (the plugin never forwards emails)", async () => {
		const orderId = await createDigitalOrder("buyerref");
		await payOrder(orderId);

		const byBuyer = await sandbox.invokeRoute("entitlements/download", {
			buyerRef: BUYER_REF,
			sku: SKU,
		});
		expect(byBuyer).toEqual({ result: { authorized: false, reason: "INVALID_INPUT" } });
	});

	test("an invalid session (no orderId scope) is the typed UNAUTHENTICATED, not a throw", async () => {
		const bad = await sandbox.invokeRoute("entitlements/download", {
			sessionToken: "not-a-real-session-token",
			sku: SKU,
		});
		expect(bad).toEqual({ result: { authorized: false, reason: "UNAUTHENTICATED" } });
	});

	test("an unpaid order (no entitlement row) is denied NOT_ENTITLED; a paid order's wrong sku is denied too", async () => {
		const unpaidOrderId = await createDigitalOrder("unpaid");
		// NOT paid — settle never ran, so no entitlement row exists.
		const unpaid = await sandbox.invokeRoute("entitlements/download", {
			orderId: unpaidOrderId,
			sku: SKU,
		});
		expect(unpaid).toEqual({ result: { authorized: false, reason: "NOT_ENTITLED" } });

		// And an entitlement never covers a sku it wasn't granted for.
		const paidOrderId = await createDigitalOrder("wrong-sku");
		await payOrder(paidOrderId);
		const wrongSku = await sandbox.invokeRoute("entitlements/download", {
			orderId: paidOrderId,
			sku: `${SKU}-OTHER`,
		});
		expect(wrongSku).toEqual({ result: { authorized: false, reason: "NOT_ENTITLED" } });
	});

	test("malformed input (no sku, or no orderId/session scope) is the typed INVALID_INPUT, not a throw", async () => {
		const noSku = await sandbox.invokeRoute("entitlements/download", { orderId: `order-${NS}-x` });
		expect(noSku).toEqual({ result: { authorized: false, reason: "INVALID_INPUT" } });

		const noScope = await sandbox.invokeRoute("entitlements/download", { sku: SKU });
		expect(noScope).toEqual({ result: { authorized: false, reason: "INVALID_INPUT" } });
	});

	test("with NO document store bound the route authorizes NOTHING: it fails closed on the missing store", async () => {
		// The one failure mode the mode collapse introduced. Commerce truth is the
		// document store now, so a deployment that never declared the commerce
		// collections has no entitlement rows to read — and the ONLY safe answer to
		// "may this file be served" is then a refusal. A route that fell back to a
		// default, or that treated an absent store as an empty one, would authorize
		// a download nobody ever paid for.
		const orderId = await createDigitalOrder("nostore");
		await payOrder(orderId); // genuinely entitled — against the store this boot lacks

		const unstoraged = await loadPluginInSandbox({ allowedHosts: [] });
		try {
			const outcome = await unstoraged.invokeRoute("entitlements/download", { orderId, sku: SKU });
			expect("error" in outcome).toBe(true);
			if ("error" in outcome) expect(outcome.error).toContain(MISSING_STORAGE_MESSAGE);
			expect(JSON.stringify(outcome)).not.toContain('"authorized":true');
		} finally {
			await unstoraged.close();
		}
	}, 300_000);
});
