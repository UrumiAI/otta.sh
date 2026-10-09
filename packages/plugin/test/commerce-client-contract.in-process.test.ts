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
 * WHY THE SAME CASES, UNCHANGED. The contract was the equivalence proof: the
 * cases were lifted out of the HTTP client's own suites so both transports could
 * execute them, and the value of that would have evaporated the moment a tier
 * narrowed, skipped or reordered one. INC-D3b deleted the HTTP tier and this is
 * the only one left, but the cases stay exactly as they were, because they are
 * the PORT's spec rather than this composition's: a case that fails here is a
 * composition or an adapter defect, never a case to soften.
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
 * this tier rather than the documented no-op the HTTP tier implemented.
 *
 * THIS TIER DECLARES BOTH OPTIONAL HOOKS. The clock is offerable because this
 * backend is rebuilt per case, so winding it forward costs nothing `reset()`
 * cannot put back. The payments hook is offerable because the tier composes a
 * `FakePaymentGateway` for `stripe` into both the storefront client and the
 * admin orders client, through the same `gateways` option production's
 * composition roots use — so the gated checkout and refund cases run here.
 * The fake stands in for the PROVIDER only; the order store, the refund ledger
 * and its ceiling arbitration are the real adapters.
 */
import { email as toEmail } from "@otta-sh/domain";
import { FakePaymentGateway, FixedClock } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	IDEMPOTENCY_KEY_MAX,
	ILL_FORMED_TEXT_REASON,
	isBoundedProductId,
	isCommerceInputError,
	isDocumentIdempotencyKey,
	isIdempotencyKeyText,
	isIdToken,
	isSkuText,
	requireBoundedProductId,
	requireDocumentIdempotencyKey,
	requireIdempotencyKey,
	requireIdToken,
	requireSku,
} from "../src/commerce/commerce-input.js";
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
 * and through the domain PORTS, exactly as the HTTP tier did — the two tiers
 * seeded identically, so a difference in a case's outcome could only have come
 * from the transport under test.
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
	/**
	 * The PROVIDER stand-in with the real adapter's honest capability: Stripe can
	 * move money back (`refundable: true`). The manual-refund case flips it to
	 * `false` for its own duration (Stripe with no secret key looks like that), so a
	 * refund is recorded manually. Composed into the storefront client and the
	 * admin orders client through the same `gateways` option production's
	 * composition roots pass.
	 */
	const stripeGateway = new FakePaymentGateway({ id: "stripe" });
	const gateways = { stripe: stripeGateway };

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
			harness = await makeInProcessCommerce({ clock, gateways });
			client = harness.client;
		},
		async teardown() {
			const open = harness;
			harness = undefined;
			client = undefined;
			await open?.close();
		},
		async reset() {
			// A REAL reset, unlike the HTTP tier's documented no-op was: it empties the
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
		 * NO TOKENS ARE THREADED, unlike the HTTP tier, and that was the design rather
		 * than a gap: `X-Internal-Token` / `X-Service-Token` authenticated a caller TO
		 * THE SERVICE, and there is no service any more. EmDash's own admin auth and
		 * CSRF gate the console routes (ADR-0014 D3); the auth-rejection cases were
		 * transport cases and went with the HTTP tier's own file.
		 */
		async makeAdminClients(): Promise<AdminClientSurfaces> {
			const ctx = harnessOrThrow().ctx;
			return {
				orders: new InProcessAdminOrdersClient(ctx, { clock, gateways }),
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
		throttleDocuments: async () => {
			const docs = harnessOrThrow().ctx.storage?.["login_challenge_claims"];
			if (docs === undefined) throw new Error("login_challenge_claims is not declared");
			return docs.count();
		},
		payments: {
			method: "stripe",
			setRefundable: (refundable) => stripeGateway.setRefundable(refundable),
			providerIntentCalls() {
				return [stripeGateway].flatMap((gateway) =>
					gateway.intentCalls.map((call) => ({
						gateway: gateway.id,
						orderId: call.orderId,
						amountCents: call.amount,
						currency: call.currency,
						idempotencyKey: call.idempotencyKey,
					})),
				);
			},
			providerRefundCalls() {
				return [stripeGateway].flatMap((gateway) =>
					gateway.refundCalls.map((call) => ({
						gateway: gateway.id,
						orderId: call.orderId,
						providerRef: call.providerRef,
						amountCents: call.amount,
						currency: call.currency,
						idempotencyKey: call.idempotencyKey,
					})),
				);
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
			 * `requestLoginLink` because this tier wires no email egress, and the token
			 * is part of no reply — so the verifier is the only place to hold one. The
			 * emailed path is proven in `login-link-email.in-process.test.ts` and the
			 * account-routes sandbox suite. The redemption is the client's own, which
			 * is the half these cases are actually about.
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
						...(spec.productKind !== undefined ? { productKind: spec.productKind } : {}),
					},
					spec.idempotencyKey,
				);
				if (spec.published !== false) {
					// Published the way `content:afterPublish` publishes, at a watermark older
					// than any lifecycle flip a case applies afterwards.
					await clientOrThrow().activateProductCommerce(
						spec.productId,
						`${spec.idempotencyKey}-publish`,
						"2026-01-01T00:00:00.000Z",
					);
				}
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
 *  each other, exactly as the HTTP file stood a second service for its admin
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
 * Most of what this file used to assert alone now lives in the shared contract:
 * the watermark, variant-key, title, zero-price and batch-cap refusals, and every
 * identity case. Each moved because the OTHER transport could be held to it too —
 * a bound proven on one implementation is not evidence about the port — and each
 * stays there now that transport is gone, because the contract is the port's spec
 * and not one tier's file.
 *
 * What is left below is what genuinely did not survive the move, with the reason
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
 * These two are here rather than in the shared contract because the HTTP transport
 * did not REJECT on them: its cart and quote routes normalized a bad value into one
 * of the port's typed cart tokens, so the same input produced a rejection on this
 * tier and a resolved `{ ok: false, reason }` on that one. Those were two different
 * behaviours, and a shared case would have had to assert one of them loosely enough
 * to accept the other — exactly the softening that makes an equivalence proof
 * worthless. So the strict assertion lives on the tier that can make it, and the
 * difference stays named instead of papered over.
 *
 * The egress count is here for a simpler reason: that transport's whole job was
 * egress, so it had nothing to assert.
 */
/** Whether `fn` refuses with a `CommerceInputError` (any other throw is a bug). */
function throwsInputError(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch (err) {
		if (!isCommerceInputError(err)) throw err;
		return true;
	}
}

/**
 * ONE DEFINITION PER RULE (#379). The storefront routes answer a bad value with
 * these predicates and the client refuses it with the matching `require*`; the
 * two must agree on every value, or the route lets through what the client
 * throws on (RENDER_FAILED) or refuses what it would accept.
 */
describe("each boundary predicate agrees with the require* the client throws from", () => {
	const EDGE_VALUES = [
		"",
		"a",
		" ",
		"a b",
		"a\u0000b",
		"\u0000",
		// Lone UTF-16 surrogates (review R3-B X1): ill-formed like U+0000.
		"a\uD800b",
		"\uDC00",
		"\uDE00\uD83D",
		"x".repeat(201) + "\uD800",
		"tab\there",
		"a\x7fb",
		"cärt",
		"😀",
		"x".repeat(200),
		"x".repeat(201),
		"k".repeat(IDEMPOTENCY_KEY_MAX),
		"k".repeat(IDEMPOTENCY_KEY_MAX + 1),
		"k".repeat(2_000),
	];
	const PAIRS: Array<[string, (v: string) => boolean, (v: string) => unknown]> = [
		["sku", isSkuText, (v) => requireSku(v)],
		["bounded productId", isBoundedProductId, requireBoundedProductId],
		["idempotency key", isIdempotencyKeyText, requireIdempotencyKey],
		["document-id idempotency key", isDocumentIdempotencyKey, requireDocumentIdempotencyKey],
		["id token", isIdToken, (v) => requireIdToken("id", v)],
	];

	test.each(PAIRS)("%s", (_label, is, require) => {
		for (const value of EDGE_VALUES) {
			expect(is(value), JSON.stringify(value.slice(0, 20))).toBe(
				!throwsInputError(() => require(value)),
			);
		}
	});
});

/** The refusal reason a `require*` throws, or null when it accepts. */
function reasonOf(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (err) {
		if (!isCommerceInputError(err)) throw err;
		return err.reason;
	}
}

/**
 * ONE REASON PER VALUE. Ill-formed text (U+0000 or a lone surrogate) is refused
 * with {@link ILL_FORMED_TEXT_REASON}; a value that is ALSO out of bounds is
 * refused for the bound, because the bound is checked first in every rule.
 */
describe("the refusal reason for ill-formed text", () => {
	test.each(["S\u0000KU", "S\uD800KU", "S\uDC00KU"])(
		"%j is refused as ill-formed by every edge rule",
		(value) => {
			expect(reasonOf(() => requireSku(value))).toBe(ILL_FORMED_TEXT_REASON);
			expect(reasonOf(() => requireBoundedProductId(value))).toBe(ILL_FORMED_TEXT_REASON);
			expect(reasonOf(() => requireIdempotencyKey(value))).toBe(ILL_FORMED_TEXT_REASON);
			expect(reasonOf(() => requireDocumentIdempotencyKey(value))).toBe(ILL_FORMED_TEXT_REASON);
		},
	);

	test("a value both too long and ill-formed is refused for its length", () => {
		expect(reasonOf(() => requireSku(`${"s".repeat(200)}\uD800`, 200))).toBe(
			"must be at most 200 characters",
		);
		expect(reasonOf(() => requireBoundedProductId(`${"p".repeat(200)}\u0000`))).toBe(
			"must be at most 200 characters",
		);
		expect(
			reasonOf(() => requireDocumentIdempotencyKey(`${"k".repeat(IDEMPOTENCY_KEY_MAX)}\uDC00`)),
		).toBe(`must be at most ${String(IDEMPOTENCY_KEY_MAX)} characters`);
	});

	test("a surrogate PAIR is well-formed and passes", () => {
		expect(reasonOf(() => requireSku("BEANS-\uD83D\uDE00"))).toBeNull();
		expect(reasonOf(() => requireDocumentIdempotencyKey("k-\uD83D\uDE00"))).toBeNull();
	});
});

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
	// case asserts a whitespace key on all three writers, because an EMPTY one made
	// the HTTP transport build a path with an empty segment and miss its route
	// altogether — so a shared empty-key case would have asserted a route miss on
	// that tier and the bound on this one. The bound deserves an assertion, and
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

	// U+0000 can never be stored by Postgres (`invalid byte sequence for encoding
	// "UTF8"`), so it is a refusal here — on every dialect — never a store throw
	// that only one dialect shows (#379).
	test("U+0000 is refused in a sku, an add's product id and an idempotency key", async () => {
		const cartId = (await client.createCart("USD")).cartId;
		await expectRefusal(client.addCartLine(cartId, "S\u0000KU", null, 1, "nul-1"), "sku");
		await expectRefusal(client.addCartLine(cartId, "SKU", "p\u0000id", 1, "nul-2"), "productId");
		await expectRefusal(client.addCartLine(cartId, "SKU", null, 1, "k\u0000ey"), "idempotencyKey");
		await expectRefusal(
			client.upsertProductCommerce("prod-nul", { sku: "S\u0000KU" }, "nul-3"),
			"sku",
		);
	});

	test("a cart mutation's idempotency key over the ceiling is refused", async () => {
		const cartId = (await client.createCart("USD")).cartId;
		const long = "k".repeat(IDEMPOTENCY_KEY_MAX + 1);
		await expectRefusal(client.addCartLine(cartId, "SKU", null, 1, long), "idempotencyKey");
		await expectRefusal(client.adjustCartLine(cartId, "line-1", 2, long), "idempotencyKey");
		await expectRefusal(client.removeCartLine(cartId, "line-1", long), "idempotencyKey");
	});

	// The other two writes whose key becomes a document id (`order_keys/{key}`,
	// `settings_mutations/{key}`) take the same ceiling.
	test("an order create's and a settings update's idempotency key over the ceiling is refused", async () => {
		const long = "k".repeat(IDEMPOTENCY_KEY_MAX + 1);
		const { cartId } = await client.createCart("USD");
		await expectRefusal(
			client.createOrder({ cartId, paymentMethod: "stripe", buyerRef: "buyer@example.test" }, long),
			"idempotencyKey",
		);
		const reporting = new InProcessReportingSettingsClient(harness.ctx, { clock: harness.clock });
		await expectRefusal(
			reporting.updateSettings({ lowStockThreshold: 5 }, { idempotencyKey: long }),
			"idempotencyKey",
		);
	});

	// The ceiling is for keys that become a document id. A product-row write keeps
	// its key as a FIELD, and variant sync derives keys longer than the ceiling
	// from opaque CMS text — so those writes take any storable length.
	test("a variant write's idempotency key is NOT held to the cart ceiling", async () => {
		const long = `products:prod-long:variant:${"x".repeat(IDEMPOTENCY_KEY_MAX)}`;
		await expect(
			client.upsertProductVariant(
				"prod-long",
				"large",
				{ title: "Large", contentUpdatedAt: "2026-09-14T00:00:00.000Z" },
				long,
			),
		).resolves.toMatchObject({ variantKey: "large" });
		await expectRefusal(
			client.upsertProductVariant(
				"prod-long",
				"large",
				{ title: "Large", contentUpdatedAt: "2026-09-14T00:00:00.000Z" },
				"k\u0000ey",
			),
			"idempotencyKey",
		);
	});

	test("the admin's sku edit refuses U+0000 as an invalid field, like an empty sku", async () => {
		const products = new InProcessAdminProductsClient(harness.ctx, { clock: harness.clock });
		expect(
			await products.updateProduct(
				"prod-nul",
				{ sku: "S\u0000KU", expectedUpdatedAt: "2026-09-14T00:00:00.000Z" },
				"nul-admin",
			),
		).toEqual({ ok: false, reason: "invalid", field: null });
	});

	test("nothing reached for egress while refusing any of it", () => {
		expect(harness.egressAttempts()).toBe(0);
	});
});

/**
 * THE TWO GAPS, PINNED.
 *
 * Both are deliberate, both are invisible unless a test says so, and NEITHER could
 * be a shared case — because in each the HTTP transport did the very thing this one
 * does not, so there was no single outcome for a shared case to assert. They were
 * the two places the transports genuinely differed, recorded here rather than only
 * in prose so the difference has a test standing over it. Each fails the day the
 * missing piece lands, which is exactly when someone should come back and delete it.
 *
 * The login-mail gap has closed (issue #306): the link is emailed through the
 * injected email egress. Its case below now pins the arm this harness still
 * has — no egress wired — rather than the gap.
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

	// THE HEADLINE DIFFERENCE between the tiers, seen from this side: the HTTP one
	// composed a gateway and checked out successfully, which is why the shared
	// checkout-replay case ran there and skips here — and, now that it is gone,
	// skips everywhere. What this case adds — and the shared one cannot — is that
	// the refusal damages nothing.
	test("checkout has NO payment gateway: a real cart with a held line survives the refusal intact", async () => {
		// A genuine cart, priced, with stock held for its line — so the refusal is
		// asserted against the state it must not damage rather than against nothing.
		await client.upsertProductCommerce(
			"prod-nogw",
			{ sku: "SKU-NOGW", price: { amount: 2500, currency: "USD" }, initialOnHand: 3 },
			"nogw-seed",
		);
		await client.activateProductCommerce("prod-nogw", "nogw-publish", "2026-01-01T00:00:00.000Z");
		const { cartId } = await client.createCart("USD");
		const added = await client.addCartLine(cartId, "SKU-NOGW", "prod-nogw", 2, "nogw-add");
		if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
		const heldReservation = added.line.reservationId;
		expect(heldReservation).not.toBeNull();
		// It quotes, so the only thing missing is the gateway.
		expect((await client.quoteCheckout({ cartId })).ok).toBe(true);

		await expect(
			client.createOrder(
				{ cartId, paymentMethod: "stripe", buyerRef: "buyer@example.test" },
				"no-gateway-stripe",
			),
		).rejects.toThrow(/no payment gateway configured/);

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

	// The login mail IS sent now (issue #306) — through the email egress the
	// composition root injects, and on THIS harness there is none. What stays
	// pinned here is the unconfigured arm: the same answer, nothing issued, and no
	// egress attempted. The sending arm has its own file,
	// `login-link-email.in-process.test.ts`, with a recording sender.
	test("with NO email egress wired, a login request answers the same, issues nothing and sends nothing", async () => {
		const challenges = harness.ctx.storage?.["login_challenges"];
		if (challenges === undefined)
			throw new Error("the login_challenges collection is not declared");
		const before = { rows: await challenges.count(), egress: harness.egressAttempts() };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				await client.requestLoginLink("shopper@example.test", {
					verifyPageUrl: "https://shop.example.test/account/verify",
				}),
			).toEqual({ ok: true });
		} finally {
			warn.mockRestore();
		}

		// No challenge nobody could receive: it would only burn a throttle slot.
		expect(await challenges.count()).toBe(before.rows);
		// And nothing reached for egress — there is no sender to reach with.
		expect(harness.egressAttempts()).toBe(before.egress);
	});
});

/**
 * THE ONE PLACE ORDER SEARCH IS NARROWER HERE, PINNED ON PURPOSE.
 *
 * ADR-0019 §6 sets the FLOOR every dialect must meet — an id PREFIX, a folded
 * buyer-ref PREFIX, or an EXACT folded line sku — and says plainly that a dialect
 * may answer MORE. Postgres did: it planned the buyer-ref half as an unanchored
 * `like '%q%'`, so a fragment from the MIDDLE of an address found the order there.
 * The document store behind this tier indexes a folded prefix key and cannot, and
 * that is a ratified divergence (2026-09-13) rather than a defect: a prefix is the
 * floor every dialect meets, and the superset is sanctioned where the dialect
 * offers it for free.
 *
 * IT COULD NOT BE A SHARED CASE, for the same reason none of the others could: the
 * two tiers produced OPPOSITE answers to the identical call, so a shared case would
 * have had to assert one of them loosely enough to accept the other. The shared
 * slice therefore asserts the floor and NEVER a negative, and each tier pinned its
 * own half — this file the miss, the HTTP file the hit. Should the document store
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
		// buyer ref, and the HTTP tier's Postgres dialect found it. Here it does not,
		// and the count agrees with the page rather than describing a set the rows do
		// not.
		const midString = await orders.listOrders({ search: "guerite@" });
		expect(midString.orders).toEqual([]);
		expect(midString.total).toBe(0);
	});
});

/**
 * FAIL-CLOSED WITH NO GATEWAY, pinned on this tier because the shared contract
 * cannot reach it any more: the tier above composes gateways, so the contract's
 * no-gateway case skips. A deployment with no Stripe secrets gets an admin orders
 * client with an EMPTY gateway map (`makeAdminClients`), and a refund must then be
 * refused — never recorded as if money had moved — even on a PAID order with a
 * real capture, where every other check would pass.
 */
describe("in-process admin refunds: NO gateway configured stays fail-closed", () => {
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
		}).order({
			orderId: "nogw-ref-1",
			buyerRef: "nogw-ref@example.test",
			captured: { amountCents: 1500, providerRef: "pi_nogw_ref_1" },
		});
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("a refund against a paid, captured order is refused 409 REFUND_GATEWAY_UNAVAILABLE and records nothing", async () => {
		// The panel is told the truth first: money is held, but nothing can move it.
		expect(await orders.getRefunds("nogw-ref-1")).toMatchObject({
			capturedTotalCents: 1500,
			remainingCents: 1500,
			refundable: false,
		});
		expect(
			await orders.refundOrder(
				"nogw-ref-1",
				{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
				{ idempotencyKey: "nogw-ref-1-a" },
			),
		).toEqual({ ok: false, status: 409, reason: "REFUND_GATEWAY_UNAVAILABLE" });
		expect(await orders.getRefunds("nogw-ref-1")).toMatchObject({
			refunds: [],
			refundedTotalCents: 0,
		});
		expect(harness.egressAttempts()).toBe(0);
	});
});

/**
 * ADR-0021 Decision 10: an overlap the admin should have refused (two zones
 * listing the same code) is resolved at runtime to the LOWEST zone id, and the
 * tie is logged — with zone ids and the matched code ONLY. No address, no cart
 * id: this log line leaves the plugin's process.
 */
describe("in-process commerce: a zone tie-break is logged with ids only", () => {
	let harness: InProcessCommerceHarness;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("two zones listing US: the lowest id prices it, and one warn carries exactly {zoneId, ambiguousWith, matchedRegion}", async () => {
		const { client, stores } = harness;
		await stores.shippingRules.createZone({ id: "tie-b", name: "B", regions: ["US"] });
		await stores.shippingRules.createZone({ id: "tie-a", name: "A", regions: ["US"] });
		await client.upsertProductCommerce(
			"prod-tie",
			{ sku: "SKU-TIE", price: { amount: 1000, currency: "USD" }, initialOnHand: 3 },
			"tie-seed",
		);
		await client.activateProductCommerce("prod-tie", "tie-publish", "2026-01-01T00:00:00.000Z");
		const { cartId } = await client.createCart("USD");
		const added = await client.addCartLine(cartId, "SKU-TIE", "prod-tie", 1, "tie-add");
		if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const quoted = await client.quoteCheckout({
				cartId,
				destination: { country: "US", region: "NY" },
			});
			expect(quoted.ok && quoted.destination.zoneId).toBe("tie-a");
			expect(warn).toHaveBeenCalledTimes(1);
			const [message, payload] = warn.mock.calls[0] ?? [];
			expect(message).toBe("[otta] shipping zone tie-break");
			expect(Object.keys(payload as object).toSorted()).toEqual([
				"ambiguousWith",
				"matchedRegion",
				"zoneId",
			]);
			expect(payload).toEqual({ zoneId: "tie-a", ambiguousWith: ["tie-b"], matchedRegion: "US" });
		} finally {
			warn.mockRestore();
		}
	});
});

/**
 * ADR-0021, the SECOND line of defence: the console validates zone regions
 * before it writes, and the rules client refuses a non-code again, so no other
 * caller of the surface can store a region checkout could never match.
 */
describe("in-process admin rules: zone regions must be ISO codes", () => {
	let harness: InProcessCommerceHarness;
	let rules: InProcessAdminRulesClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		rules = new InProcessAdminRulesClient(harness.ctx);
	}, 120_000);
	afterEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.close();
	});

	test("createZone / updateZone refuse ['UK'] and a non-array, and store codes uppercased", async () => {
		await expectRefusal(rules.createZone({ id: "z-uk", name: "UK", regions: ["UK"] }), "regions");
		expect(await harness.stores.shippingRules.getZone("z-uk")).toBeNull();

		expect(
			await rules.createZone({ id: "z-gb", name: "GB", regions: ["gb", "us-ca"] }),
		).toMatchObject({
			ok: true,
			value: { regions: ["GB", "US-CA"] },
		});
		await expectRefusal(rules.updateZone("z-gb", { name: "GB", regions: ["UK"] }), "regions");
		await expectRefusal(
			rules.updateZone("z-gb", { name: "GB", regions: "GB" as unknown as string[] }),
			"regions",
		);
		expect((await harness.stores.shippingRules.getZone("z-gb"))?.regions).toEqual(["GB", "US-CA"]);
		expect(await rules.updateZone("z-gb", { name: "GB", regions: null })).toMatchObject({
			ok: true,
		});
	});
});
