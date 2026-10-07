/**
 * Step 4.9 (download leg): the entitlement-gated digital download under the
 * workerd-on-Node sandbox. The route answers a file's descriptor ONLY when the
 * whole delivery gate holds (issue #376, increment 2) — the cases are the shared
 * `downloadRouteContract`, which `download-route.in-process.test.ts` runs too.
 *
 * WHAT INC-D3a CHANGED HERE. The check used to be a request to a REAL service
 * over `ctx.http`, and this suite stood that service up on Postgres to answer
 * it. The transport is gone — the check is a read against the plugin's own
 * document store on `ctx.storage` — so there is no service to start, no
 * `commerceServiceBaseUrl` to hand the sandbox, and no Postgres in this file at
 * all. The contract's fixtures are written through the same
 * `@otta-sh/store-emdash` adapters the plugin composes, into the Node-side store
 * the sandbox's storage bridge serves, and its grant mirrors, key for key, what
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
	money,
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
	EmdashProductCommerceStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MISSING_STORAGE_MESSAGE } from "../src/commerce/in-process-commerce-stores.js";
import { downloadRouteContract } from "./contracts/download-route-contract.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/** A namespace no other suite writes under — the document store is
 *  process-scoped and shared by every sandbox suite in this process. */
const NS = "dl";

let sandbox: SandboxHandle;
let storage: StorageAccess;
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
	// NO allowed hosts — see the module doc's egress note.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
});

/** Unwrap the sandbox's `{result}` envelope; an `{error}` fails the case loudly. */
async function invoke(input: unknown): Promise<unknown> {
	const outcome = await sandbox.invokeRoute("entitlements/download", input);
	if (!("result" in outcome)) throw new Error(`route threw: ${JSON.stringify(outcome)}`);
	return outcome.result;
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

downloadRouteContract({
	name: "workerd sandbox",
	ns: NS,
	storage: () => storage,
	invoke,
	loginSession,
});

describe("entitlement-gated download (workerd sandbox)", () => {
	test("with NO document store bound the route authorizes NOTHING: it fails closed on the missing store", async () => {
		// The one failure mode the mode collapse introduced. Commerce truth is the
		// document store now, so a deployment that never declared the commerce
		// collections has no entitlement rows to read — and the ONLY safe answer to
		// "may this file be served" is then a refusal. A route that fell back to a
		// default, or that treated an absent store as an empty one, would authorize
		// a download nobody ever paid for.
		const orderId = `order-${NS}-nostore`;
		const productId = `prod-${NS}-nostore`;
		const sku = `SKU-${NS}-nostore`;
		await seedEntitled(orderId, productId, sku); // genuinely entitled — against the store this boot lacks

		const unstoraged = await loadPluginInSandbox({ allowedHosts: [] });
		try {
			const outcome = await unstoraged.invokeRoute("entitlements/download", { orderId, sku });
			expect("error" in outcome).toBe(true);
			if ("error" in outcome) expect(outcome.error).toContain(MISSING_STORAGE_MESSAGE);
			expect(JSON.stringify(outcome)).not.toContain('"authorized":true');
			expect(JSON.stringify(outcome)).not.toContain(`dl/${productId}/`);
		} finally {
			await unstoraged.close();
		}
	}, 300_000);
});

/** A paid digital order with its grant and a file, for the no-store case: the
 *  storaged boot would answer it `authorized` (the contract proves that). */
async function seedEntitled(orderId: string, productId: string, sku: string): Promise<void> {
	const products = new EmdashProductCommerceStore({ storage, clock: systemClock });
	const row = await products.upsert(
		{
			productId: toProductId(productId),
			sku: toSku(sku),
			price: money(cents(900), currency("USD")),
			productKind: "digital",
		},
		idempotencyKey(`seed-${productId}`),
	);
	await products.updateCommerceFields(
		{
			productId: toProductId(productId),
			downloadAsset: {
				key: `dl/${productId}/01J9ZQ3V8K4M2N6P7R8S9T0VWX`,
				filename: "guide.pdf",
				contentType: "application/pdf",
				size: 2048,
			},
		},
		idempotencyKey(`asset-${productId}`),
		row.updatedAt.toISOString(),
	);
	const orders = new EmdashOrderStore({
		storage,
		inventory: new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock }),
		idGen: uuidIdGen,
		clock: systemClock,
	});
	await orders.createFromCart({
		orderId: toOrderId(orderId),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`seed-${orderId}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: `${NS}-nostore@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(productId),
				sku: toSku(sku),
				title: "Digital Guide",
				unitPrice: cents(900),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(900), total: cents(900), currency: currency("USD") },
	});
	await orders.markPaid(toOrderId(orderId));
	await new EmdashEntitlementStore({ storage, idGen: uuidIdGen, clock: systemClock }).grant({
		orderId: toOrderId(orderId),
		productId: toProductId(productId),
		sku: toSku(sku),
		buyerRef: `${NS}-nostore@example.test`,
		source: "order_paid",
		grantIdempotencyKey: idempotencyKey(`ent:${orderId}:${sku}`),
	});
}
