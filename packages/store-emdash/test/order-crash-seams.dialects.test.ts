/**
 * The order store's crash seams, fault-injected over **real** storage.
 *
 * Every case here parks or fails ONE real write and then reads the documents back,
 * so what a replay heals is the state the store really leaves behind rather than a
 * state a mock was told to report. The seams are exactly the windows the document
 * model has, and there are eleven of them (fourteen cases — three seams are opened from
 * two sides each):
 *
 * 1. **The key claim landed, the order document did not.** The one window creation
 *    has. Any replayer finishes it from the payload the claim carries — including
 *    the line ids, which is why the payload is the whole prepared document.
 * 2. **The order document landed, the key was not promoted.** The reverse half, and
 *    the reason the promotion is LAST: a terminal key over a missing order would
 *    read as "already minted" and lose the checkout.
 * 3. **A partial `adoptMany` across three SKUs.** Cross-SKU work is N writes, not an
 *    atom; the adoption intent on the order document is what makes the partial set
 *    completable, and the per-SKU write is idempotent by reservation id.
 * 4. **A partial commit, completed by the SINGULAR `commit` per id.** `commitMany`
 *    skips an already-`committed` id (ADR-0019 §2), so re-running the batch is NOT
 *    the completion — the per-id call is.
 * 5. **The transition is one write.** Parked, the flip, the audit event and the
 *    outbox entry are ALL absent; released, all three are present. That is the
 *    atomicity statement the SQL adapter got from a transaction, and parking the
 *    single compare-and-set is a stronger check than aborting one would be.
 * 6. **Expiry crashing after the flip, and after one release.** The release intent
 *    survives the crash, and completing it returns the units EXACTLY once.
 * 7. **A refund claim landed, the order's compare-and-set did not.** The refund's
 *    own window, and the reason `refund_keys` carries the whole prepared row: the
 *    replay completes it with the SAME refund id rather than reserving twice.
 * 8. **A reserve landed, the finalize crashed** — the status-guarded finalize
 *    completes exactly once, and a void after a crashed void releases the capacity
 *    exactly once (never twice, never not at all).
 * 9. **A cancellation flipped, its release crashed.** The same shape as expiry's,
 *    through the cancel path: the intent survives and the units come back once.
 * 10. **The order document landed, its DERIVED by-sku index documents did not.** The
 *    search's line-sku arm IS those documents, so the window is "the order exists and
 *    cannot be found by the sku it bought". Any resolve of the key re-asserts them, and
 *    because each is create-if-absent on the `(sku, orderId)` pair, the heal writes one
 *    document however many times it runs.
 * 11. **The outbox entry landed, its LOCATOR did not.** The locator is a second
 *    document written after the flip, so this is the one tear the settle path has. It
 *    HEALS rather than failing: a claimed entry is in the `emailDueAt` index by
 *    construction, so one bounded walk finds it and writes the locator, and the next
 *    settle is a `get` again.
 */
import {
	cents,
	createOrderFromCart,
	currency,
	expireOrders,
	idempotencyKey,
	refundOrder,
	type Order,
	type RecordRefundInput,
} from "@otta-sh/domain";
import { buildRefundSeed, FakePaymentGateway } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import {
	collectionOf,
	INVENTORY_COLLECTION,
	normalizeOrderDoc,
	ORDER_KEYS_COLLECTION,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	ORDERS_COLLECTION,
	OUTBOX_KEYS_COLLECTION,
	REFUND_KEYS_COLLECTION,
	RESERVATION_INDEX_COLLECTION,
	type InventoryDoc,
	type OrderDoc,
	type OrderKeyDoc,
	type OrderSkuIndexDoc,
	type OutboxKeyDoc,
	type RefundKeyDoc,
	type ReservationIndexDoc,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	isUpdateWrite,
	parkCall,
	withCollection,
} from "./helpers/fault-injection.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

const KEY = idempotencyKey("k-seam");

/**
 * A matcher that fires on the Nth read-modify-write, whichever document it lands
 * on — how a PARTIAL cross-SKU set is injected without asserting the order the
 * batch happens to visit its SKUs in (which is the inventory store's business, not
 * this suite's).
 */
function nthUpdateWrite(
	n: number,
): (call: { method: string; expectedRevision?: string | null }) => boolean {
	let seen = 0;
	return (call) => {
		if (call.method !== "compareAndSet") return false;
		if (call.expectedRevision === null || call.expectedRevision === undefined) return false;
		seen++;
		return seen === n;
	};
}

/**
 * Every reservation id on an order, with the premise ENFORCED rather than defaulted:
 * a `?? ""` would let a seam whose order lost a reservation pass while injecting
 * faults against an empty id.
 */
function reservationIdsOf(order: Order): string[] {
	return order.lines.map((line) => {
		if (line.reservationId === null) {
			throw new Error(`order ${order.id} line ${line.sku} was expected to hold a reservation`);
		}
		return line.reservationId;
	});
}

/** Await a call that MUST fail with the injected crash, and nothing else. */
async function expectCrash(call: Promise<unknown>): Promise<void> {
	await expect(call).rejects.toThrow(InjectedCrashError);
}

/** The reserve command shape, with the fields every refund seam shares. */
function reserveInput(orderId: string, key: string, amount: number): RecordRefundInput {
	return {
		orderId: orderId as RecordRefundInput["orderId"],
		amount: cents(amount),
		currency: currency("USD"),
		kind: "gateway",
		gateway: "stripe",
		refundRef: null,
		reason: null,
		refundedBy: "admin",
		idempotencyKey: idempotencyKey(key),
	};
}

describeEachDialect("order crash seams", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);

	const seed = async (skus: readonly { sku: string; product: string }[], onHand = 5) => {
		const h = makeOrderHarness(bound.storage);
		for (const { sku, product } of skus) {
			await h.seedPhysical({ productId: product, sku, priceCents: 500, title: sku, onHand });
		}
		return h;
	};

	test("a key claim whose order document never landed is completed by the replay, line ids and all", async () => {
		const clean = await seed([{ sku: "SKU-1", product: "p1" }]);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const keys = collectionOf<OrderKeyDoc>(bound.storage, ORDER_KEYS_COLLECTION);

		// Fail the order document's create-if-absent, leaving only the claim.
		const crashing = failCall(orders, isClaimWrite, { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForOrders: withCollection(bound.storage, ORDERS_COLLECTION, crashing.collection),
		});
		const cartId = await clean.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		await expectCrash(
			createOrderFromCart(crashed.createDeps, {
				cartId,
				idempotencyKey: KEY,
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			}),
		);

		// The seam, read off storage rather than assumed: the claim is durable and
		// carries the payload; no order document exists yet.
		const claim = await keys.get(KEY);
		if (claim === null || claim.state !== "claimed") {
			throw new Error("the crashed create must leave a CLAIMED key carrying its payload");
		}
		const claimedId = claim.orderId;
		const carriedItemId = claim.doc.items[0]?.id;
		if (carriedItemId === undefined) throw new Error("the carried payload must hold the line");
		expect(await orders.get(claimedId)).toBeNull();

		// Any replayer completes it — same order id, same LINE id, no second mint.
		const replay = await clean.store.createFromCart({
			// A replayer legitimately arrives with a fresh candidate order id; the
			// claim's recorded id is what wins.
			orderId: claimedId as never,
			cartId,
			currency: "USD" as never,
			idempotencyKey: KEY,
			holdExpiresAt: "2026-07-10T00:15:00.000Z",
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
			lines: [],
			totals: { subtotal: 0 as never, total: 0 as never, currency: "USD" as never },
		});
		expect(replay.created).toBe(false);
		expect(replay.order.id).toBe(claimedId);
		expect(replay.order.lines[0]?.id).toBe(carriedItemId);
		// …and the key is terminal, so a third call reads the order, not the payload.
		expect((await keys.get(KEY))?.state).toBe("terminal");
	});

	test("an order document whose key was never promoted is healed by the next read, and never minted twice", async () => {
		const clean = await seed([{ sku: "SKU-1", product: "p1" }]);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const keys = collectionOf<OrderKeyDoc>(bound.storage, ORDER_KEYS_COLLECTION);

		// Fail the promotion (the only read-modify-write this store makes on a key).
		const crashing = failCall(keys, isUpdateWrite, { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForOrders: withCollection(bound.storage, ORDER_KEYS_COLLECTION, crashing.collection),
		});
		const cartId = await clean.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		await expectCrash(
			createOrderFromCart(crashed.createDeps, {
				cartId,
				idempotencyKey: KEY,
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			}),
		);

		const claim = await keys.get(KEY);
		if (claim === null) throw new Error("the crashed create must leave its key claim behind");
		expect(claim.state).toBe("claimed"); // still a claim…
		const orderId = claim.orderId;
		expect((await orders.get(orderId))?.state).toBe("pending"); // …over a real order

		// The heal path is an ordinary read.
		const healed = await clean.store.getByIdempotencyKey(KEY);
		expect(healed?.id).toBe(orderId);
		expect((await keys.get(KEY))?.state).toBe("terminal");
		// Exactly one order document exists for this key.
		const page = await orders.query({ where: { state: "pending" }, limit: 100 });
		expect(page.items.filter((row) => row.data.idempotencyKey === KEY)).toHaveLength(1);
	});

	test("a partial adoptMany across three SKUs is completed from the recorded intent", async () => {
		const skus = [
			{ sku: "SKU-A", product: "pa" },
			{ sku: "SKU-B", product: "pb" },
			{ sku: "SKU-C", product: "pc" },
		];
		const clean = await seed(skus);
		const inventory = collectionOf<InventoryDoc>(bound.storage, INVENTORY_COLLECTION);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);

		const cartId = await clean.cartWith(
			skus.map(({ sku, product }) => ({ sku, productId: product, qty: 1, kind: "physical" })),
		);
		// Fail the SECOND per-SKU adoption write, whichever sku it lands on: the
		// batch's sku order is the inventory store's business, and pinning a
		// particular sku here would assert that order rather than the partial-set
		// behaviour this case is about.
		const crashing = failCall(inventory, nthUpdateWrite(2), { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForInventory: withCollection(bound.storage, INVENTORY_COLLECTION, crashing.collection),
		});
		await expectCrash(
			createOrderFromCart(crashed.createDeps, {
				cartId,
				idempotencyKey: KEY,
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			}),
		);

		// The order is durable and the intent is OUTSTANDING — which is the whole
		// reason it is written before any per-SKU write.
		const order = await clean.store.getByIdempotencyKey(KEY);
		if (order === null) throw new Error("the crashed checkout must leave a durable order");
		const orderId = order.id;
		const before = await orders.get(orderId);
		expect(before?.holdsAdopted?.completedAt).toBeNull();
		expect(before?.holdsAdopted?.reservationIds).toHaveLength(3);
		const stateOf = async (sku: string): Promise<string | undefined> => {
			const doc = await inventory.get(sku);
			if (doc === null) throw new Error(`inventory document for ${sku} is missing`);
			return Object.values(doc.holds ?? {})[0]?.state;
		};
		const statesNow = async (): Promise<(string | undefined)[]> =>
			(await Promise.all(skus.map(({ sku }) => stateOf(sku)))).toSorted();
		// ONE sku adopted, two still held: a genuinely partial set (the crashed write
		// never landed, and the third never ran).
		expect(await statesNow()).toEqual(["adopted", "held", "held"]);

		// The completion is idempotent per id: the two already-adopted holds are
		// re-adopted as a no-op and the third catches up.
		const done = await clean.store.completeHoldAdoption(orderId as never);
		expect(done).toEqual({ completed: true, lost: [] });
		expect(await statesNow()).toEqual(["adopted", "adopted", "adopted"]);
		expect((await orders.get(orderId))?.holdsAdopted?.completedAt).not.toBeNull();
		// Running it again is a no-op — the intent is complete, nothing is owed.
		expect(await clean.store.completeHoldAdoption(orderId as never)).toEqual({
			completed: false,
			lost: [],
		});
	});

	test("a partial commit is completed by the SINGULAR commit per id, including one already committed", async () => {
		const skus = [
			{ sku: "SKU-A", product: "pa" },
			{ sku: "SKU-B", product: "pb" },
			{ sku: "SKU-C", product: "pc" },
		];
		const h = await seed(skus);
		const inventory = collectionOf<InventoryDoc>(bound.storage, INVENTORY_COLLECTION);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const cartId = await h.cartWith(
			skus.map(({ sku, product }) => ({ sku, productId: product, qty: 1, kind: "physical" })),
		);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: KEY,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);
		const ids = reservationIdsOf(res.order);

		expect(await h.store.markPaid(res.order.id)).toBe(true);
		// The intent rode the flip; nothing has been committed yet.
		expect((await orders.get(res.order.id))?.holdsCommitted?.completedAt).toBeNull();

		// Put the FIRST id into the exact state ADR-0019 §2 names: its terminal record
		// written, its hold NOT yet pruned. That is what `commitMany` skips — and
		// skipping it leaves the hold live in the aggregate forever, which is why the
		// completion must drive the singular call. Injected on the PRUNE (the inventory
		// write that follows the terminal record in `reservation_index`).
		const pruneCrash = failCall(inventory, isUpdateWrite, { mode: "instead" });
		const prunelessCommit = makeOrderHarness(bound.storage, {
			share: h.shared,
			storageForInventory: withCollection(
				bound.storage,
				INVENTORY_COLLECTION,
				pruneCrash.collection,
			),
		});
		const first = ids[0];
		if (first === undefined) throw new Error("the seeded order must carry lines");
		await expectCrash(prunelessCommit.inventory.commit(first));

		// The batch then crashes partway through, on whichever per-SKU write comes
		// second — the same order-agnostic injection the adoption seam uses.
		const crashing = failCall(inventory, nthUpdateWrite(2), { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: h.shared,
			storageForInventory: withCollection(bound.storage, INVENTORY_COLLECTION, crashing.collection),
		});
		await expectCrash(crashed.inventory.commitMany(ids));

		// READ THE PARTIAL STATE BACK — the seam is only a seam if the state it heals
		// is the state the store really left behind, not one this test assumed:
		const index = collectionOf<ReservationIndexDoc>(bound.storage, RESERVATION_INDEX_COLLECTION);
		const holdFor = async (id: string): Promise<string | undefined> => {
			const entry = await index.get(id);
			if (entry === null) throw new Error(`reservation ${id} has no index entry`);
			const doc = await inventory.get(entry.sku);
			if (doc === null) throw new Error(`inventory document for ${entry.sku} is missing`);
			return doc.holds[entry.idempotencyKey]?.reservationId;
		};
		// id[0]: terminal-committed, hold STILL LIVE (the unpruned case).
		expect((await index.get(first))?.terminalState).toBe("committed");
		expect(await holdFor(first)).toBe(first);
		// The batch wrote every terminal record it reached BEFORE pruning (that
		// ordering is the once-only rule), and its second prune died — so all three
		// reservations read `committed` while TWO holds are still live in the
		// aggregates: id[0]'s, which the batch skipped entirely, and the one whose
		// prune crashed. Live holds over spent units are exactly what a later expiry
		// path would try to return.
		const terminals = await Promise.all(
			ids.map(async (id) => (await index.get(id))?.terminalState),
		);
		expect(terminals).toEqual(["committed", "committed", "committed"]);
		const liveBefore = await Promise.all(ids.map((id) => holdFor(id)));
		expect(liveBefore.filter((held) => held !== undefined)).toHaveLength(2);

		const done = await h.store.completeHoldCommit(res.order.id);
		expect(done).toEqual({ completed: true, lost: [] });
		for (const id of ids) expect(await h.reservationState(id)).toBe("committed");
		// THE assertion that fails if the completion ever re-ran `commitMany`: every
		// hold is PRUNED. The batch `continue`s an already-committed id without
		// touching the aggregate, so both live holds above would still be sitting
		// there — live to every expiry path, over units that are already spent.
		for (const id of ids) expect(await holdFor(id)).toBeUndefined();
		// Committed units stay gone — a completion must never return them.
		for (const { sku } of skus) expect(await h.onHand(sku)).toBe(4);
		expect((await orders.get(res.order.id))?.holdsCommitted?.completedAt).not.toBeNull();
		// Every intent closed ⇒ the sweeper index no longer names the order. (The
		// adoption intent is closed stamp-only: the order is `paid`, not `pending`.)
		expect(await h.store.completeHoldAdoption(res.order.id)).toEqual({
			completed: true,
			lost: [],
		});
		expect((await orders.get(res.order.id))?.holdsPendingAt).toBeNull();
	});

	test("adopt completion on a paid order is a no-op, not a lost set", async () => {
		// The state guard, pinned from the side that would break without it. After a
		// paid order's holds are committed and pruned, `adoptMany` over the same ids
		// reports every one of them `lost` — so an unguarded completion would hand a
		// sweeper a stock anomaly that has not happened, on the happiest possible path.
		const skus = [
			{ sku: "SKU-A", product: "pa" },
			{ sku: "SKU-B", product: "pb" },
		];
		const h = await seed(skus);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const cartId = await h.cartWith(
			skus.map(({ sku, product }) => ({ sku, productId: product, qty: 1, kind: "physical" })),
		);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: KEY,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);
		const ids = reservationIdsOf(res.order);
		expect(await h.store.markPaid(res.order.id)).toBe(true);
		await h.inventory.commitMany(ids);
		for (const id of ids) expect(await h.reservationState(id)).toBe("committed");
		// What the guard is standing in front of:
		const wouldBeLost = await h.inventory.adoptMany({
			reservationIds: ids,
			orderId: res.order.id,
			holdExpiresAt: "2026-07-10T00:15:00.000Z",
			now: "2026-07-10T00:01:00.000Z",
		});
		expect(wouldBeLost.lost).toEqual(ids);

		// The completion itself: stamp-only, nothing lost, and stock untouched.
		expect(await h.store.completeHoldAdoption(res.order.id)).toEqual({
			completed: true,
			lost: [],
		});
		expect((await orders.get(res.order.id))?.holdsAdopted?.completedAt).not.toBeNull();
		for (const { sku } of skus) expect(await h.onHand(sku)).toBe(4);
	});

	test("commit completion folds an UNKNOWN reservation id into lost instead of wedging the sweeper", async () => {
		// A reservation id the order snapshot names and inventory has never heard of.
		// The singular `commit` throws `ReservationNotFoundError` for it; letting that
		// escape would make the sweeper re-read the same order forever AND abandon the
		// ids listed after it, so it folds into `lost` — the same COMMIT_LOST anomaly a
		// released hold produces, which is what a paid order with no hold IS.
		const h = await seed([{ sku: "SKU-A", product: "pa" }]);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const created = await h.store.createFromCart({
			orderId: "ord-ghost" as never,
			cartId: null,
			currency: "USD" as never,
			idempotencyKey: KEY,
			holdExpiresAt: "2026-07-10T00:15:00.000Z",
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
			lines: [
				{
					productId: "pa" as never,
					sku: "SKU-A" as never,
					title: "Widget",
					unitPrice: 500 as never,
					currency: "USD" as never,
					quantity: 1,
					fulfillmentKind: "physical",
					reservationId: "res-ghost" as never,
				},
			],
			totals: { subtotal: 500 as never, total: 500 as never, currency: "USD" as never },
		});
		expect(await h.store.markPaid(created.order.id)).toBe(true);
		expect(await h.store.completeHoldCommit(created.order.id)).toEqual({
			completed: true,
			lost: ["res-ghost"],
		});
		// The intent still CLOSES: there is no per-id work a later pass could repeat,
		// and leaving it open would keep the order in the sweeper's index forever.
		expect((await orders.get(created.order.id))?.holdsCommitted?.completedAt).not.toBeNull();
	});

	test("the flip, the audit event and the outbox entry are ONE write: parked, none of the three has landed", async () => {
		const h = await seed([{ sku: "SKU-1", product: "p1" }]);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: KEY,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);

		// Park the transition's compare-and-set — the ONE write the flip is.
		const parked = parkCall(orders, isUpdateWrite);
		const parking = makeOrderHarness(bound.storage, {
			share: h.shared,
			storageForOrders: withCollection(bound.storage, ORDERS_COLLECTION, parked.collection),
		});
		const flip = parking.store.markPaid(res.order.id);
		await parked.arrived;

		// Mid-write: the state has not moved, the audit is empty, the outbox is empty.
		// A store that wrote them separately would show one or two of the three here.
		const during = normalizeOrderDoc((await orders.get(res.order.id)) as OrderDoc);
		expect(during.state).toBe("pending");
		expect(during.events).toHaveLength(0);
		expect(during.emailOutbox).toHaveLength(0);

		parked.release();
		expect(await flip).toBe(true);
		const after = normalizeOrderDoc((await orders.get(res.order.id)) as OrderDoc);
		expect(after.state).toBe("paid");
		expect(after.events).toHaveLength(1);
		expect(after.events[0]).toMatchObject({ fromState: "pending", toState: "paid" });
		expect(after.emailOutbox.map((entry) => entry.toState)).toEqual(["paid"]);
		// The outbox once-only is per `(orderId, toState)`: a lost second flip adds
		// nothing, and neither would a second enqueue for the same target state.
		expect(await h.store.markPaid(res.order.id)).toBe(false);
		const replayed = normalizeOrderDoc((await orders.get(res.order.id)) as OrderDoc);
		expect(replayed.events).toHaveLength(1);
		expect(replayed.emailOutbox).toHaveLength(1);
	});

	test("expiry crashing after the flip leaves the release owed, and the completion returns the units exactly once", async () => {
		const skus = [
			{ sku: "SKU-A", product: "pa" },
			{ sku: "SKU-B", product: "pb" },
		];
		const clean = await seed(skus);
		const inventory = collectionOf<InventoryDoc>(bound.storage, INVENTORY_COLLECTION);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const cartId = await clean.cartWith(
			skus.map(({ sku, product }) => ({ sku, productId: product, qty: 2, kind: "physical" })),
		);
		const res = await createOrderFromCart(clean.createDeps, {
			cartId,
			idempotencyKey: KEY,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);
		expect(await clean.onHand("SKU-A")).toBe(3);

		// Crash on the FIRST release, whichever sku it is: the flip has landed and no
		// units are back anywhere.
		const crashingAll = failCall(inventory, nthUpdateWrite(1), { mode: "instead" });
		const crashedAll = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForInventory: withCollection(
				bound.storage,
				INVENTORY_COLLECTION,
				crashingAll.collection,
			),
		});
		crashedAll.advance(16 * 60 * 1000);
		// `expire` returns the FLIP's verdict, not the completion's: the flip is
		// already durable, so a failing release must not be reported as a lost race —
		// a sweep that really expired the order would otherwise look like one that did
		// not, and the next run would report 0 while the release stayed owed anyway.
		expect(await crashedAll.store.expire(res.order.id, "2026-07-10T00:20:00.000Z")).toBe(true);
		const flipped = await orders.get(res.order.id);
		expect(flipped?.state).toBe("expired");
		expect(flipped?.holdsReleased?.completedAt).toBeNull();
		// The failure is not swallowed silently — it lands on the reconciliation
		// envelope — and the OUTSTANDING intent plus its indexed `holdsPendingAt` is
		// what the sweeper actually acts on.
		expect(flipped?.reconciliationFlag).toContain("expiry released no holds");
		expect(flipped?.holdsPendingAt).not.toBeNull();
		const onHands = async (): Promise<number[]> =>
			(await Promise.all(skus.map(({ sku }) => clean.onHand(sku)))).toSorted();
		expect(await onHands()).toEqual([3, 3]);

		// Now crash AFTER one release: one sku's units come back, the other's write
		// dies.
		const crashingB = failCall(inventory, nthUpdateWrite(2), { mode: "instead" });
		const crashedB = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForInventory: withCollection(
				bound.storage,
				INVENTORY_COLLECTION,
				crashingB.collection,
			),
		});
		await expectCrash(crashedB.store.completeHoldRelease(res.order.id));
		expect(await onHands()).toEqual([3, 5]); // exactly one sku's units are back
		expect((await orders.get(res.order.id))?.holdsReleased?.completedAt).toBeNull();

		// The completion finishes the set — and does NOT return sku A's units twice.
		expect(await clean.store.completeHoldRelease(res.order.id)).toEqual({
			completed: true,
			lost: [],
		});
		expect(await onHands()).toEqual([5, 5]); // returned exactly once, never twice
		const settled = await orders.get(res.order.id);
		expect(settled?.holdsReleased?.completedAt).not.toBeNull();
		// The ADOPTION intent from creation is still open — the checkout use-case runs
		// `adoptMany` itself and never tells the store — so the index still names this
		// order. Closing it on an EXPIRED order is stamp-only: no `adoptMany`, nothing
		// reported lost, and no units re-adopted over stock that has just gone back.
		expect(settled?.holdsPendingAt).toBe(settled?.holdsAdopted?.recordedAt);
		expect(await clean.store.completeHoldAdoption(res.order.id)).toEqual({
			completed: true,
			lost: [],
		});
		const closed = await orders.get(res.order.id);
		expect(closed?.holdsAdopted?.completedAt).not.toBeNull();
		// Now every intent is closed, so the sweeper's index no longer names it.
		expect(closed?.holdsPendingAt).toBeNull();
		expect(await onHands()).toEqual([5, 5]); // and nothing was re-adopted
		// And the ordinary sweep, arriving late, finds nothing left to do.
		expect(await expireOrders(clean.expireDeps)).toBe(0);
	});
	// -- the refund seams -----------------------------------------------------

	/** A `paid` order carrying one captured payment, seeded the domain's own way. */
	const seedPaid = async (id: string, totalCents = 1000) => {
		const h = makeOrderHarness(bound.storage);
		await buildRefundSeed(h.store)({ id, totalCents, gateway: "stripe" });
		return h;
	};

	/** A twin whose ORDER-document writes crash, sharing the origin's collaborators. */
	const crashingOrders = (origin: ReturnType<typeof makeOrderHarness>) => {
		const crashing = failCall(
			collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION),
			isUpdateWrite,
			{
				mode: "instead",
			},
		);
		return makeOrderHarness(bound.storage, {
			share: origin.shared,
			storageForOrders: withCollection(bound.storage, ORDERS_COLLECTION, crashing.collection),
		});
	};

	test("a refund claim whose order write never landed is completed by the replay, refund id and all", async () => {
		const clean = await seedPaid("ord-rf-seam");
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const refundKeys = collectionOf<RefundKeyDoc>(bound.storage, REFUND_KEYS_COLLECTION);
		const key = "rf-seam";
		const input = reserveInput("ord-rf-seam", key, 400);

		// Fail the order document's read-modify-write, leaving only the claim.
		await expectCrash(crashingOrders(clean).store.reserveRefund(input));

		// Mid-protocol: the claim carries the WHOLE prepared row, and the order's
		// ledger is still empty — no capacity is held by a row that does not exist.
		const claimed = await refundKeys.get(key);
		expect(claimed?.state).toBe("claimed");
		const mintedId = claimed?.state === "claimed" ? claimed.refund.id : undefined;
		expect(mintedId).toBeTruthy();
		expect(normalizeOrderDoc((await orders.get("ord-rf-seam")) as OrderDoc).refunds).toHaveLength(
			0,
		);
		// The key answers NULL, which is what makes the use-case re-reserve rather than
		// resume — and the re-reserve is the completion.
		expect(await clean.store.getRefundByIdempotencyKey(idempotencyKey(key))).toBeNull();

		// The replay COMPLETES the claim: same refund id, one row, no double-reserve.
		const replay = await clean.store.reserveRefund(input);
		expect(replay.outcome).toBe("recorded");
		expect(replay.refund?.id, "the SAME row the claim minted").toBe(mintedId);
		const ledger = await clean.store.listRefunds(input.orderId);
		expect(ledger, "never reserved twice").toHaveLength(1);
		expect(ledger[0]?.status).toBe("reserved");
		expect((await refundKeys.get(key))?.state, "promoted once the row exists").toBe("terminal");
		// And a further replay is the benign duplicate, not a third attempt.
		expect((await clean.store.reserveRefund(input)).outcome).toBe("duplicate");
		expect(await clean.store.listRefunds(input.orderId)).toHaveLength(1);
	});

	test("a reserve whose finalize crashed is finalized exactly once by the status-guarded replay", async () => {
		const clean = await seedPaid("ord-rf-final");
		const key = "rf-final";
		const input = reserveInput("ord-rf-final", key, 400);
		expect((await clean.store.reserveRefund(input)).outcome).toBe("recorded");

		// Crash the finalize's one write. The row must still be RESERVED, holding its
		// capacity, with no provider reference stamped — a half-finalized row would be
		// money recorded as moved that never did.
		await expectCrash(
			crashingOrders(clean).store.finalizeRefund({
				idempotencyKey: idempotencyKey(key),
				refundRef: "re_crashed",
			}),
		);
		const held = await clean.store.getRefundByIdempotencyKey(idempotencyKey(key));
		expect(held?.status).toBe("reserved");
		expect(held?.refundRef).toBeNull();

		// The replay finalizes it ONCE; a second same-ref finalize is the benign
		// duplicate and writes nothing.
		const first = await clean.store.finalizeRefund({
			idempotencyKey: idempotencyKey(key),
			refundRef: "re_ok",
		});
		expect(first.found).toBe(true);
		expect(first.alreadyFinalized).toBe(false);
		const again = await clean.store.finalizeRefund({
			idempotencyKey: idempotencyKey(key),
			refundRef: "re_ok",
		});
		expect(again.found).toBe(true);
		expect(again.alreadyFinalized).toBe(true);
		const ledger = await clean.store.listRefunds(input.orderId);
		expect(ledger, "still ONE row").toHaveLength(1);
		expect(ledger[0]?.status).toBe("recorded");
		expect(ledger[0]?.refundRef).toBe("re_ok");
		// A partial refund never flips the order, so the ledger row is the whole change.
		expect((await clean.store.getById(input.orderId))?.state).toBe("paid");
	});

	test("a void whose write crashed releases the capacity exactly once on the replay", async () => {
		const clean = await seedPaid("ord-rf-void");
		const key = "rf-void";
		// The reservation holds the WHOLE ceiling, so the capacity is observable: a
		// second full refund is refused while it is held and admitted once it is not.
		expect((await clean.store.reserveRefund(reserveInput("ord-rf-void", key, 1000))).outcome).toBe(
			"recorded",
		);
		await expectCrash(crashingOrders(clean).store.voidRefund(idempotencyKey(key)));
		// Still reserved ⇒ still holding capacity: the crashed void released nothing.
		expect((await clean.store.getRefundByIdempotencyKey(idempotencyKey(key)))?.status).toBe(
			"reserved",
		);
		expect(
			(await clean.store.reserveRefund(reserveInput("ord-rf-void", "rf-void-b", 1000))).outcome,
			"held capacity still blocks a peer",
		).toBe("exceeds_ceiling");

		// The replay wins the guarded flip; a SECOND void is a 0-row no-op, so the
		// capacity is released once and not by every later caller.
		expect(await clean.store.voidRefund(idempotencyKey(key))).toBe(true);
		expect(await clean.store.voidRefund(idempotencyKey(key)), "guarded out of reserved").toBe(
			false,
		);
		const ledger = await clean.store.listRefunds(reserveInput("ord-rf-void", key, 1000).orderId);
		expect(ledger.filter((r) => r.status === "voided")).toHaveLength(1);
		// Released for real: a fresh full refund now reaches the ceiling and flips.
		const reclaim = await refundOrder(
			{ orderStore: clean.store },
			new FakePaymentGateway({ id: "stripe" }),
			{
				orderId: reserveInput("ord-rf-void", key, 1000).orderId,
				amount: cents(1000),
				currency: currency("USD"),
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-void-reclaim"),
			},
		);
		expect(reclaim.ok && reclaim.fullyRefunded).toBe(true);
	});

	test("a cancellation crashing after the flip leaves the release owed, and the completion returns the units exactly once", async () => {
		const clean = await seed([{ sku: "SKU-CX", product: "pcx" }]);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const cartId = await clean.cartWith([
			{ sku: "SKU-CX", productId: "pcx", qty: 2, kind: "physical" },
		]);
		const res = await createOrderFromCart(clean.createDeps, {
			cartId,
			idempotencyKey: KEY,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);
		expect(await clean.onHand("SKU-CX")).toBe(3);

		// Crash the INVENTORY write the release drives. The cancellation's own flip is
		// already durable, so the call must still report `cancelled` — the same rule
		// `expire` follows, for the same reason.
		const crashingInventory = failCall(
			collectionOf<InventoryDoc>(bound.storage, INVENTORY_COLLECTION),
			nthUpdateWrite(1),
			{ mode: "instead" },
		);
		const crashed = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForInventory: withCollection(
				bound.storage,
				INVENTORY_COLLECTION,
				crashingInventory.collection,
			),
		});
		const cancelled = await crashed.store.cancelOrder({
			orderId: res.order.id,
			fromState: "pending",
			reason: "out_of_stock",
			detail: null,
			cancelledBy: "ops",
			idempotencyKey: idempotencyKey("cx-seam"),
			enqueueEmail: true,
		});
		expect(cancelled.cancelled).toBe(true);
		const flipped = await orders.get(res.order.id);
		expect(flipped?.state).toBe("cancelled");
		expect(flipped?.cancellation?.reason).toBe("out_of_stock");
		// The intent is OWED, the indexed scalar makes it findable, and the failure is
		// recorded loudly rather than swallowed.
		expect(flipped?.holdsReleased?.completedAt).toBeNull();
		expect(flipped?.holdsPendingAt).not.toBeNull();
		expect(flipped?.reconciliationFlag).toContain("cancellation released no holds");
		expect(await clean.onHand("SKU-CX"), "no units back yet").toBe(3);

		// The completion returns them ONCE, and a second pass returns nothing further.
		expect(await clean.store.completeHoldRelease(res.order.id)).toEqual({
			completed: true,
			lost: [],
		});
		expect(await clean.onHand("SKU-CX")).toBe(5);
		expect(await clean.store.completeHoldRelease(res.order.id)).toEqual({
			completed: false,
			lost: [],
		});
		expect(await clean.onHand("SKU-CX"), "returned exactly once").toBe(5);
	});

	test("an order whose by-sku index documents never landed is healed by the replay, and written once", async () => {
		const clean = await seed([{ sku: "SKU-1", product: "p1" }]);
		const skuIndex = collectionOf<OrderSkuIndexDoc>(bound.storage, ORDER_SKU_INDEX_COLLECTION);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const keys = collectionOf<OrderKeyDoc>(bound.storage, ORDER_KEYS_COLLECTION);

		// Fail the DERIVED write, leaving the order document and a still-claimed key. The
		// index is written before the key is promoted precisely so this window is the one
		// the claim-completion path already heals.
		const crashing = failCall(skuIndex, isClaimWrite, { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForOrders: withCollection(
				bound.storage,
				ORDER_SKU_INDEX_COLLECTION,
				crashing.collection,
			),
		});
		const cartId = await clean.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		await expectCrash(
			createOrderFromCart(crashed.createDeps, {
				cartId,
				idempotencyKey: KEY,
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			}),
		);

		// The seam, read off storage: the order is durable, the pointer is not, so the
		// search's sku arm cannot reach an order that plainly bought the sku.
		const claim = await keys.get(KEY);
		if (claim === null) throw new Error("the crashed create must leave its key behind");
		const id = claim.orderId;
		expect(await orders.get(id)).not.toBeNull();
		expect(await skuIndex.get(orderSkuIndexId("sku-1", id))).toBeNull();
		expect((await clean.store.listOrders({ search: "SKU-1" }, { limit: 25 })).orders).toEqual([]);

		// Any resolve of the key heals it — and re-resolving writes no second document,
		// because the pair IS the id. **The heal fires only on a key REPLAY** (any path
		// through `#resolveKey`): a crashed create whose pointer never landed and whose key
		// is never replayed stays a residual for the sweeper, not something a read repairs.
		expect(await clean.store.getByIdempotencyKey(KEY)).not.toBeNull();
		expect(await skuIndex.get(orderSkuIndexId("sku-1", id))).toMatchObject({
			sku: "sku-1",
			orderId: id,
		});
		expect(await clean.store.getByIdempotencyKey(KEY)).not.toBeNull();
		expect((await skuIndex.query({ where: { sku: "sku-1" }, limit: 100 })).items).toHaveLength(1);
		const found = await clean.store.listOrders({ search: "SKU-1" }, { limit: 25 });
		expect(found.orders.map((o) => o.id)).toEqual([id]);
		expect(await clean.store.countOrders({ search: "SKU-1" })).toBe(1);
	});

	test("an outbox entry whose locator never landed is settled anyway: the walk heals it, once", async () => {
		const clean = await seed([{ sku: "SKU-1", product: "p1" }]);
		const outboxKeys = collectionOf<OutboxKeyDoc>(bound.storage, OUTBOX_KEYS_COLLECTION);
		const orders = collectionOf<OrderDoc>(bound.storage, ORDERS_COLLECTION);
		const cartId = await clean.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		const res = await createOrderFromCart(clean.createDeps, {
			cartId,
			idempotencyKey: KEY,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(res.reason);

		// Fail the LOCATOR's create-if-absent. The flip itself is a different collection,
		// so it lands: the entry exists and nothing says which order holds it.
		const crashing = failCall(outboxKeys, isClaimWrite, { mode: "instead" });
		const crashed = makeOrderHarness(bound.storage, {
			share: clean.shared,
			storageForOrders: withCollection(bound.storage, OUTBOX_KEYS_COLLECTION, crashing.collection),
		});
		await expectCrash(crashed.store.markPaid(res.order.id));

		// The seam: the flip, the audit event and the outbox entry are all durable — one
		// write — and only the bracketed locator is missing.
		const torn = normalizeOrderDoc((await orders.get(res.order.id)) as OrderDoc);
		expect(torn.state).toBe("paid");
		expect(torn.emailOutbox).toHaveLength(1);
		const entryId = torn.emailOutbox[0]?.id;
		if (entryId === undefined) throw new Error("the won flip must have enqueued an entry");
		expect(await outboxKeys.get(entryId)).toBeNull();

		// The settle path HEALS rather than failing loudly: a claimed entry is in the
		// `emailDueAt` index by construction, so one bounded walk finds it — and writes the
		// locator, so the next settle is a single `get`.
		const claimed = await clean.store.claimNextEmail(
			"2026-07-10T00:00:00.000Z",
			"2026-07-10T00:05:00.000Z",
		);
		expect(claimed?.id).toBe(entryId);
		await clean.store.markEmailSent(entryId, "2026-07-10T00:00:01.000Z");
		expect(await outboxKeys.get(entryId)).toEqual({ orderId: res.order.id });
		const settled = normalizeOrderDoc((await orders.get(res.order.id)) as OrderDoc);
		expect(settled.emailOutbox[0]?.status).toBe("sent");
		expect(settled.emailDueAt).toBeNull();
	});
});
