/**
 * `storefront/shopper-state` — the storefront header's two facts (QA U-12, U-14):
 * how many units are in the visitor's cart, and whether their session is live.
 *
 * The header asks on EVERY uncached page a shopper with a cart or a session
 * loads, so its cost is the point (review: Workers Free allows 50 D1 queries per
 * invocation). The full cart read is the wrong tool — it builds the client
 * (payment-gateway kv reads), expires holds and joins live prices. This route is
 * at most ONE cart-document read and ONE session-document read, no kv, no
 * customer read, no price join — and these cases count the reads.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	createShopperStateHandler,
	type ShopperStateResult,
} from "../src/storefront/shopper-state-route.js";
import type { PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";
import { email as toEmail } from "@otta-sh/domain";

let harness: InProcessCommerceHarness;
let seq = 0;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

/** The harness's context, with every storage and kv call counted by name. */
function countingCtx(): { ctx: PluginContext; ops: string[] } {
	const ops: string[] = [];
	const base = harness.ctx;
	const storage = new Proxy(base.storage as object, {
		get(target, collection, receiver) {
			const real = Reflect.get(target, collection, receiver) as object | undefined;
			if (real === undefined || typeof collection !== "string") return real;
			return new Proxy(real, {
				get(inner, method, innerReceiver) {
					const value = Reflect.get(inner, method, innerReceiver) as unknown;
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						ops.push(`${collection}.${String(method)}`);
						return (value as (...a: unknown[]) => unknown).apply(inner, args);
					};
				},
			});
		},
	});
	const kv = new Proxy(base.kv as object, {
		get(target, method, receiver) {
			const value = Reflect.get(target, method, receiver) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				ops.push(`kv.${String(method)}`);
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return { ctx: { ...base, storage, kv } as PluginContext, ops };
}

async function ask(input: unknown, ctx: PluginContext = harness.ctx): Promise<ShopperStateResult> {
	return (await createShopperStateHandler()(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		ctx,
	)) as ShopperStateResult;
}

async function cartWithUnits(qty: number): Promise<string> {
	seq += 1;
	const productId = `prod-shopper-${String(seq)}`;
	const sku = `SKU-SHOPPER-${String(seq)}`;
	await harness.client.upsertProductCommerce(
		productId,
		{ sku, price: { amount: 1200, currency: "USD" }, title: "Mug", initialOnHand: 10 },
		`seed-${String(seq)}`,
	);
	await harness.client.activateProductCommerce(
		productId,
		`seed-${String(seq)}-publish`,
		"2026-01-01T00:00:00.000Z",
	);
	const { cartId } = await harness.client.createCart("USD");
	if (qty > 0) {
		const added = await harness.client.addCartLine(
			cartId,
			sku,
			productId,
			qty,
			`add-${String(seq)}`,
		);
		if (!added.ok) throw new Error(`arrange: ${added.reason}`);
	}
	return cartId;
}

async function liveSession(): Promise<string> {
	seq += 1;
	const customer = await harness.stores.customerStore.create({
		email: toEmail(`shopper-${String(seq)}@example.test`),
	});
	return (await harness.stores.sessionStore.create(customer.id)).token;
}

describe("storefront/shopper-state — what the header draws", () => {
	test("a live cart's units and a live session's yes", async () => {
		const cartId = await cartWithUnits(3);
		const sessionToken = await liveSession();
		expect(await ask({ cartId, sessionToken })).toEqual({
			ok: true,
			cart: { state: "active", count: 3 },
			signedIn: true,
		});
	});

	test("an empty cart is a count of 0 — the site decides what to draw", async () => {
		expect(await ask({ cartId: await cartWithUnits(0) })).toEqual({
			ok: true,
			cart: { state: "active", count: 0 },
			signedIn: false,
		});
	});

	test("nothing, garbage or unknown ids: no cart and signed out — never an error", async () => {
		const none = { ok: true, cart: null, signedIn: false };
		expect(await ask({})).toEqual(none);
		expect(await ask({ cartId: "", sessionToken: "" })).toEqual(none);
		expect(await ask({ cartId: 42, sessionToken: 42 })).toEqual(none);
		expect(await ask({ cartId: "not an id!", sessionToken: "x".repeat(513) })).toEqual(none);
		expect(await ask({ cartId: "cart-nobody-minted", sessionToken: "forged" })).toEqual(none);
	});
});

describe("storefront/shopper-state — what it costs (pinned)", () => {
	test("cart + session: exactly one cart-document read and one session-document read; no kv, no customer, no prices", async () => {
		const cartId = await cartWithUnits(2);
		const sessionToken = await liveSession();
		const { ctx, ops } = countingCtx();
		await ask({ cartId, sessionToken }, ctx);
		expect(ops.toSorted()).toEqual(["carts.get", "sessions.get"].toSorted());
	});

	test("no cookies' worth of input: no read at all", async () => {
		const { ctx, ops } = countingCtx();
		await ask({}, ctx);
		expect(ops).toEqual([]);
	});

	test("a malformed id is dropped without a read", async () => {
		const { ctx, ops } = countingCtx();
		await ask({ cartId: "not an id!", sessionToken: "x".repeat(513) }, ctx);
		expect(ops).toEqual([]);
	});
});
