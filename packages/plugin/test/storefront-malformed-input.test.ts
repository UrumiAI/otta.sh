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
import { customerId } from "@otta-sh/domain";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createAccountLoginVerifyHandler,
	createAccountOrderHandler,
} from "../src/storefront/account-routes.js";
import {
	createCartLineAddRouteHandler,
	createCartLineUpdateRouteHandler,
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
