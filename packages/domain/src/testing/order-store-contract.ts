import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, reservationId, sku } from "../money/ids.js";
import type { CreateOrderInput, OrderStore } from "../ports/order-store.js";

export interface OrderStoreHarness {
	store: OrderStore;
}

export interface OrderStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");

/** A valid `CreateOrderInput` with a single physical line; overridable per case. */
function physicalInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

/**
 * The reusable `OrderStore` behavioral spec (§7): create + snapshot, get,
 * idempotent replay, insert-once snapshot immutability, and legal / illegal
 * guarded transitions. Runs against the fake first, then each DB dialect.
 */
export function orderStoreContract(
	makeHarness: () => Promise<OrderStoreHarness>,
	opts: OrderStoreContractOptions,
): void {
	describe(`orderStoreContract [${opts.dialect}]`, () => {
		test("creates a pending order with line snapshots + the order_totals stub", async () => {
			const { store } = await makeHarness();
			const { created, order } = await store.createFromCart(physicalInput());
			expect(created).toBe(true);
			expect(order.state).toBe("pending");
			expect(order.lines).toHaveLength(1);
			const line = order.lines[0]!;
			expect(line.title).toBe("Widget");
			expect(line.unitPrice).toBe(500);
			expect(line.currency).toBe("USD");
			expect(line.quantity).toBe(3);
			expect(line.reservationId).toBe("res-1");
			expect(order.totals.subtotal).toBe(1500);
			expect(order.totals.total).toBe(1500);
			expect(order.totals.discount).toBe(0);
			expect(order.totals.shipping).toBe(0);
			expect(order.totals.tax).toBe(0);
		});

		test("getById returns the created order; an unknown id is null", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			const got = await store.getById(orderId("ord-1"));
			expect(got?.id).toBe("ord-1");
			expect(await store.getById(orderId("nope"))).toBeNull();
		});

		test("replay with the same idempotency_key returns the same order (created:false)", async () => {
			const { store } = await makeHarness();
			const first = await store.createFromCart(physicalInput());
			// A replay carries a DIFFERENT fresh orderId but the same key: the store
			// must dedupe on the key and return the ORIGINAL order.
			const replay = await store.createFromCart(physicalInput({ orderId: orderId("ord-2") }));
			expect(replay.created).toBe(false);
			expect(replay.order.id).toBe(first.order.id);
			expect(replay.order.lines).toHaveLength(1);
		});

		test("getByIdempotencyKey returns the order the key minted; an unknown key is null", async () => {
			const { store } = await makeHarness();
			const { order } = await store.createFromCart(physicalInput());
			const found = await store.getByIdempotencyKey(idempotencyKey("key-1"));
			expect(found?.id).toBe(order.id);
			expect(await store.getByIdempotencyKey(idempotencyKey("key-never-used"))).toBeNull();
		});

		test("order_items are insert-once: a re-read returns the exact price/title snapshot", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			const a = await store.getById(orderId("ord-1"));
			const b = await store.getById(orderId("ord-1"));
			expect(b?.lines[0]).toEqual(a?.lines[0]);
			expect(b?.lines[0]?.unitPrice).toBe(500);
			expect(b?.lines[0]?.title).toBe("Widget");
		});

		test("markPaid transitions pending→paid once; a second markPaid is a no-op (false)", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			expect(await store.markPaid(orderId("ord-1"))).toBe(true);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("paid");
			expect(await store.markPaid(orderId("ord-1"))).toBe(false);
		});

		test("markPaid on a failed order is rejected (illegal transition → false)", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			expect(await store.markFailed(orderId("ord-1"))).toBe(true);
			expect(await store.markPaid(orderId("ord-1"))).toBe(false);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("failed");
		});

		test("expire transitions pending→expired only when hold_expires_at<=now", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			// Not yet due:
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:10:00.000Z")).toBe(false);
			// Past the deadline:
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:20:00.000Z")).toBe(true);
			expect((await store.getById(orderId("ord-1")))?.state).toBe("expired");
			// A double expire is a no-op.
			expect(await store.expire(orderId("ord-1"), "2026-07-10T00:20:00.000Z")).toBe(false);
		});

		test("listExpirable returns only pending past-TTL orders", async () => {
			const { store } = await makeHarness();
			await store.createFromCart(physicalInput());
			await store.createFromCart(
				physicalInput({
					orderId: orderId("ord-2"),
					idempotencyKey: idempotencyKey("key-2"),
					holdExpiresAt: "2026-07-10T00:20:00.000Z",
				}),
			);
			await store.markPaid(orderId("ord-1")); // paid ⇒ never expirable
			const ids = await store.listExpirable("2026-07-10T00:30:00.000Z");
			expect(ids).toEqual([orderId("ord-2")]);
		});
	});
}
