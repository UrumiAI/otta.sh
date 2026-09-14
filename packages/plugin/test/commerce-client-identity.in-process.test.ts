/**
 * IN-PROCESS-ONLY PROOF, pending the shared cases.
 *
 * The nine identity-bearing methods of the commerce client — the customer's own
 * orders and addresses, the session arm of the delivery check, login and logout —
 * had no coverage on either transport. These cases prove them on THIS one, and
 * they live here rather than in the shared contract on purpose: proving them
 * transport-agnostically needs a way for a tier to mint a session, which the tier
 * interface does not yet offer. The follow-on change adds that hook to both tiers
 * and lifts these cases into the shared slice; until then this file is the proof,
 * and it is labelled so nobody reads it as the last word.
 *
 * WHAT IS BEING PROVEN, and why each one is a security property rather than a
 * convenience:
 *
 *  - IDENTITY IS DERIVED, NEVER ACCEPTED. No method takes a customer id. The only
 *    credential is the bearer session token, and the only thing that turns it into
 *    an identity is the session store. A case here holds TWO sessions at once and
 *    asserts that each one sees exactly its own data — which is the property a
 *    filter-based implementation fails and a derivation-based one cannot.
 *  - A FOREIGN ORDER IS NOT_FOUND, not a refusal. "You may not see this" states
 *    that it exists; a shopper probing order ids must not learn which ones are
 *    real.
 *  - THE ENTITLEMENT CHECK'S EMAIL IS READ OFF THE SESSION. The port carries no
 *    field for a raw email, so the operator-only scope is not merely refused here,
 *    it is unrepresentable — and that is asserted by inspection of the surface,
 *    because a test cannot call a method that does not exist.
 *  - LOGOUT INVALIDATES. The next call with the same token is unauthenticated.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	cents,
	currency as toCurrency,
	email as toEmail,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import type { CommerceClient } from "../src/product-commerce/commerce-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

describe("in-process commerce derives identity from the session and nothing else", () => {
	let harness: InProcessCommerceHarness;
	let client: CommerceClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		client = harness.client;
	}, 120_000);
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.close();
	});

	/**
	 * A real login, end to end through the real stores: issue the challenge, redeem
	 * it through the client, keep the session token. The challenge is issued through
	 * the verifier rather than through `requestLoginLink` for one reason — the
	 * emailed token is not part of any reply, and this transport dispatches no mail
	 * yet, so this is the only way to hold a token a shopper would have received.
	 */
	async function login(address: string): Promise<string> {
		const issued = await harness.stores.credentialVerifier.issueChallenge(toEmail(address));
		if (!issued.ok) throw new Error(`challenge not issued: ${issued.reason}`);
		const verified = await client.verifyLogin(issued.challengeId, issued.token);
		if (!verified.ok) throw new Error(`login failed: ${verified.reason}`);
		return verified.sessionToken;
	}

	/**
	 * A GUEST order under one email, created through the order store the client
	 * reads. It has no customer until that inbox is proven: logging in as the same
	 * address claims it, which is the real path an order acquires an owner and
	 * therefore the honest way to arrange one. Returns the order id.
	 */
	async function seedGuestOrder(id: string, buyerRef: string): Promise<string> {
		await harness.stores.orderStore.createFromCart({
			orderId: toOrderId(id),
			cartId: null,
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey(`seed-${id}`),
			holdExpiresAt: "2026-09-14T00:15:00.000Z",
			buyerRef,
			paymentMethod: "stripe",
			lines: [
				{
					productId: toProductId("prod-owned"),
					sku: toSku("SKU-OWNED"),
					title: "Owned",
					unitPrice: cents(1500),
					currency: toCurrency("USD"),
					quantity: 1,
					fulfillmentKind: "digital",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(1500), total: cents(1500), currency: toCurrency("USD") },
		});
		return id;
	}

	test("a login mints a session that resolves, and logout invalidates it", async () => {
		const token = await login("shopper@example.test");
		expect(await client.listMyOrders(token)).toEqual({ ok: true, orders: [] });

		await client.logout(token);
		expect(await client.listMyOrders(token)).toEqual({ ok: false, reason: "UNAUTHENTICATED" });
		expect(await client.listMyAddresses(token)).toEqual({
			ok: false,
			reason: "UNAUTHENTICATED",
		});
		expect(await client.getMyOrder(token, "any-order")).toEqual({
			ok: false,
			reason: "UNAUTHENTICATED",
		});
	});

	test("an unknown session token is UNAUTHENTICATED on every method that takes one", async () => {
		const forged = "not-a-session-token";
		expect(await client.listMyOrders(forged)).toEqual({ ok: false, reason: "UNAUTHENTICATED" });
		expect(await client.listMyAddresses(forged)).toEqual({
			ok: false,
			reason: "UNAUTHENTICATED",
		});
		expect(await client.getMyOrder(forged, "any-order")).toEqual({
			ok: false,
			reason: "UNAUTHENTICATED",
		});
		// The session arm of the delivery check too: an unusable token is not a
		// downgrade to "no scope", it is unauthenticated.
		expect(await client.checkEntitlement({}, "SKU-X", { sessionToken: forged })).toEqual({
			ok: false,
			reason: "UNAUTHENTICATED",
		});
	});

	test("with no credential at all, the delivery check is closed rather than open", async () => {
		expect(await client.checkEntitlement({}, "SKU-X")).toEqual({
			ok: false,
			reason: "UNAUTHENTICATED",
		});
	});

	test("the order-id scope is an OPEN capability and IGNORES a session that came along", async () => {
		// The order id is the credential; there is no email in the question, so there
		// is nothing to probe. An unknown id answers "not active", never a refusal and
		// never an existence signal.
		expect(await client.checkEntitlement({ orderId: "unknown-order" }, "SKU-X")).toEqual({
			ok: true,
			active: false,
		});
		// A bearer alongside it changes NOTHING — the scope is chosen by what the
		// request contains, not by which credential looks best, which is what keeps a
		// "does order X belong to email Y" oracle out of this surface. An UNUSABLE
		// bearer proves it: were the session consulted at all, this would have to be
		// unauthenticated instead.
		expect(
			await client.checkEntitlement({ orderId: "unknown-order" }, "SKU-X", {
				sessionToken: "not-a-session-token",
			}),
		).toEqual({ ok: true, active: false });
		// And with a VALID one, the answer is still the order-id scope's.
		const token = await login("bearer-ignored@example.test");
		expect(
			await client.checkEntitlement({ orderId: "unknown-order" }, "SKU-X", { sessionToken: token }),
		).toEqual({ ok: true, active: false });
	});

	test("the session arm derives the buyer's email server-side — the port carries NO field for one", async () => {
		const token = await login("derived@example.test");
		// It answers (the scope resolved), and it answers about this session's own
		// customer: nothing in the call named an email or a customer.
		expect(await client.checkEntitlement({}, "SKU-DERIVED", { sessionToken: token })).toEqual({
			ok: true,
			active: false,
		});
		// And the surface CANNOT express the operator-only raw-email scope. That is a
		// property of the type rather than of any value, so it is checked by the
		// compiler: `EntitlementScope` below is exhaustively `{ orderId?: string }`,
		// and the two `@ts-expect-error`s in the type test at the bottom of this file
		// fail the build if a second key ever appears or `buyerRef` becomes accepted.
		// A runtime `Object.keys` on a literal this file wrote would have asserted only
		// that this file wrote it.
	});

	test("two sessions see only their own data — the isolation is derived, not filtered", async () => {
		const mine = await login("mine@example.test");
		const theirs = await login("theirs@example.test");
		const myId = await harness.stores.sessionStore.validate(mine);
		const theirId = await harness.stores.sessionStore.validate(theirs);
		expect(myId).not.toBeNull();
		expect(theirId).not.toBeNull();
		expect(myId).not.toBe(theirId);

		// Addresses are the cheapest per-customer state to write through a port, and
		// they exercise the same derivation every `/me` read uses.
		await harness.stores.addressStore.create(myId!, {
			kind: "shipping",
			name: "Mine",
			line1: "1 My Street",
			line2: null,
			city: "Town",
			region: null,
			postalCode: "00001",
			country: "US",
			isDefault: true,
		});

		const minesView = await client.listMyAddresses(mine);
		expect(minesView.ok && minesView.addresses.map((a) => a.name)).toEqual(["Mine"]);
		// The other session shares the store and sees none of it.
		const theirsView = await client.listMyAddresses(theirs);
		expect(theirsView).toEqual({ ok: true, addresses: [] });
	});

	test("the owner sees their claimed order; a FOREIGN one is NOT_FOUND, not a refusal", async () => {
		// The order exists as a GUEST order first, under the owner's address.
		const orderId = await seedGuestOrder("order-owned-1", "owner@example.test");
		// Logging in proves the inbox and claims it — the real path to ownership.
		const mine = await login("owner@example.test");
		const theirs = await login("stranger@example.test");

		const ownerView = await client.getMyOrder(mine, orderId);
		expect(ownerView.ok && ownerView.order.id).toBe(orderId);
		const ownerList = await client.listMyOrders(mine);
		expect(ownerList.ok && ownerList.orders.map((order) => order.id)).toEqual([orderId]);

		// The other session: the order genuinely exists and genuinely is not theirs.
		expect(await client.getMyOrder(theirs, orderId)).toEqual({ ok: false, reason: "NOT_FOUND" });
		// An id nobody ever minted answers IDENTICALLY, which is the whole point: the
		// two must be indistinguishable to a caller probing ids.
		expect(await client.getMyOrder(theirs, "never-existed")).toEqual({
			ok: false,
			reason: "NOT_FOUND",
		});
		// And their own list stays empty — no cross-customer leak by another route.
		expect(await client.listMyOrders(theirs)).toEqual({ ok: true, orders: [] });
	});

	test("nothing in any of this reached for egress", () => {
		expect(harness.egressAttempts()).toBe(0);
	});
});

// ── the scope type, checked by the compiler ───────────────────────────────
//
// The delivery check's scope must stay exactly `{ orderId?: string }`. The
// operator-only raw-email scope is not "refused" by this port, it is
// UNREPRESENTABLE — and the only honest way to assert that is to ask the compiler,
// because a test cannot call a signature that does not exist. Both directions are
// pinned: an extra key must not typecheck, and the one key must.

type EntitlementScope = Parameters<CommerceClient["checkEntitlement"]>[0];

/** Exhaustiveness: a scope with only `orderId` is a complete `EntitlementScope`,
 *  so no other key is REQUIRED, and the assignment below is what proves it. */
const completeScope: Required<EntitlementScope> = { orderId: "order-1" };
void completeScope;

// The raw-email scope: the field the service had and this port must never grow.
// @ts-expect-error — `buyerRef` is not part of the scope this port accepts.
const withBuyerRef: EntitlementScope = { orderId: "order-1", buyerRef: "someone@example.test" };
void withBuyerRef;

// And nothing else either: an unknown key is a type error, not a silently ignored
// field, which is what keeps a future "just pass the customer id" from compiling.
// @ts-expect-error — the scope carries no customer identity of any kind.
const withCustomerId: EntitlementScope = { orderId: "order-1", customerId: "cus_1" };
void withCustomerId;
