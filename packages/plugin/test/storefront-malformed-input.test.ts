/**
 * A malformed id or an over-cap quantity is a TYPED answer from the storefront
 * routes — never a thrown `CommerceInputError` that `renderGuard` turns into
 * RENDER_FAILED (QA U-6).
 *
 * The in-process client bounds every opaque id (`requireIdToken`: 1–200
 * printable ASCII, no whitespace) and every quantity (`requireQty`: at most
 * 10,000) by THROWING. The routes passed those inputs straight through, so a
 * 3,000-character order id, a sign-in link with an over-long challenge or a
 * quantity of 10,001 surfaced as RENDER_FAILED: an error-level log for what is
 * the caller's input, and on the site an outage page ("Something went wrong",
 * a 503 on the account page) where "not found" or "invalid link" was the truth.
 *
 * Each route now answers what the input means: an id that cannot exist is not
 * found; a challenge that cannot exist is an invalid link; a quantity over the
 * cap is the typed QTY_TOO_LARGE, which the site words with the limit.
 */
import {
	cents,
	currency,
	customerId,
	idempotencyKey,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IDEMPOTENCY_KEY_MAX } from "../src/commerce/commerce-input.js";
import {
	createAccountLoginVerifyHandler,
	createAccountOrderHandler,
} from "../src/storefront/account-routes.js";
import {
	createCartLineAddRouteHandler,
	createCartLineRemoveRouteHandler,
	createCartLineUpdateRouteHandler,
	createCartReadRouteHandler,
} from "../src/storefront/cart-routes.js";
import { createOrderRouteHandler } from "../src/storefront/checkout-routes.js";
import type { RouteHandler } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	const logged = errors.mock.calls.length;
	vi.restoreAllMocks();
	// The point of every case: none of these is a render failure, so none logs one.
	expect(logged).toBe(0);
});

afterAll(async () => {
	await harness?.close();
});

async function invoke<TInput>(handler: RouteHandler<TInput>, input: TInput): Promise<unknown> {
	return handler({ input, request: { method: "POST", url: "/route", headers: {} } }, harness.ctx);
}

/** Ids no store could ever have minted: over the 200-character bound, or
 *  carrying whitespace / a control character. */
const IMPOSSIBLE_IDS = ["x".repeat(3000), "has space", "tab\there"];

describe("storefront/order — the public order page", () => {
	test.each(IMPOSSIBLE_IDS)("an id that cannot exist (%#) is ORDER_NOT_FOUND", async (orderId) => {
		expect(await invoke(createOrderRouteHandler(), { orderId })).toEqual({
			ok: false,
			reason: "ORDER_NOT_FOUND",
		});
	});

	test("ANY string that cannot be an id is ORDER_NOT_FOUND — blank included; only a non-string is INVALID_INPUT", async () => {
		expect(await invoke(createOrderRouteHandler(), { orderId: "   " })).toEqual({
			ok: false,
			reason: "ORDER_NOT_FOUND",
		});
		expect(await invoke(createOrderRouteHandler(), { orderId: 42 })).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
		expect(await invoke(createOrderRouteHandler(), {})).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
	});

	test("a well-formed unknown id is ORDER_NOT_FOUND too (no regression)", async () => {
		expect(await invoke(createOrderRouteHandler(), { orderId: "no-such-order" })).toEqual({
			ok: false,
			reason: "ORDER_NOT_FOUND",
		});
	});
});

describe("storefront/account/order — the signed-in customer's order", () => {
	test.each(IMPOSSIBLE_IDS)("an id that cannot exist (%#) is NOT_FOUND", async (orderId) => {
		const session = await harness.stores.sessionStore.create(customerId("cust-1"));

		expect(
			await invoke(createAccountOrderHandler(), { sessionToken: session.token, orderId }),
		).toEqual({ ok: false, error: "NOT_FOUND" });
	});
});

describe("storefront/account/login/verify — redeeming a sign-in link", () => {
	test.each([
		["an over-long challenge", { challengeId: "c".repeat(3000), token: "t" }],
		["a challenge with whitespace", { challengeId: "a b", token: "t" }],
		["an over-long token", { challengeId: "challenge-1", token: "t".repeat(401) }],
	])("%s is an INVALID link", async (_label, input) => {
		expect(await invoke(createAccountLoginVerifyHandler(), input)).toEqual({
			ok: false,
			reason: "INVALID",
		});
	});
});

describe("storefront/cart/lines — a quantity over the 10,000 cap is QTY_TOO_LARGE", () => {
	test("add: qty 10,001 is the typed QTY_TOO_LARGE", async () => {
		const { cartId } = await harness.client.createCart();
		expect(
			await invoke(createCartLineAddRouteHandler(), {
				cartId,
				sku: "SKU-1",
				qty: 10_001,
				idempotencyKey: "k-add",
			}),
		).toEqual({ ok: false, error: "QTY_TOO_LARGE" });
	});

	test("update: qty 10,001 is the typed QTY_TOO_LARGE", async () => {
		const { cartId } = await harness.client.createCart();
		expect(
			await invoke(createCartLineUpdateRouteHandler(), {
				cartId,
				lineId: "line-1",
				qty: 10_001,
				idempotencyKey: "k-update",
			}),
		).toEqual({ ok: false, error: "QTY_TOO_LARGE" });
	});
});

/**
 * Issue #379: the cart routes' ids. The client bounds `cartId` and `lineId` as
 * opaque id tokens (`requireIdToken`) and the add's `productId` as 1–200
 * characters of ANY text (`requireBoundedProductId`) — by throwing. The routes
 * checked only "non-empty", so a tampered cookie or form field surfaced as
 * RENDER_FAILED (and an error log) instead of the route's own refusal.
 *
 * `sku` is deliberately NOT tightened: the admin saves any non-empty sku (no
 * charset, no ceiling) and the domain's `sku()` brand agrees, so an id-token
 * rule at this edge would make a legitimately-saved product un-addable. The
 * client never throws on a sku's shape either — an unresolvable one is the
 * typed SKU_MISMATCH — so there is no RENDER_FAILED to fix there.
 */
describe("storefront/cart — ids the store could never have minted are refused, never RENDER_FAILED", () => {
	/** A CMS content id is a ULID; the store's cart and line ids are UUIDs. */
	const PRODUCT_ID = "01JB7Z9QK3W8N5V2X4R6T0Y1MC";
	const SKU = "OTTA-TEE";
	/** A sku the admin accepts (non-empty, nothing else) but `isIdToken` would not. */
	const SPACED_SKU = "Blend 250g";
	const SPACED_PRODUCT_ID = "01JB7Z9QK3W8N5V2X4R6T0Y1MD";
	const OVER_LENGTH = "x".repeat(201);

	async function seedProduct(id: string, sku: string): Promise<void> {
		const commerce = harness.stores.productCommerce;
		await commerce.upsert(
			{
				productId: toProductId(id),
				sku: toSku(sku),
				price: { amount: cents(3200), currency: currency("USD") },
				title: `Product ${id}`,
			},
			idempotencyKey(`seed-${id}`),
		);
		await harness.stores.inventory.seedOnHand(toSku(sku), 5);
		await commerce.activate(
			toProductId(id),
			idempotencyKey(`pub-${id}`),
			"2026-01-01T00:00:00.000Z",
		);
	}

	/** A cart holding one priced line — the `lineId` the update/remove cases need. */
	async function cartWithLine(): Promise<{ cartId: string; lineId: string }> {
		await seedProduct(PRODUCT_ID, SKU);
		const { cartId } = await harness.client.createCart();
		const added = await harness.client.addCartLine(cartId, SKU, PRODUCT_ID, 1, "k-seed-line");
		if (!added.ok) throw new Error(`seed add refused: ${added.reason}`);
		return { cartId, lineId: added.line.lineId };
	}

	const MALFORMED_IDS: Array<[string, string]> = [
		["whitespace", "has space"],
		["a control character", "tab\there"],
		["DEL", "a\x7fb"],
		["non-ASCII", "cärt"],
		["over 200 characters", OVER_LENGTH],
	];
	/** The charset cases alone — within the length bound. */
	const CHARSET_IDS = MALFORMED_IDS.filter(([, id]) => id.length <= 200);
	/** Not an id at all: the wrong type, or blank. */
	const NOT_ID_STRINGS: Array<[string, unknown]> = [
		["a number", 42],
		["an array", ["a"]],
		["an object", { a: 1 }],
		["null", null],
		["an empty string", ""],
	];
	const ID_CASES: Array<[string, unknown]> = [...MALFORMED_IDS, ...NOT_ID_STRINGS];
	/** U+0000 — the one character Postgres text can never hold. */
	const NUL = "a\u0000b";
	/** Ill-formed text Postgres's `jsonb` cannot read back (review R3-B X1): U+0000
	 *  and either half of a surrogate pair standing alone. */
	const ILL_FORMED: Array<[string, string]> = [
		["U+0000", NUL],
		["a lone high surrogate", "a\uD800b"],
		["a lone low surrogate", "a\uDC00b"],
	];

	describe("read", () => {
		test.each(ID_CASES)("a cartId with %s is INVALID_CART_ID", async (_label, cartId) => {
			expect(await invoke(createCartReadRouteHandler(), { cartId })).toEqual({
				ok: false,
				error: "INVALID_CART_ID",
			});
		});

		test("a cartId of exactly 200 characters passes the bound — it names no cart", async () => {
			expect(await invoke(createCartReadRouteHandler(), { cartId: "c".repeat(200) })).toEqual({
				ok: false,
				reason: "CART_NOT_FOUND",
			});
		});

		test("a minted cartId is still read", async () => {
			const { cartId } = await harness.client.createCart();
			expect(await invoke(createCartReadRouteHandler(), { cartId })).toMatchObject({
				ok: true,
				cart: { cartId },
			});
		});
	});

	describe("lines/add", () => {
		test.each(ID_CASES)("a cartId with %s is INVALID_INPUT", async (_label, cartId) => {
			await seedProduct(PRODUCT_ID, SKU);
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: SKU,
					productId: PRODUCT_ID,
					qty: 1,
					idempotencyKey: "k-add",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test("a productId over 200 characters is INVALID_INPUT", async () => {
			const { cartId } = await harness.client.createCart();
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: SKU,
					productId: OVER_LENGTH,
					qty: 1,
					idempotencyKey: "k-add",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		// The add's productId has NO charset rule in the client (it was bounded as
		// text, not as a path parameter), so the edge imposes none either: an odd
		// one goes through and is refused by the sku guard as not resolving.
		test.each(CHARSET_IDS)(
			"a productId with %s is not refused at the edge — it does not resolve (SKU_MISMATCH)",
			async (_label, productId) => {
				const { cartId } = await harness.client.createCart();
				expect(
					await invoke(createCartLineAddRouteHandler(), {
						cartId,
						sku: SKU,
						productId,
						qty: 1,
						idempotencyKey: "k-add",
					}),
				).toEqual({ ok: false, reason: "SKU_MISMATCH" });
			},
		);

		test("a sku of any length or charset is not refused at the edge — an unknown one is SKU_MISMATCH", async () => {
			await seedProduct(PRODUCT_ID, SKU);
			const { cartId } = await harness.client.createCart();
			for (const [label, sku] of MALFORMED_IDS) {
				expect(
					await invoke(createCartLineAddRouteHandler(), {
						cartId,
						sku,
						productId: PRODUCT_ID,
						qty: 1,
						idempotencyKey: `k-add-${label}`,
					}),
				).toEqual({ ok: false, reason: "SKU_MISMATCH" });
			}
		});

		test("a productId of exactly 200 characters passes the bound — it does not resolve", async () => {
			const { cartId } = await harness.client.createCart();
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: SKU,
					productId: "p".repeat(200),
					qty: 1,
					idempotencyKey: "k-add-200",
				}),
			).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		});

		// U+0000 cannot be stored by Postgres at all, so a NUL that reached a store
		// read there failed as `invalid byte sequence for encoding "UTF8"` —
		// RENDER_FAILED. SQLite hides it, which is why it is refused at the edge
		// (before any read, on every dialect) rather than left to the store.
		test.each(ILL_FORMED)("a productId carrying %s is INVALID_INPUT", async (_label, bad) => {
			await seedProduct(PRODUCT_ID, SKU);
			const { cartId } = await harness.client.createCart();
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: SKU,
					productId: bad,
					qty: 1,
					idempotencyKey: "k-add-nul-pid",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test.each(
			ILL_FORMED.flatMap(([label, bad]) => [
				[label, "a bare add", bad, {}],
				[label, "an add naming a product", bad, { productId: PRODUCT_ID }],
			]),
		)("a sku carrying %s on %s is INVALID_INPUT", async (_label, _shape, bad, extra) => {
			await seedProduct(PRODUCT_ID, SKU);
			const { cartId } = await harness.client.createCart();
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: bad,
					qty: 1,
					idempotencyKey: "k-add-nul-sku",
					...extra,
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test("a sku the admin accepts with a space in it is still added", async () => {
			await seedProduct(SPACED_PRODUCT_ID, SPACED_SKU);
			const { cartId } = await harness.client.createCart();
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: SPACED_SKU,
					productId: SPACED_PRODUCT_ID,
					qty: 1,
					idempotencyKey: "k-add-spaced",
				}),
			).toMatchObject({ ok: true, line: { sku: SPACED_SKU, productId: SPACED_PRODUCT_ID } });
		});

		test("a minted cartId, a CMS productId and a seeded sku are still added", async () => {
			await seedProduct(PRODUCT_ID, SKU);
			const { cartId } = await harness.client.createCart();
			expect(
				await invoke(createCartLineAddRouteHandler(), {
					cartId,
					sku: SKU,
					productId: PRODUCT_ID,
					qty: 1,
					idempotencyKey: "k-add-ok",
				}),
			).toMatchObject({ ok: true, line: { sku: SKU, productId: PRODUCT_ID, qty: 1 } });
		});
	});

	describe("lines/update", () => {
		test.each(ID_CASES)("a cartId with %s is INVALID_INPUT", async (_label, cartId) => {
			const { lineId } = await cartWithLine();
			expect(
				await invoke(createCartLineUpdateRouteHandler(), {
					cartId,
					lineId,
					qty: 2,
					idempotencyKey: "k-update",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test.each(ID_CASES)("a lineId with %s is INVALID_INPUT", async (_label, lineId) => {
			const { cartId } = await cartWithLine();
			expect(
				await invoke(createCartLineUpdateRouteHandler(), {
					cartId,
					lineId,
					qty: 2,
					idempotencyKey: "k-update",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test("a minted cartId and lineId are still updated", async () => {
			const { cartId, lineId } = await cartWithLine();
			expect(
				await invoke(createCartLineUpdateRouteHandler(), {
					cartId,
					lineId,
					qty: 2,
					idempotencyKey: "k-update-ok",
				}),
			).toMatchObject({ ok: true, line: { lineId, qty: 2 } });
		});
	});

	describe("lines/remove", () => {
		test.each(ID_CASES)("a cartId with %s is INVALID_INPUT", async (_label, cartId) => {
			const { lineId } = await cartWithLine();
			expect(
				await invoke(createCartLineRemoveRouteHandler(), {
					cartId,
					lineId,
					idempotencyKey: "k-remove",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test.each(ID_CASES)("a lineId with %s is INVALID_INPUT", async (_label, lineId) => {
			const { cartId } = await cartWithLine();
			expect(
				await invoke(createCartLineRemoveRouteHandler(), {
					cartId,
					lineId,
					idempotencyKey: "k-remove",
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
		});

		test("a minted cartId and lineId are still removed", async () => {
			const { cartId, lineId } = await cartWithLine();
			expect(
				await invoke(createCartLineRemoveRouteHandler(), {
					cartId,
					lineId,
					idempotencyKey: "k-remove-ok",
				}),
			).toEqual({ ok: true });
		});
	});
});

describe("storefront/cart/lines — the idempotency key is bounded and storable", () => {
	const PRODUCT_ID = "01JB7Z9QK3W8N5V2X4R6T0Y1MC";
	const SKU = "OTTA-TEE";
	const BAD_KEYS: Array<[string, string]> = [
		["U+0000", "k\u0000ey"],
		["a lone high surrogate", "k\uD800ey"],
		["a lone low surrogate", "k\uDC00ey"],
		["one character over the ceiling", "k".repeat(IDEMPOTENCY_KEY_MAX + 1)],
		// Past the conditional-storage 1 MiB cap — a throw on every dialect before.
		["two megabytes", "k".repeat(2_000_000)],
	];

	async function cartWithLine(): Promise<{ cartId: string; lineId: string }> {
		const commerce = harness.stores.productCommerce;
		await commerce.upsert(
			{
				productId: toProductId(PRODUCT_ID),
				sku: toSku(SKU),
				price: { amount: cents(3200), currency: currency("USD") },
				title: "Tee",
			},
			idempotencyKey("seed-key-cases"),
		);
		await harness.stores.inventory.seedOnHand(toSku(SKU), 5);
		await commerce.activate(
			toProductId(PRODUCT_ID),
			idempotencyKey("pub-key-cases"),
			"2026-01-01T00:00:00.000Z",
		);
		const { cartId } = await harness.client.createCart();
		const added = await harness.client.addCartLine(cartId, SKU, PRODUCT_ID, 1, "k-seed");
		if (!added.ok) throw new Error(`seed add refused: ${added.reason}`);
		return { cartId, lineId: added.line.lineId };
	}

	test.each(BAD_KEYS)("add: a key with %s is INVALID_INPUT", async (_label, key) => {
		const { cartId } = await cartWithLine();
		expect(
			await invoke(createCartLineAddRouteHandler(), {
				cartId,
				sku: SKU,
				productId: PRODUCT_ID,
				qty: 1,
				idempotencyKey: key,
			}),
		).toEqual({ ok: false, error: "INVALID_INPUT" });
	});

	test.each(BAD_KEYS)("update: a key with %s is INVALID_INPUT", async (_label, key) => {
		const { cartId, lineId } = await cartWithLine();
		expect(
			await invoke(createCartLineUpdateRouteHandler(), {
				cartId,
				lineId,
				qty: 2,
				idempotencyKey: key,
			}),
		).toEqual({ ok: false, error: "INVALID_INPUT" });
	});

	test.each(BAD_KEYS)("remove: a key with %s is INVALID_INPUT", async (_label, key) => {
		const { cartId, lineId } = await cartWithLine();
		expect(
			await invoke(createCartLineRemoveRouteHandler(), { cartId, lineId, idempotencyKey: key }),
		).toEqual({ ok: false, error: "INVALID_INPUT" });
	});

	test("a key of exactly the ceiling is still accepted", async () => {
		const { cartId } = await cartWithLine();
		expect(
			await invoke(createCartLineAddRouteHandler(), {
				cartId,
				sku: SKU,
				productId: PRODUCT_ID,
				qty: 1,
				idempotencyKey: "k".repeat(IDEMPOTENCY_KEY_MAX),
			}),
		).toMatchObject({ ok: true, line: { sku: SKU, qty: 2 } });
	});
});
