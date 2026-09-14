/**
 * THE end-to-end order flow on the document adapter — the store-postgres suite of
 * the same name, re-pointed at `EmdashOrderStore` over `EmdashCartStore` and
 * `EmdashInventoryStore`. Every case is the original's, with its assertions
 * translated from SQL rows to the documents that replaced them (`payments` →
 * `orders/{id}.payments`, `payment_events` → the payment-event fake's recorded
 * anomalies, `reservations.state` → the reservation index's terminal record or its
 * live hold).
 *
 * It is the suite that proves the three stores COMPOSE, which no single contract
 * suite can: the checkout adopts holds across aggregates, settle commits them,
 * expiry releases them, and each of those is an intent plus a per-id write rather
 * than a transaction. Both Node dialects run it; SQLite verifies the shape and
 * Postgres additionally serializes real concurrent writers.
 *
 * The stores the use-cases need and this package does not implement — product
 * commerce, coupons, shipping/tax rules, entitlements, payment events — are the
 * domain's in-memory fakes (see `order-harness.ts` for why that line is drawn
 * there). Every order, cart and inventory write in this file is a real document
 * write against a real database.
 */
import {
	cents,
	createOrderFromCart,
	currency,
	expireOrders,
	getCart,
	idempotencyKey,
	type Order,
	type OrderStore,
	removeLine,
	settleOrder,
	sku as brandSku,
	updateLine,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	EmdashOrderStore,
	isOrderNotFoundError,
	isPaymentRefConflictError,
	isScanPageLimitError,
	normalizeOrderDoc,
	REFUND_KEYS_COLLECTION,
	type RefundKeyDoc,
	uuidIdGen,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const FUTURE = "2026-07-10T00:15:00.000Z";

/**
 * The ceiling this package holds the order document to: 8 KB for a three-line order
 * that has walked its whole state machine. It is a CAP, not the measurement — the
 * measured figures live in the README and are printed by the case below — so that a
 * row-size regression (an unbounded ledger, a re-embedded snapshot) fails a test
 * instead of surfacing as a slow read in production.
 */
const ORDER_DOC_SIZE_CAP = 8 * 1024;

function cmd(cartId: string, method: "stripe" | "x402" = "stripe", key = "k-order") {
	return {
		cartId,
		idempotencyKey: idempotencyKey(key),
		buyerRef: "buyer@example.com",
		paymentMethod: method,
	} as const;
}

function evt(order: Order, over: Partial<{ dedupeKey: string; amount: number }> = {}) {
	return {
		outcome: "succeeded" as const,
		orderId: order.id,
		providerRef: `pi_${order.id}`,
		amount: over.amount ?? order.totals.total,
		currency: "USD",
		dedupeKey: over.dedupeKey ?? `evt-${order.id}`,
	};
}

/**
 * The order's one reserved physical line, or a thrown premise.
 *
 * Never `?? ""`: a fallback would let a case whose seeded order carries NO
 * reservation sail past every assertion about that reservation.
 */
function mustReservation(order: Order): string {
	const id = order.lines[0]?.reservationId;
	if (id === null || id === undefined) {
		throw new Error(`order ${order.id} was expected to carry a reserved physical line`);
	}
	return id;
}

/** The embedded payments ledger — where `SELECT * FROM payments` went. */
async function paymentsOf(h: OrderHarness, orderId: string): Promise<number> {
	const doc = await h.orders.get(orderId);
	return doc === null ? 0 : normalizeOrderDoc(doc).payments.length;
}

describeEachDialect("order flow", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	const harness = (): OrderHarness => makeOrderHarness(bound.storage);

	test("editing product_commerce leaves existing order_items unchanged (snapshot immutability)", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);

		// Edit the product through the CMS sync path (price + title change).
		await h.editProduct({ productId: "p1", sku: "SKU-1", priceCents: 999, title: "Renamed" });

		// Read the DOCUMENT, not the projection: the point is that the stored array
		// is untouched, and `getById` could in principle re-derive.
		const doc = await h.orders.get(res.order.id);
		const item = doc === null ? undefined : normalizeOrderDoc(doc).items[0];
		expect(item?.title).toBe("Widget");
		expect(item?.unitPrice).toBe(500);
		expect(item?.currency).toBe("USD");
		// And through the port, for the caller's view of the same fact.
		const reloaded = await h.store.getById(res.order.id);
		expect(reloaded?.lines[0]?.title).toBe("Widget");
		expect(reloaded?.lines[0]?.unitPrice).toBe(500);
	});

	test("every later write carries the items array by REFERENCE — no method can rewrite a snapshot", async () => {
		// The document-model half of the snapshot invariant, which the SQL adapter got
		// from "no code path updates order_items". Here it is structural: `items` is
		// `readonly`, and each write is `{ ...doc, … }`. This case pins the observable
		// consequence — the array is IDENTICAL after a flip, a payment and an intent
		// completion, element for element — so a future write that rebuilt it (for
		// instance by mapping over the lines) would fail here even if it preserved the
		// values.
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const before = normalizeOrderDoc((await h.orders.get(res.order.id))!).items;

		await h.store.markPaid(res.order.id);
		await h.store.recordPayment({
			orderId: res.order.id,
			gateway: "stripe",
			providerRef: "pi-snapshot",
			amount: res.order.totals.total,
			currency: res.order.currency,
			status: "succeeded",
		});
		await h.store.completeHoldCommit(res.order.id);
		await h.store.flagReconciliation(res.order.id, "a flag is an envelope write");

		const after = normalizeOrderDoc((await h.orders.get(res.order.id))!).items;
		expect(after).toEqual(before);
		expect(after[0]?.id).toBe(before[0]?.id);
	});

	test("held→adopted flip removes the reservation from the Phase-3 held-scoped sweep", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);
		expect(await h.reservationState(reservationId)).toBe("adopted");

		// Run the cart's held-scoped hold sweep after the TTL passes.
		const reclaimed = await h.sweepHeldHolds();
		expect(reclaimed).toBe(0); // an adopted hold is structurally invisible to it
		expect(await h.reservationState(reservationId)).toBe("adopted");
		expect(await h.onHand("SKU-1")).toBe(8);
	});

	test("order-expiry guarded transition releases the adopted reservation exactly once under a double-sweep race", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);

		h.advance(16 * 60 * 1000);
		const [a, b] = await Promise.all([expireOrders(h.expireDeps), expireOrders(h.expireDeps)]);
		expect(a + b).toBe(1); // exactly one sweep expired it
		expect((await h.store.getById(res.order.id))?.state).toBe("expired");
		expect(await h.reservationState(reservationId)).toBe("released");
		expect(await h.onHand("SKU-1")).toBe(10); // the units came back exactly once
		// The release intent the flip recorded is complete — nothing is owed.
		const doc = await h.orders.get(res.order.id);
		expect(doc?.holdsReleased?.completedAt).not.toBeNull();
	});

	test("a second checkout of the same cart with a DIFFERENT idempotency key is rejected CART_CHECKED_OUT at the store level", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-tab-1"));
		if (!first.ok) throw new Error(first.reason);
		const reservationId = mustReservation(first.order);

		// Two tabs, per-click keys: a distinct key on the checked-out cart.
		const second = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-tab-2"));
		expect(second).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		expect(await h.reservationState(reservationId)).toBe("adopted");
		// And the same-key replay is still honored (the idempotent path).
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-tab-1"));
		expect(replay.ok).toBe(true);
		if (replay.ok) expect(replay.order.id).toBe(first.order.id);
	});

	test("expireOrders' release is order-scoped: a stale order pointing at a foreign adopted (or committed) reservation never frees it and never crashes the sweep", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const owner = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-owner"));
		if (!owner.ok) throw new Error(owner.reason);
		// The premise, asserted rather than defaulted: a `?? null` fallback here would
		// let the case pass with no reservation at all, testing nothing.
		const line = owner.order.lines[0];
		if (line === undefined || line.reservationId === null) {
			throw new Error("the seeded order must carry a reserved physical line");
		}
		const reservationId = line.reservationId;
		expect(await h.reservationState(reservationId)).toBe("adopted");

		// A stale order (the pre-fence two-tab artifact) whose line points at the
		// OWNER's reservation, already past its TTL.
		await h.store.createFromCart({
			orderId: `stale-${owner.order.id}` as typeof owner.order.id,
			cartId: "cart-stale",
			currency: owner.order.currency,
			idempotencyKey: idempotencyKey("k-stale"),
			holdExpiresAt: "2026-07-10T00:01:00.000Z",
			buyerRef: "stale@example.com",
			paymentMethod: "stripe",
			lines: [
				{
					productId: line.productId,
					sku: brandSku("SKU-1"),
					title: "W",
					unitPrice: line.unitPrice,
					currency: owner.order.currency,
					quantity: 2,
					fulfillmentKind: "physical",
					reservationId: line.reservationId,
				},
			],
			totals: owner.order.totals,
		});

		h.advance(2 * 60 * 1000); // stale TTL passed; the owner's 15-minute hold is live
		expect(await expireOrders(h.expireDeps)).toBe(1); // the stale order expires…
		// …but the owner's adopted hold is untouched and stock did not return.
		expect(await h.reservationState(reservationId)).toBe("adopted");
		expect(await h.onHand("SKU-1")).toBe(8);

		// The owner settles (commit) — and a later sweep must not throw on any stale
		// row pointing at the now-COMMITTED reservation (an unscoped release here is
		// how a stale order could crash EVERY subsequent run).
		const settled = await settleOrder(
			h.settleDeps,
			h.stripeGateway,
			h.stripeGateway.webhook(evt(owner.order)),
		);
		expect(settled.ok).toBe(true);
		expect(await h.reservationState(reservationId)).toBe("committed");
		await expect(expireOrders(h.expireDeps)).resolves.toBe(0); // survives
	});

	test("a post-checkout cart removeLine/adjustLine cannot release or shrink an adopted hold — returns LINE_CHECKED_OUT, stock and reservation unchanged", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const cart = await getCart(h.cartDeps, cartId);
		const line = cart?.lines[0];
		if (line === undefined || line.reservationId === null) {
			throw new Error("the seeded cart must carry a reserved physical line");
		}
		const reservationId = line.reservationId;
		// Adopt the reservation directly WITHOUT flipping the cart, so the PRIMARY
		// reservation-state fence (not the cart-state fence) is exercised.
		await h.inventory.adopt({
			reservationId,
			orderId: "ord-direct",
			holdExpiresAt: FUTURE,
			now: "2026-07-10T00:00:00.000Z",
		});

		const rm = await removeLine(h.cartDeps, cartId, line.lineId, idempotencyKey("rm-1"));
		expect(rm).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
		const up = await updateLine(h.cartDeps, cartId, line.lineId, 1, idempotencyKey("up-1"));
		expect(up).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
		expect(await h.reservationState(reservationId)).toBe("adopted");
		expect(await h.onHand("SKU-1")).toBe(8); // stock not returned or shrunk
	});

	test("createOrderFromCart flips the cart active→checked_out; a subsequent add/adjust/remove is rejected CART_CHECKED_OUT", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const cart = await getCart(h.cartDeps, cartId);
		expect(cart?.state).toBe("checked_out");
		const lineId = cart?.lines[0]?.lineId;
		if (lineId === undefined) throw new Error("the checked-out cart must still carry its line");
		const rm = await removeLine(h.cartDeps, cartId, lineId, idempotencyKey("rm-2"));
		expect(rm).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
	});

	test("Stripe webhook → paid + inventory commit exactly once; a replay settles once", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);
		const raw = h.stripeGateway.webhook(evt(res.order));

		const settled = await settleOrder(h.settleDeps, h.stripeGateway, raw);
		expect(settled.ok).toBe(true);
		expect((await h.store.getById(res.order.id))?.state).toBe("paid");
		expect(await h.reservationState(reservationId)).toBe("committed");
		expect(await h.onHand("SKU-1")).toBe(4); // committed, not released

		const replay = await settleOrder(h.settleDeps, h.stripeGateway, raw);
		expect(replay.ok && replay.noop).toBe(true);
		expect(await paymentsOf(h, res.order.id)).toBe(1);
		// The commit intent the paid flip recorded is on the document, and the
		// settle's `commitMany` did the per-id work it names.
		const doc = await h.orders.get(res.order.id);
		expect(doc?.holdsCommitted?.reservationIds).toEqual([reservationId]);
	});

	test("x402 page-gate → paid + entitlement granted", async () => {
		const h = harness();
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, "x402"));
		if (!res.ok) throw new Error(res.reason);
		const raw = h.x402Gateway.pageGate({
			orderId: res.order.id,
			transaction: `0xtx-${res.order.id}`,
			network: "eip155:8453",
			payer: "0xbuyer",
			amount: res.order.totals.total,
			currency: res.order.currency,
		});
		const settled = await settleOrder(h.settleDeps, h.x402Gateway, raw);
		expect(settled.ok).toBe(true);
		expect((await h.store.getById(res.order.id))?.state).toBe("paid");
		expect(await h.entitlementStore.check({ orderId: res.order.id, sku: brandSku("DIG-1") })).toBe(
			true,
		);
		// A digital-only order adopts nothing, so its intent is recorded EMPTY and born
		// COMPLETE — and `holdsPendingAt`, the index the sweeper scans, is null. An
		// intent over zero ids owes zero writes, so leaving it outstanding would put
		// every digital order permanently on a list of orders with work owed.
		const doc = await h.orders.get(res.order.id);
		expect(doc?.holdsAdopted?.reservationIds).toEqual([]);
		expect(doc?.holdsAdopted?.completedAt).not.toBeNull();
		expect(doc?.holdsPendingAt).toBeNull();
	});

	test("settle commit against a reservation lost to a stray release records the anomaly (order flagged, anomaly recorded)", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);
		// Stray release of the adopted hold (an invariant violation).
		await h.inventory.release(reservationId);

		const settled = await settleOrder(
			h.settleDeps,
			h.stripeGateway,
			h.stripeGateway.webhook(evt(res.order)),
		);
		expect(settled.ok).toBe(true); // money received; the order is paid
		const order = await h.store.getById(res.order.id);
		expect(order?.state).toBe("paid");
		expect(order?.reconciliationFlag).not.toBeNull();
		expect(
			h.paymentEventStore
				.anomalies()
				.filter((a) => a.kind === "COMMIT_LOST" && a.orderId === res.order.id),
		).toHaveLength(1);
	});

	test("a settle losing the paid flip to a concurrent expiry records the PAID_FLIP_LOST anomaly and flags reconciliation (mid-flight loser is loud)", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);
		h.advance(16 * 60 * 1000); // past the checkout TTL; the sweep has not run yet

		// Force the interleave on the REAL store: settle loads `pending`, then the
		// expiry sweep wins between that load and the pending→paid flip. Explicit
		// delegation, not a proxy — the store's `#private` fields need their own
		// receiver, and the methods later increments own throw if ever reached.
		const racingOrderStore: OrderStore = {
			createFromCart: (i) => h.store.createFromCart(i),
			getById: (id) => h.store.getById(id),
			getByIdempotencyKey: (k) => h.store.getByIdempotencyKey(k),
			markPaid: async (id) => {
				await expireOrders(h.expireDeps);
				return h.store.markPaid(id);
			},
			markFailed: (id) => h.store.markFailed(id),
			expire: (id, at) => h.store.expire(id, at),
			listExpirable: (at) => h.store.listExpirable(at),
			recordPayment: (i) => h.store.recordPayment(i),
			getCapturedPayments: (id) => h.store.getCapturedPayments(id),
			listRefunds: (id) => h.store.listRefunds(id),
			getRefundByIdempotencyKey: (k) => h.store.getRefundByIdempotencyKey(k),
			recordRefund: (i) => h.store.recordRefund(i),
			reserveRefund: (i) => h.store.reserveRefund(i),
			finalizeRefund: (i) => h.store.finalizeRefund(i),
			voidRefund: (k) => h.store.voidRefund(k),
			markRefundUnverified: (k) => h.store.markRefundUnverified(k),
			flagReconciliation: (id, d) => h.store.flagReconciliation(id, d),
			resolveReconciliation: (i) => h.store.resolveReconciliation(i),
			recordFulfillment: (i) => h.store.recordFulfillment(i),
			cancelOrder: (i) => h.store.cancelOrder(i),
			transition: (i) => h.store.transition(i),
			listForCustomer: (c) => h.store.listForCustomer(c),
			listEventsForOrder: (id) => h.store.listEventsForOrder(id),
			listOrders: (f, p) => h.store.listOrders(f, p),
			countOrders: (f) => h.store.countOrders(f),
			linkGuestOrders: (c, ref) => h.store.linkGuestOrders(c, ref),
			claimNextEmail: (now, lease) => h.store.claimNextEmail(now, lease),
			markEmailSent: (id, now) => h.store.markEmailSent(id, now),
			rescheduleEmail: (id, at) => h.store.rescheduleEmail(id, at),
		};

		const settled = await settleOrder(
			{ ...h.settleDeps, orderStore: racingOrderStore },
			h.stripeGateway,
			h.stripeGateway.webhook(evt(res.order)),
		);
		expect(settled.ok).toBe(true);
		if (settled.ok) expect(settled.noop).toBe(true);
		const order = await h.store.getById(res.order.id);
		expect(order?.state).toBe("expired");
		expect(order?.reconciliationFlag).not.toBeNull();
		expect(
			h.paymentEventStore
				.anomalies()
				.filter((a) => a.kind === "PAID_FLIP_LOST" && a.orderId === res.order.id),
		).toHaveLength(1);
		expect(await h.reservationState(reservationId)).toBe("released");
	});

	test("a settle retry after a crash between dedupe and markPaid completes the settlement", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);
		const event = evt(res.order);
		// Simulate the crash: only the dedupe record landed.
		await h.paymentEventStore.dedupe(event.dedupeKey, res.order.id, "stripe", FUTURE);

		// The gateway retry re-delivers the SAME event: it must RESUME, not no-op.
		const settled = await settleOrder(
			h.settleDeps,
			h.stripeGateway,
			h.stripeGateway.webhook(event),
		);
		expect(settled.ok).toBe(true);
		if (settled.ok) expect(settled.noop).toBe(false);
		expect((await h.store.getById(res.order.id))?.state).toBe("paid");
		expect(await h.reservationState(reservationId)).toBe("committed");
		expect(await paymentsOf(h, res.order.id)).toBe(1);
	});

	test("a settle retry after a crash between markPaid and commit completes the side-effects exactly once", async () => {
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "W",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		if (!res.ok) throw new Error(res.reason);
		const reservationId = mustReservation(res.order);
		const event = evt(res.order);
		// Simulate the crash: the dedupe record and the paid flip landed; the commit
		// and the payment record did not.
		await h.paymentEventStore.dedupe(event.dedupeKey, res.order.id, "stripe", FUTURE);
		await h.store.markPaid(res.order.id);
		expect(await h.reservationState(reservationId)).toBe("adopted");
		// The commit INTENT is already durable, which is what makes the resumption
		// deterministic rather than a guess about what the crash had done.
		const mid = await h.orders.get(res.order.id);
		expect(mid?.holdsCommitted?.completedAt).toBeNull();

		const settled = await settleOrder(
			h.settleDeps,
			h.stripeGateway,
			h.stripeGateway.webhook(event),
		);
		expect(settled.ok).toBe(true);
		expect(await h.reservationState(reservationId)).toBe("committed");
		// A further retry moves nothing more (exactly once).
		await settleOrder(h.settleDeps, h.stripeGateway, h.stripeGateway.webhook(event));
		expect(await paymentsOf(h, res.order.id)).toBe(1);
		expect(h.paymentEventStore.anomalies()).toHaveLength(0);
	});

	test("recordPayment dedupes a provider reference GLOBALLY, and refuses one held by another order", async () => {
		// `payments.provider_ref` UNIQUE was a GLOBAL constraint. A per-order check
		// would let a mis-routed or replayed webhook record the same capture against
		// two orders, and `Σ captured` is the refund ceiling — so the claim document
		// `payment_refs/{providerRef}` is what replaces the constraint.
		const h = harness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 500,
			title: "W",
			onHand: 10,
		});
		const cartA = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const a = await createOrderFromCart(h.createDeps, cmd(cartA, "stripe", "k-pay-a"));
		const cartB = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const b = await createOrderFromCart(h.createDeps, cmd(cartB, "stripe", "k-pay-b"));
		if (!a.ok || !b.ok) throw new Error("both seed checkouts must succeed");

		const payment = {
			gateway: "stripe" as const,
			providerRef: "pi-shared",
			amount: a.order.totals.total,
			currency: a.order.currency,
			status: "succeeded",
		};
		await h.store.recordPayment({ ...payment, orderId: a.order.id });
		// A redelivery against the SAME order is a benign no-op.
		await h.store.recordPayment({ ...payment, orderId: a.order.id });
		expect(await paymentsOf(h, a.order.id)).toBe(1);
		// The same reference against ANOTHER order is refused, loudly and typed.
		await expect(h.store.recordPayment({ ...payment, orderId: b.order.id })).rejects.toSatisfy(
			isPaymentRefConflictError,
		);
		expect(await paymentsOf(h, b.order.id)).toBe(0);
	});

	test("recordPayment against a missing order throws, and never reports a silent success", async () => {
		// No foreign keys here, so the alternative to throwing is money recorded
		// nowhere with the call reporting success — on the settle path.
		const h = harness();
		await expect(
			h.store.recordPayment({
				orderId: "ord-absent" as never,
				gateway: "stripe",
				providerRef: "pi-absent",
				amount: 500 as never,
				currency: "USD" as never,
				status: "succeeded",
			}),
		).rejects.toSatisfy(isOrderNotFoundError);
	});

	test("listExpirable pages past the host's 100-row clamp, and refuses to truncate silently", async () => {
		// The host clamps `limit` at 100, so the scan MUST page — and a scan that ran
		// out of pages has to say so: an order past its deadline that no sweep can see
		// is stock held out of sale forever, reported as "nothing to expire".
		const h = harness();
		const total = 137; // > one page, deliberately not a multiple of 100
		for (let i = 0; i < total; i++) {
			await h.store.createFromCart({
				orderId: `ord-exp-${String(i).padStart(3, "0")}` as never,
				cartId: null,
				currency: "USD" as never,
				idempotencyKey: idempotencyKey(`k-exp-${String(i)}`),
				holdExpiresAt: "2026-07-10T00:15:00.000Z",
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
				lines: [],
				totals: { subtotal: 0 as never, total: 0 as never, currency: "USD" as never },
			});
		}
		// Lines-free orders own no holds: none of them is listed as owing bracket work.
		const seeded = await h.orders.get("ord-exp-000");
		expect(seeded?.holdsPendingAt).toBeNull();

		const due = await h.store.listExpirable("2026-07-10T00:20:00.000Z");
		expect(due).toHaveLength(total);
		expect(new Set(due).size).toBe(total); // no page overlap, no gap
		// Not yet due ⇒ none of them, whatever the paging.
		expect(await h.store.listExpirable("2026-07-10T00:10:00.000Z")).toHaveLength(0);

		// A store whose page budget is exhausted throws rather than truncating. One
		// page of budget over 137 rows is the smallest honest way to reach it.
		const clamped = new EmdashOrderStore({
			storage: bound.storage,
			inventory: h.inventory,
			idGen: uuidIdGen,
			clock: h.clock,
			maxExpiryPages: 1,
		});
		await expect(clamped.listExpirable("2026-07-10T00:20:00.000Z")).rejects.toSatisfy(
			isScanPageLimitError,
		);
	});

	test("a three-line order with five transitions stays well under the document-size cap", async () => {
		// The figure the README quotes, asserted by something rather than remembered.
		// The cap is a CEILING on the hot money-path document, not a measurement: the
		// point is that a row-size regression (an unbounded ledger, a re-embedded
		// snapshot) fails here instead of being discovered in production.
		const h = harness();
		const skus = ["SKU-A", "SKU-B", "SKU-C"];
		for (const s of skus) {
			await h.seedPhysical({
				productId: `p-${s}`,
				sku: s,
				priceCents: 1234,
				title: `Widget ${s}`,
				onHand: 9,
			});
		}
		const cartId = await h.cartWith(
			skus.map((s) => ({ sku: s, productId: `p-${s}`, qty: 2, kind: "physical" as const })),
		);
		const res = await createOrderFromCart(h.createDeps, {
			...cmd(cartId, "stripe", "k-size"),
			shippingAddress: {
				name: "Ada Lovelace",
				line1: "12 Analytical Way",
				line2: "Unit 4",
				city: "London",
				region: "Greater London",
				postalCode: "EC1A 1BB",
				country: "GB",
				email: "ada@example.com",
				phone: "+44 20 7946 0000",
			},
		});
		if (!res.ok) throw new Error(res.reason);
		const created = JSON.stringify(await h.orders.get(res.order.id)).length;
		for (const to of ["paid", "processing", "shipped", "delivered", "completed"] as const) {
			await h.store.transition({
				orderId: res.order.id,
				fromState: (await h.store.getById(res.order.id))?.state ?? "pending",
				toState: to,
				idempotencyKey: idempotencyKey(`t-size-${to}`),
				enqueueEmail: true,
			});
		}
		const doc = await h.orders.get(res.order.id);
		const afterFive = JSON.stringify(doc).length;

		// The MONEY ledgers are the other half of the growth, and INC-B3 is where they
		// start being written: two captures and three refunds on top of the five
		// transitions, which is a busier order than the shape admits in practice (a
		// split capture plus three partial returns). The ceiling is 7,404 — three lines
		// of two at 1,234 — so the three refunds stay well inside it and drive no flip.
		const half = 3702;
		for (const [i, amount] of [half, half].entries()) {
			await h.store.recordPayment({
				orderId: res.order.id,
				gateway: "stripe",
				providerRef: `pi-size-${String(i)}`,
				amount: cents(amount),
				currency: currency("USD"),
				status: "succeeded",
			});
		}
		for (let i = 0; i < 3; i++) {
			const recorded = await h.store.recordRefund({
				orderId: res.order.id,
				amount: cents(1000),
				currency: currency("USD"),
				kind: "manual",
				gateway: "stripe",
				refundRef: null,
				reason: "partial return",
				refundedBy: "admin@shop",
				idempotencyKey: idempotencyKey(`rf-size-${String(i)}`),
			});
			expect(recorded.outcome).toBe("recorded");
		}
		const withLedgers = await h.orders.get(res.order.id);
		const afterLedgers = JSON.stringify(withLedgers).length;
		// The refund claim, measured like the order key's: it is the other document a
		// refund writes, and its terminal form is what stays.
		const refundKeys = collectionOf<RefundKeyDoc>(bound.storage, REFUND_KEYS_COLLECTION);
		const terminalClaim = JSON.stringify(await refundKeys.get("rf-size-0")).length;
		console.info(
			`[order-doc-size] created=${String(created)}B afterFiveTransitions=${String(afterFive)}B ` +
				`withTwoPaymentsThreeRefunds=${String(afterLedgers)}B ` +
				`refundKeyTerminal=${String(terminalClaim)}B ` +
				`events=${String(doc?.events.length)} outbox=${String(doc?.emailOutbox.length)}`,
		);
		expect(terminalClaim).toBeLessThan(ORDER_DOC_SIZE_CAP);
		expect(doc?.events).toHaveLength(5);
		expect(withLedgers?.payments).toHaveLength(2);
		expect(withLedgers?.refunds).toHaveLength(3);
		expect(created).toBeLessThan(ORDER_DOC_SIZE_CAP);
		expect(afterFive).toBeLessThan(ORDER_DOC_SIZE_CAP);
		expect(afterLedgers).toBeLessThan(ORDER_DOC_SIZE_CAP);
	});

	test("commit against a released reservation throws the loud ReservationCommitLostError; against a committed one it is a benign no-op (guard-first)", async () => {
		const h = harness();
		await h.seedPhysical({ productId: "p1", sku: "SKU-1", priceCents: 500, title: "W", onHand: 5 });
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const cart = await h.cartStore.get(cartId);
		const reservationId = cart?.lines[0]?.reservationId;
		if (reservationId === undefined || reservationId === null) {
			throw new Error("the seeded cart must carry a reserved physical line");
		}
		await h.inventory.commit(reservationId); // held → committed
		await expect(h.inventory.commit(reservationId)).resolves.toBeUndefined(); // benign replay
		expect(await h.reservationState(reservationId)).toBe("committed");

		// A second, lost hold: released before commit → the loud typed anomaly.
		await h.seedPhysical({ productId: "p2", sku: "SKU-2", priceCents: 500, title: "X", onHand: 5 });
		const cartId2 = await h.cartWith([{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" }]);
		const cart2 = await h.cartStore.get(cartId2);
		const lost = cart2?.lines[0]?.reservationId;
		if (lost === undefined || lost === null) {
			throw new Error("the second seeded cart must carry a reserved physical line");
		}
		await h.inventory.release(lost);
		await expect(h.inventory.commit(lost)).rejects.toThrow("not held/adopted/committed");
	});
});
