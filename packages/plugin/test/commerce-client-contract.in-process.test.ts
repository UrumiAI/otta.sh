/**
 * The in-process tier of `commerceClientContract`.
 *
 * This file binds the transport-agnostic contract to `InProcessCommerceClient`
 * over a REAL document store: the host's own `PluginStorageRepository` on
 * in-memory SQLite, migrated by the host's own migration set. There is no
 * commerce service in this tier, no HTTP server, and no `fetch` — `ctx.http` is
 * bound to a rejecting stub precisely so a method that reached for egress would
 * fail the suite rather than quietly work.
 *
 * WHY THE SAME CASES, UNCHANGED. The contract is the equivalence proof: the
 * cases were lifted out of the HTTP client's own suites so both transports can
 * execute them, and the value of that evaporates the moment a tier narrows,
 * skips or reorders one. A case that fails here is a composition or an adapter
 * defect, never a case to soften.
 *
 * WHAT IS REAL AND WHAT IS NOT. The document store is real — real databases,
 * never mocks, because no fake can lose a compare-and-set race — and it is built
 * by the ADAPTER PACKAGE's own dialect harness rather than by a second copy of
 * that wiring here. That matters for more than duplication: the harness is where
 * the two rules the store depends on are stated and enforced (the schema always
 * comes from the host's migrations, because the revision a guarded write compares
 * is assigned by a trigger only they create; rows are cleared between cases and
 * the table is never dropped, because dropping it would take the trigger with
 * it). Keeping the host, `kysely` and `better-sqlite3` imports inside that
 * package is also what keeps them out of this one, which declares no dependency
 * on the host in any form.
 *
 * Rows ARE cleared per case here, which is what makes `reset()` a real reset in
 * this tier rather than the documented no-op the HTTP tier implements.
 *
 * THIS TIER DECLARES THE CLOCK HOOK AND NOT THE PAYMENTS ONE, and the other tier
 * declares the reverse. Neither is a tier excusing itself: the two gaps are real,
 * they are opposite, and each is pinned by a case that names its own gate — so a
 * test report says which tier skipped what and why. The clock is offerable HERE
 * because this backend is rebuilt per case, so winding it forward costs nothing
 * `reset()` cannot put back. The gateways are not offerable here YET, because the
 * payment adapters have not moved in-process; when they do, the payments hook
 * appears and the shared checkout case starts running with no edit to any case.
 */
import { email as toEmail } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { isCommerceInputError } from "../src/commerce/commerce-input.js";
import type { CommerceClient } from "../src/product-commerce/commerce-client.js";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { InProcessAdminProductsClient } from "../src/admin/in-process-admin-products-client.js";
import { InProcessAdminRulesClient } from "../src/admin/in-process-admin-rules-client.js";
import { InProcessReportingSettingsClient } from "../src/admin/in-process-reporting-settings-client.js";
import {
	adminOrdersProductsClientContract,
	adminRulesReportingClientContract,
	storefrontCommerceClientContract,
	type AdminClientSurfaces,
	type CommerceClientTier,
} from "./contracts/commerce-client-contract.js";
import { sharedTierSeeders } from "./helpers/commerce-tier-arrange.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

/**
 * The in-process tier. `arrange` programs state through the client's own writes
 * and through the domain PORTS, exactly as the HTTP tier does — so the two tiers
 * seed identically and a difference in a case's outcome can only come from the
 * transport under test.
 */
function inProcessTier(): CommerceClientTier {
	let harness: InProcessCommerceHarness | undefined;
	let client: CommerceClient | undefined;
	/**
	 * Anchored at the real instant the suite started rather than at a fixed literal,
	 * so nothing here reads as "long ago" to a store comparing against an absolute
	 * value — and constructed HERE rather than inside `setup()`, because the contract
	 * decides at COLLECTION time which cases this tier's hooks let it run.
	 */
	const clock = new FixedClock(new Date());

	function clientOrThrow(): CommerceClient {
		if (client === undefined) throw new Error("tier not set up");
		return client;
	}

	function harnessOrThrow(): InProcessCommerceHarness {
		if (harness === undefined) throw new Error("tier not set up");
		return harness;
	}

	return {
		name: "in-process, plugin storage, sqlite",
		async setup() {
			if (harness !== undefined) return; // one database per tier, however many slices ask
			harness = await makeInProcessCommerce({ clock });
			client = harness.client;
		},
		async teardown() {
			const open = harness;
			harness = undefined;
			client = undefined;
			await open?.close();
		},
		async reset() {
			// A REAL reset, unlike the HTTP tier's documented no-op: it empties the
			// rows and keeps the schema, which is the only form of reset that keeps the
			// revision trigger the guarded writes depend on.
			await harness?.reset();
		},
		async makeClient() {
			return clientOrThrow();
		},
		/**
		 * The admin surfaces this tier has — ALL FOUR of them: products (INC-B10b-i),
		 * orders (INC-B10b-ii), rules (INC-B10c-i) and reporting + settings
		 * (INC-B10c-ii). None is stubbed and none is absent: an empty implementation
		 * would let its slice pass against nothing, answering "no revenue" where the
		 * honest answer would have been "not wired yet".
		 *
		 * NO TOKENS ARE THREADED, unlike the HTTP tier, and that is the design rather
		 * than a gap: `X-Internal-Token` / `X-Service-Token` authenticate a caller TO
		 * THE SERVICE, and there is no service here. EmDash's own admin auth and CSRF
		 * gate the console routes (ADR-0014 D3), so the gated tier's auth-rejection
		 * cases are transport cases and stay in the HTTP tier's own file.
		 */
		async makeAdminClients(): Promise<AdminClientSurfaces> {
			const ctx = harnessOrThrow().ctx;
			return {
				orders: new InProcessAdminOrdersClient(ctx, { clock }),
				products: new InProcessAdminProductsClient(ctx, { clock }),
				rules: new InProcessAdminRulesClient(ctx, { clock }),
				reporting: new InProcessReportingSettingsClient(ctx, { clock }),
			};
		},
		// The lever the elapsed-deadline case needs. It moves the ONE clock every store
		// in this composition shares — the client's own stores and the harness's second
		// set — because a deadline stamped by one store has to be the same instant the
		// next store compares against.
		clock: {
			async advance(ms: number) {
				clock.advance(ms);
			},
		},
		arrange: {
			...sharedTierSeeders({
				get orderStore() {
					return harnessOrThrow().stores.orderStore;
				},
				get addressStore() {
					return harnessOrThrow().stores.addressStore;
				},
				get sessionStore() {
					return harnessOrThrow().stores.sessionStore;
				},
				get shippingRules() {
					return harnessOrThrow().stores.shippingRules;
				},
				get couponStore() {
					return harnessOrThrow().stores.couponStore;
				},
				get taxRules() {
					return harnessOrThrow().stores.taxRules;
				},
			}),
			/**
			 * A real login, end to end through the real stores: issue the challenge,
			 * redeem it THROUGH THE CLIENT, keep the session token.
			 *
			 * The challenge is issued through the verifier rather than through
			 * `requestLoginLink` for one reason — this transport dispatches no mail yet,
			 * and the emitted token is part of no reply, so there is no message to
			 * capture and this is the only way to hold a token a shopper would have
			 * received. The other tier, which does dispatch, captures the mail instead.
			 * The redemption is the client's own on both, which is the half the cases
			 * are actually about.
			 */
			async session(email) {
				const open = harnessOrThrow();
				const issued = await open.stores.credentialVerifier.issueChallenge(toEmail(email));
				if (!issued.ok) throw new Error(`arrange.session: challenge not issued (${issued.reason})`);
				const verified = await clientOrThrow().verifyLogin(issued.challengeId, issued.token);
				if (!verified.ok) throw new Error(`arrange.session: login failed (${verified.reason})`);
				const customerId = await open.stores.sessionStore.validate(verified.sessionToken);
				return {
					bearer: verified.sessionToken,
					...(customerId === null ? {} : { customerId }),
				};
			},
			async product(spec) {
				await clientOrThrow().upsertProductCommerce(
					spec.productId,
					{
						sku: spec.sku,
						...(spec.price !== undefined ? { price: spec.price } : {}),
						...(spec.title !== undefined ? { title: spec.title } : {}),
						...(spec.onHand !== undefined ? { initialOnHand: spec.onHand } : {}),
					},
					spec.idempotencyKey,
				);
				return spec.productId;
			},
			async cart(currency) {
				const { cartId } = await clientOrThrow().createCart(currency);
				return cartId;
			},
		},
	};
}

const storefront = inProcessTier();

describe("commerceClientContract over InProcessCommerceClient", () => {
	afterAll(async () => {
		await storefront.teardown();
	});
	storefrontCommerceClientContract(storefront);
});

/** The admin slice gets its OWN tier instance — its own database and its own
 *  `reset()` — so the console cases and the storefront cases cannot seed over
 *  each other, exactly as the HTTP file stands a second service for its admin
 *  slice. */
const admin = inProcessTier();

describe("commerceClientContract over the in-process admin clients", () => {
	afterAll(async () => {
		await admin.teardown();
	});
	adminOrdersProductsClientContract(admin);
	adminRulesReportingClientContract(admin);
});

/**
 * WHAT STAYS IN THIS FILE, AND WHY EACH ONE CANNOT BE SHARED.
 *
 * Most of what this file used to assert alone now lives in the shared contract and
 * runs on both transports: the watermark, variant-key, title, zero-price and
 * batch-cap refusals, and every identity case. Each moved because the OTHER
 * transport can be held to it too — a bound proven on one implementation is not
 * evidence about the port.
 *
 * What is left below is what genuinely does not survive the move, with the reason
 * recorded per block rather than left to be rediscovered. None of it is a case that
 * was merely inconvenient to share.
 */

/** Every refusal is this shape: awaited, structural, and it names the field. This
 *  is the STRICTER assertion the shared contract cannot make — see its
 *  `expectRejectedInput`, which drops the code on a transport that carries none. */
async function expectRefusal(call: Promise<unknown>, field: string): Promise<void> {
	await call.then(
		() => {
			throw new Error(`expected a refusal naming ${field}`);
		},
		(err: unknown) => {
			expect(isCommerceInputError(err), `${field}: structural code`).toBe(true);
			expect((err as { code: string }).code).toBe("INVALID_INPUT");
			expect((err as { field: string }).field).toBe(field);
		},
	);
}

/**
 * THE BOUNDS WHOSE REFUSAL IS NOT COMPARABLE ACROSS TRANSPORTS.
 *
 * These two are here rather than in the shared contract because the other transport
 * does not REJECT on them: its cart and quote routes normalize a bad value into one
 * of the port's typed cart tokens, so the same input produces a rejection on this
 * tier and a resolved `{ ok: false, reason }` on that one. Those are two different
 * behaviours, and a shared case would have to assert one of them loosely enough to
 * accept the other — exactly the softening that makes an equivalence proof
 * worthless. So the strict assertion lives on the tier that can make it, and the
 * difference is named instead of papered over.
 *
 * The egress count is here for a simpler reason: the other transport's whole job is
 * egress, so it has nothing to assert.
 */
describe("in-process commerce refuses malformed shopper input before any store call", () => {
	let harness: InProcessCommerceHarness;
	let client: CommerceClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		client = harness.client;
	}, 120_000);
	afterEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.close();
	});

	// THE EMPTY VARIANT KEY, here rather than in the shared contract. The shared
	// case asserts a whitespace key on all three writers, because an EMPTY one makes
	// the other transport build a path with an empty segment and miss its route
	// altogether — so a shared empty-key case would assert a route miss on that tier
	// and the bound on this one. The bound itself still deserves an assertion, and
	// this is the tier that checks it before any call, so it is asserted here.
	test("an empty variant key is refused by the bound, not by a missing route", async () => {
		await expectRefusal(
			client.deactivateProductVariant(
				"prod-vk-empty",
				"",
				"vk-empty-1",
				"2026-09-14T00:00:00.000Z",
			),
			"variantKey",
		);
		expect(await client.listProductVariants("prod-vk-empty")).toEqual([]);
	});

	test("the shopper-facing bounds hold: quantity and cart ids", async () => {
		const cartId = (await client.createCart("USD")).cartId;
		await expectRefusal(client.addCartLine(cartId, "SKU-Q", null, 0, "q-1"), "qty");
		await expectRefusal(client.addCartLine(cartId, "SKU-Q", null, 1.5, "q-2"), "qty");
		await expectRefusal(client.addCartLine(cartId, "SKU-Q", null, 10_001, "q-3"), "qty");
		await expectRefusal(client.getCart("has a space"), "cartId");
	});

	test("nothing reached for egress while refusing any of it", () => {
		expect(harness.egressAttempts()).toBe(0);
	});
});

/**
 * THE TWO GAPS, PINNED.
 *
 * Both are deliberate, both are invisible unless a test says so, and NEITHER can be
 * a shared case — because in each the other transport does the very thing this one
 * does not, so there is no single outcome for a shared case to assert. They are the
 * two places the transports genuinely differ today, recorded here rather than only
 * in prose so the difference has a test standing over it. Each fails the day the
 * missing piece lands, which is exactly when someone should come back and delete it.
 */
describe("in-process commerce: what is deliberately not wired yet", () => {
	let harness: InProcessCommerceHarness;
	let client: CommerceClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		client = harness.client;
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	// THE HEADLINE DIFFERENCE between the tiers, seen from this side: the other one
	// composes a gateway and checks out successfully, which is why the shared
	// checkout-replay case runs there and skips here. What this case adds — and the
	// shared one cannot — is that the refusal damages nothing.
	test("checkout has NO payment gateway: a real cart with a held line survives the refusal intact", async () => {
		// A genuine cart, priced, with stock held for its line — so the refusal is
		// asserted against the state it must not damage rather than against nothing.
		await client.upsertProductCommerce(
			"prod-nogw",
			{ sku: "SKU-NOGW", price: { amount: 2500, currency: "USD" }, initialOnHand: 3 },
			"nogw-seed",
		);
		const { cartId } = await client.createCart("USD");
		const added = await client.addCartLine(cartId, "SKU-NOGW", "prod-nogw", 2, "nogw-add");
		if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
		const heldReservation = added.line.reservationId;
		expect(heldReservation).not.toBeNull();
		// It quotes, so the only thing missing is the gateway.
		expect((await client.quoteCheckout({ cartId })).ok).toBe(true);

		for (const paymentMethod of ["stripe", "x402"] as const) {
			await expect(
				client.createOrder(
					{ cartId, paymentMethod, buyerRef: "buyer@example.test" },
					`no-gateway-${paymentMethod}`,
				),
			).rejects.toThrow(/no payment gateway configured/);
		}

		// The cart is untouched: still active (not checked out), still naming no order,
		// its line still holding the SAME reservation. A refusal that consumed the
		// cart or dropped the hold would be worse than the missing gateway.
		const read = await client.getCart(cartId);
		expect(read).toMatchObject({
			ok: true,
			cart: {
				state: "active",
				orderId: null,
				lines: [{ sku: "SKU-NOGW", qty: 2, reservationId: heldReservation }],
			},
		});
	});

	// NOT SHAREABLE for the mirror-image reason: the other transport DOES dispatch the
	// login mail — the shared identity cases mint their sessions by capturing it — so
	// "no mail left the process" is true here and false there, by design on both.
	test("a login link records ONE challenge and dispatches NO mail", async () => {
		const challenges = harness.ctx.storage?.["login_challenges"];
		if (challenges === undefined)
			throw new Error("the login_challenges collection is not declared");
		const before = { rows: await challenges.count(), egress: harness.egressAttempts() };

		expect(await client.requestLoginLink("shopper@example.test")).toEqual({ ok: true });

		// The challenge is recorded — counted in the store rather than inferred by
		// issuing a second one, which would have proven only that the verifier works.
		expect(await challenges.count()).toBe(before.rows + 1);
		// And no mail left the process, because there is nowhere for it to go yet: the
		// only outbound surface this transport has is `ctx.http`, and it was untouched.
		expect(harness.egressAttempts()).toBe(before.egress);
	});
});

/**
 * THE ONE PLACE ORDER SEARCH IS NARROWER HERE, PINNED ON PURPOSE.
 *
 * ADR-0019 §6 sets the FLOOR every dialect must meet — an id PREFIX, a folded
 * buyer-ref PREFIX, or an EXACT folded line sku — and says plainly that a dialect
 * may answer MORE. Postgres does: it plans the buyer-ref half as an unanchored
 * `like '%q%'`, so a fragment from the MIDDLE of an address finds the order there.
 * The document store behind this tier indexes a folded prefix key and cannot, and
 * that is a ratified divergence (2026-09-13) rather than a defect: a prefix is the
 * floor both tiers meet, and the superset is sanctioned where the dialect offers
 * it for free.
 *
 * IT CANNOT BE A SHARED CASE, for the same reason none of the others can: the two
 * tiers produce OPPOSITE answers to the identical call, so a shared case would
 * have to assert one of them loosely enough to accept the other. The shared slice
 * therefore asserts the floor and NEVER a negative, and each tier pins its own
 * half here — this file the miss, the HTTP file the hit. Should the document store
 * ever gain substring search, this case fails and is deleted, which is exactly the
 * moment someone should be told.
 */
describe("in-process admin orders: search is PREFIX-only, by dialect (ADR-0019 §6)", () => {
	let harness: InProcessCommerceHarness;
	let orders: InProcessAdminOrdersClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		orders = new InProcessAdminOrdersClient(harness.ctx);
		await sharedTierSeeders({
			orderStore: harness.stores.orderStore,
			addressStore: harness.stores.addressStore,
			sessionStore: harness.stores.sessionStore,
			shippingRules: harness.stores.shippingRules,
			couponStore: harness.stores.couponStore,
			taxRules: harness.stores.taxRules,
		}).order({ orderId: "div-o-1", buyerRef: "marguerite@example.test" });
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("a buyer-ref PREFIX hits, and a fragment from the middle of the same address does NOT", async () => {
		// The floor, met: the operator types the start of the address they remember,
		// in whatever case they remember it.
		expect((await orders.listOrders({ search: "MARGUER" })).orders.map((o) => o.id)).toEqual([
			"div-o-1",
		]);

		// The superset, absent: "guerite@" is a genuine fragment of the very same
		// buyer ref, and the HTTP tier's Postgres dialect finds it. Here it does not,
		// and the count agrees with the page rather than describing a set the rows do
		// not.
		const midString = await orders.listOrders({ search: "guerite@" });
		expect(midString.orders).toEqual([]);
		expect(midString.total).toBe(0);
	});
});
