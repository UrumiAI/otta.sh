import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { OrderId } from "../money/ids.js";
import { expireOrdersBatch, type ExpireOrdersDeps } from "../orders/expire-orders.js";
import type { Order } from "../orders/model.js";
import type { PaymentDeclineHarness } from "./payment-decline-contract.js";

const USD = currency("USD");
const HOLD_MS = 15 * 60 * 1000;
const UNIT_CENTS = 400;

export interface OrderExpiryContractOptions {
	dialect: string;
}

interface SeededLine {
	readonly sku: string;
	readonly qty: number;
}

/**
 * A pending physical order over `lines`, each line its own adopted hold, built
 * through the ports alone so every adapter family seeds it byte-identically. Each
 * sku is seeded with 10 units first (a create-if-absent, so lines sharing a sku
 * share its stock).
 */
async function seedOrder(
	h: PaymentDeclineHarness,
	n: string,
	lines: readonly SeededLine[],
): Promise<{ order: Order; holdExpiresAt: Date }> {
	const { inventoryStore, orderStore, clock } = h.settleDeps;
	const now = clock.now();
	const holdExpiresAt = new Date(now.getTime() + HOLD_MS);
	const oid = orderId(`ord-expiry-${n}`);
	const held: string[] = [];
	for (const [i, line] of lines.entries()) {
		await inventoryStore.seedOnHand(line.sku, 10);
		held.push(
			await h.holdForCheckout(
				line.sku,
				line.qty,
				`expiry-res-${n}-${String(i)}`,
				holdExpiresAt.toISOString(),
			),
		);
	}
	const subtotal = lines.reduce((sum, line) => sum + UNIT_CENTS * line.qty, 0);
	const created = await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`expiry-order-${n}`),
		holdExpiresAt: holdExpiresAt.toISOString(),
		buyerRef: `buyer-${n}@example.com`,
		paymentMethod: "stripe",
		lines: lines.map((line, i) => ({
			productId: productId(`p-expiry-${n}-${String(i)}`),
			sku: sku(line.sku),
			title: "Widget",
			unitPrice: cents(UNIT_CENTS),
			currency: USD,
			quantity: line.qty,
			fulfillmentKind: "physical" as const,
			reservationId: reservationId(held[i] ?? ""),
		})),
		totals: { subtotal: cents(subtotal), total: cents(subtotal), currency: USD },
	});
	const adopted = await inventoryStore.adoptMany({
		reservationIds: held,
		orderId: oid,
		holdExpiresAt: holdExpiresAt.toISOString(),
		now: now.toISOString(),
	});
	if (adopted.lost.length > 0) throw new Error(`seed adopt lost ${adopted.lost.join(", ")}`);
	return { order: created.order, holdExpiresAt };
}

/** Every call the expiry use-case makes on its three ports, by `port.method`. */
function countingDeps(deps: ExpireOrdersDeps): { deps: ExpireOrdersDeps; calls: string[] } {
	const calls: string[] = [];
	const wrap = <T extends object>(name: string, target: T): T =>
		new Proxy(target, {
			get(inner, prop, receiver) {
				const value: unknown = Reflect.get(inner, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					calls.push(`${name}.${String(prop)}`);
					return (value as (...a: unknown[]) => unknown).apply(inner, args);
				};
			},
		});
	return {
		calls,
		deps: {
			...deps,
			orderStore: wrap("orderStore", deps.orderStore),
			inventoryStore: wrap("inventoryStore", deps.inventoryStore),
			couponStore: wrap("couponStore", deps.couponStore),
		},
	};
}

async function onHand(h: PaymentDeclineHarness, s: string): Promise<number> {
	return h.settleDeps.inventoryStore.getOnHand(s);
}

async function stateOf(h: PaymentDeclineHarness, id: OrderId): Promise<string | undefined> {
	return (await h.settleDeps.orderStore.getById(id))?.state;
}

/**
 * THE EXPIRY UNIT'S SHAPE (QA2 M2). On the Workers Free preset one order expiry was
 * 22 storage calls — most of a 30-call tick — so a modest backlog of lapsed orders
 * expired one every three minutes and lagged by up to 43. The cost was mostly the
 * use-case re-reading the order the flip had just written and then releasing its
 * holds one line at a time, AFTER the store had already released them.
 *
 * This spec pins the shape that removed it, on every adapter family: the use-case
 * asks the store for the flip AND the expired order in one call
 * (`expireWithOrder`), never re-reads it, releases the holds in ONE batched,
 * order-scoped call only when the store has not already done so, and touches the
 * coupon store only for an order that carried a coupon. And it pins the behaviour
 * that must not move: every adopted hold returns exactly once, across SKUs.
 */
export function orderExpiryContract(
	makeHarness: () => PaymentDeclineHarness | Promise<PaymentDeclineHarness>,
	opts: OrderExpiryContractOptions,
): void {
	describe(`orderExpiryContract [${opts.dialect}]`, () => {
		test("a lapsed multi-line, multi-SKU order returns every adopted hold exactly once", async () => {
			const h = await makeHarness();
			const { order, holdExpiresAt } = await seedOrder(h, "multi", [
				{ sku: "SKU-EXP-A", qty: 2 },
				{ sku: "SKU-EXP-A", qty: 1 },
				{ sku: "SKU-EXP-B", qty: 3 },
			]);
			expect([await onHand(h, "SKU-EXP-A"), await onHand(h, "SKU-EXP-B")]).toEqual([7, 7]);
			const due = new Date(holdExpiresAt.getTime() + 60_000);

			expect(await expireOrdersBatch(h.expireDeps, due)).toEqual({ count: 1, drained: true });
			expect(await stateOf(h, order.id)).toBe("expired");
			expect([await onHand(h, "SKU-EXP-A"), await onHand(h, "SKU-EXP-B")]).toEqual([10, 10]);

			// A second sweep (or a racing one) finds nothing and returns nothing twice.
			expect(await expireOrdersBatch(h.expireDeps, due)).toEqual({ count: 0, drained: true });
			expect([await onHand(h, "SKU-EXP-A"), await onHand(h, "SKU-EXP-B")]).toEqual([10, 10]);
		});

		test("expireWithOrder answers the expired order for a WON flip, and null otherwise", async () => {
			const h = await makeHarness();
			const { order, holdExpiresAt } = await seedOrder(h, "won", [{ sku: "SKU-EXP-W", qty: 1 }]);
			const store = h.expireDeps.orderStore;
			// Not yet due: the deadline is re-checked inside the flip.
			expect(
				await store.expireWithOrder(order.id, new Date(holdExpiresAt.getTime() - 1).toISOString()),
			).toBeNull();

			const due = new Date(holdExpiresAt.getTime() + 1).toISOString();
			const won = await store.expireWithOrder(order.id, due);
			expect(won?.order.id).toBe(order.id);
			expect(won?.order.state).toBe("expired");
			expect(won?.order.lines.map((line) => line.reservationId)).toEqual(
				order.lines.map((line) => line.reservationId),
			);
			expect(typeof won?.holdsReleased).toBe("boolean");
			// Lost (already expired): exactly where `expire` answers false.
			expect(await store.expireWithOrder(order.id, due)).toBeNull();
			expect(await store.expire(order.id, due)).toBe(false);
		});

		test("one expiry is one flip call, no re-read, no per-line release, and at most ONE batched release", async () => {
			const h = await makeHarness();
			const { order, holdExpiresAt } = await seedOrder(h, "shape", [
				{ sku: "SKU-EXP-S1", qty: 1 },
				{ sku: "SKU-EXP-S2", qty: 1 },
				{ sku: "SKU-EXP-S3", qty: 2 },
			]);
			const { deps, calls } = countingDeps(h.expireDeps);
			const due = new Date(holdExpiresAt.getTime() + 60_000);

			expect((await expireOrdersBatch(deps, due)).count).toBe(1);

			expect(calls.filter((c) => c === "orderStore.expireWithOrder")).toHaveLength(1);
			expect(calls, "the flip already answered with the order").not.toContain("orderStore.getById");
			expect(calls, "never a round trip per line").not.toContain("inventoryStore.releaseAdopted");
			expect(
				calls.filter((c) => c === "inventoryStore.releaseAdoptedMany").length,
			).toBeLessThanOrEqual(1);
			// The order carried no coupon, so there is no redemption to free.
			expect(calls).not.toContain("couponStore.releaseByOrder");
			expect([
				await onHand(h, "SKU-EXP-S1"),
				await onHand(h, "SKU-EXP-S2"),
				await onHand(h, "SKU-EXP-S3"),
			]).toEqual([10, 10, 10]);
			expect(await stateOf(h, order.id)).toBe("expired");
		});

		test("a pre-listed `due` set is expired without listing again, and the bite still bounds it", async () => {
			const h = await makeHarness();
			const a = await seedOrder(h, "due-a", [{ sku: "SKU-EXP-D", qty: 1 }]);
			const b = await seedOrder(h, "due-b", [{ sku: "SKU-EXP-D", qty: 1 }]);
			const due = new Date(Math.max(a.holdExpiresAt.getTime(), b.holdExpiresAt.getTime()) + 60_000);
			const { deps, calls } = countingDeps(h.expireDeps);

			const first = await expireOrdersBatch(deps, due, { limit: 1, due: [a.order.id, b.order.id] });
			expect(first).toEqual({ count: 1, drained: false });
			expect(calls).not.toContain("orderStore.listExpirable");
			expect(await stateOf(h, a.order.id)).toBe("expired");
			expect(await stateOf(h, b.order.id)).toBe("pending");

			const second = await expireOrdersBatch(deps, due, { limit: 1, due: [b.order.id] });
			expect(second).toEqual({ count: 1, drained: true });
			expect(await onHand(h, "SKU-EXP-D")).toBe(10);
		});
	});
}
