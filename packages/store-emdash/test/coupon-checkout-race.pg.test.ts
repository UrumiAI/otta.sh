/**
 * The coupon cap through CHECKOUT, under a real race (issue #627). Postgres only:
 * better-sqlite3 serializes writes in one process, so it verifies the shape and
 * never the contention.
 *
 * K shoppers, each with their own cart and checkout key, race `createOrderFromCart`
 * for the last M uses of a coupon — and every shopper double-clicks, so each key is
 * placed D times at once. The fix for #627 lets a same-key checkout past the soft
 * exhaustion check when a redemption under ITS key already holds a use; this is the
 * proof that it lets nothing else past:
 *
 * - exactly M keys hold a use, `usesCount` is M, and exactly M discounted orders
 *   exist, one per winning key;
 * - every call of a losing key is refused `COUPON_EXHAUSTED` — a refused key's
 *   recorded refusal never lets its own retry through;
 * - no call of a winning key is refused `COUPON_EXHAUSTED`, and every call of it that
 *   succeeds answers the same order. A duplicate that read the key before its order
 *   landed and the cart after it flipped answers `CART_CHECKED_OUT`, the checkout's
 *   pre-existing same-key race, which is not a coupon answer.
 *
 * The real `EmdashCouponStore` and `EmdashOrderStore` share one schema and one clock,
 * and the pool gives every caller its own connection, so the writers really contend.
 */
import { cents, createOrderFromCart, currency, idempotencyKey } from "@urumi.ai/otta-domain";
import { describe, expect, test } from "vitest";
import { COUPON_LIFECYCLE_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness } from "./coupon-harness.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { makeOrderHarness } from "./order-harness.js";

/** Uses left on the coupon. */
const M = 3;
/** Shoppers, one cart and one checkout key each. */
const K = 12;
/** Same-key calls per shopper: the double (and triple) click. */
const D = 3;
const LOOPS = 6;
const USD = currency("USD");

describe.skipIf(!PG_ENABLED)("coupon cap through checkout [postgres]", () => {
	test(`${String(K)} keys x ${String(D)} same-key calls race the last ${String(M)} uses: exactly ${String(M)} keys win, and no winner's duplicate is refused COUPON_EXHAUSTED`, async () => {
		const db = await makePgStorage(COUPON_LIFECYCLE_LAYOUT, K * D + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await db.reset();
				const orders = makeOrderHarness(db.storage);
				const coupons = makeCouponHarness(db.storage, { clock: orders.clock });
				const createDeps = { ...orders.createDeps, couponStore: coupons.store };
				await orders.seedPhysical({
					productId: "p1",
					sku: "SKU-1",
					priceCents: 1500,
					title: "Widget",
					onHand: K,
				});
				await coupons.store.create({
					id: "cpn",
					code: "SAVE5",
					type: "fixed_amount",
					amountCents: cents(500),
					rateBps: null,
					capCents: null,
					currency: USD,
					minSubtotalCents: null,
					startsAt: null,
					expiresAt: null,
					maxUses: M,
					maxUsesPerCustomer: null,
				});
				const shoppers = await Promise.all(
					Array.from({ length: K }, async (_v, i) => ({
						key: idempotencyKey(`k-${String(loop)}-${String(i)}`),
						cartId: await orders.cartWith([
							{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
						]),
					})),
				);

				// Every call at once, the duplicates of one key spread across the crowd.
				const calls = Array.from({ length: D }, () => shoppers).flat();
				const results = await Promise.all(
					calls.map(async (shopper) => ({
						shopper,
						result: await createOrderFromCart(createDeps, {
							cartId: shopper.cartId,
							idempotencyKey: shopper.key,
							buyerRef: "buyer@example.com",
							paymentMethod: "stripe",
							couponCode: "SAVE5",
						}),
					})),
				);

				const label = `loop ${String(loop)}`;
				let winners = 0;
				for (const shopper of shoppers) {
					const mine = results.filter((r) => r.shopper === shopper).map((r) => r.result);
					const holds = await coupons.store.holdsUseUnderKey("cpn", shopper.key);
					const order = await orders.store.getByIdempotencyKey(shopper.key);
					const who = `${label}, ${shopper.key}`;
					if (!holds) {
						// A losing key: refused on every call, and no order.
						expect(mine, who).toEqual(
							Array.from({ length: D }, () => ({ ok: false, reason: "COUPON_EXHAUSTED" })),
						);
						expect(order, who).toBeNull();
						continue;
					}
					winners++;
					expect(order?.totals.discount, who).toBe(500);
					const placed = mine.filter((r) => r.ok);
					expect(placed.length, `${who}: at least one call placed`).toBeGreaterThan(0);
					for (const r of placed) expect(r.order.id, who).toBe(order?.id);
					// The #627 refusal must never reach a key that holds its use.
					const refusals = mine.flatMap((r) => (r.ok ? [] : [r.reason]));
					for (const reason of refusals) expect(reason, who).toBe("CART_CHECKED_OUT");
				}
				expect(winners, `${label}: keys holding a use`).toBe(M);
				expect((await coupons.store.findById("cpn"))?.usesCount, label).toBe(M);
				expect(
					await coupons.redemptions.count({ couponId: "cpn", holdsUse: "yes" }),
					`${label}: records holding a use`,
				).toBe(M);
			}
		} finally {
			await db.close();
		}
	}, 300_000);
});
