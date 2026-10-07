/**
 * The cart aggregate's crash seams, on **real** storage.
 *
 * **What each case actually does, stated rather than implied.** Four of the seven
 * INJECT a fault with `test/helpers/fault-injection.ts` — (b), (c), (d) and (e) let
 * the real writes before the gap land and then throw where the process would have
 * died. The other three do not, because they do not need to: (a) simply stops after
 * a real `claimMutation`, which IS the whole of the first step; (f) builds the
 * terminal-record-before-prune state with one direct conditional write, the same
 * deliberate raw write `cart-fence` uses; (g) asserts a typed error, not a crash.
 * The blanket claim "every case injects" would be false, so it is not made.
 *
 * The cart is the work order's first genuine cross-aggregate edge: every mutation
 * that touches stock is a claim on the cart document, an inventory movement, and a
 * completion on the cart document, with no transaction spanning them. So the seams
 * that matter are the gaps BETWEEN those three steps, and each case here lets the
 * real writes before the gap land, throws where the process would have died, READS
 * THE DOCUMENTS BACK to prove what durably landed, and only then replays.
 *
 * Every case carries the assertion that would fail if the bracket were skipped —
 * a two-document write hidden inside one method, or a completion that is not safe
 * to re-run.
 *
 * The wrapper intercepts `compareAndSet`, `put` and `compareAndDelete`. The cart
 * store writes exclusively through `compareAndSet`, so that is sufficient today;
 * a write moved onto `updateIf` would need the helper extended, or these cases
 * would silently stop covering it.
 */
import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	HoldExpiredError,
	idempotencyKey,
	orderId as brandOrderId,
	sku,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	CARTS_COLLECTION,
	collectionOf,
	findLineByReservation,
	isReservationNotReleasableError,
	normalizeCartDoc,
	normalizeInventoryDoc,
	RESERVATION_INDEX_COLLECTION,
	type CartDoc,
	type ReservationIndexDoc,
	type StorageAccess,
} from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	InjectedCrashError,
	isUpdateWrite,
	type CallMatcher,
	withCollection,
} from "./helpers/fault-injection.js";

const USD = currency("USD");
const PAST_TTL_MS = 16 * 60 * 1000;

/**
 * Match the Nth read-modify-write on the cart collection (1-based), counted only
 * once `arm()` has been called.
 *
 * The arming gate is not decoration: the seed writes that build the pre-crash
 * state go through the same collection, so without it every case would die in its
 * own setup instead of at the seam it means to open.
 */
function armedNthUpdate(n: number): { match: CallMatcher; arm: () => void } {
	let armed = false;
	let seen = 0;
	return {
		arm() {
			armed = true;
		},
		match(call) {
			if (!armed || !isUpdateWrite(call)) return false;
			seen++;
			return seen === n;
		},
	};
}

/** A document a case depends on is absent — a broken fixture, never a condition. */
class MissingDocumentError extends Error {
	override readonly name = "MissingDocumentError";

	constructor(collection: string, id: string) {
		super(`the test fixture expected ${collection}/${id} to exist, and it does not`);
	}
}

/** The cart document, or a named failure — never a cast that hides an absent row. */
async function mustCart(h: CartHarness, cartId: string): Promise<CartDoc> {
	const doc = await h.carts.get(cartId);
	if (doc === null) throw new MissingDocumentError("carts", cartId);
	return doc;
}

/** Assert a promise died on the injected crash rather than on a real fault. */
async function expectCrash(call: Promise<unknown>): Promise<void> {
	await expect(call).rejects.toBeInstanceOf(InjectedCrashError);
}

describeEachDialect("cart crash seams", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);

	/**
	 * A harness whose CART store writes through a faulted `carts` collection while
	 * the inventory store keeps the real one — so a crash can be injected into the
	 * cart half of a bracket without touching the inventory half.
	 */
	function faulted(
		nth: number,
		mode: "after" | "instead",
	): { h: CartHarness; arm: () => void; failed: () => number } {
		const raw = collectionOf<CartDoc>(bound.storage, CARTS_COLLECTION);
		const gate = armedNthUpdate(nth);
		const failing = failCall(raw, gate.match, { mode });
		const storageForCart: StorageAccess = withCollection(
			bound.storage,
			CARTS_COLLECTION,
			failing.collection,
		);
		return {
			h: makeCartHarness(bound.storage, { storageForCart }),
			arm: gate.arm,
			failed: failing.failed,
		};
	}

	test("(a) claim written, the inventory movement never ran — the replay resumes and decrements once", async () => {
		const h = makeCartHarness(bound.storage);
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);

		// The claim is the whole of the first step, so "died before the reserve" is
		// exactly a claim with nothing after it.
		const claim = await h.deps.cartStore.claimMutation({
			key: idempotencyKey("k1"),
			cartId,
			kind: "add",
		});
		expect(claim).toEqual({ claimed: true });

		// What durably landed: an INCOMPLETE record, no line, no stock moved. The
		// incompleteness is load-bearing — it is what tells a replayer to resume,
		// and what scopes the sweep's dangling arm to cart-originated holds.
		const stored = await h.deps.cartStore.recordedMutation(idempotencyKey("k1"));
		expect(stored).toMatchObject({ cartId, kind: "add", completed: false });
		expect(await h.onHand("SKU-1")).toBe(5);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);

		const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		expect(replay.ok).toBe(true);
		expect(await h.onHand("SKU-1")).toBe(3); // one decrement, not two
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
		expect((await h.deps.cartStore.recordedMutation(idempotencyKey("k1")))?.completed).toBe(true);
	});

	test("(b) the reserve landed, the completion never did — the replay completes without a second decrement", async () => {
		// The gap between step 2 and step 3: the units are gone and the hold is live,
		// but the cart document knows only its claim.
		const { h, arm, failed } = faulted(1, "instead");
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		await h.deps.cartStore.claimMutation({ key: idempotencyKey("k1"), cartId, kind: "add" });
		const reserved = await h.deps.inventoryStore.reserve("SKU-1", 2, idempotencyKey("k1"));
		if (!reserved.ok) throw new Error("the seed reserve must succeed");

		arm();
		await expectCrash(
			h.deps.cartStore.upsertLine({
				cartId,
				sku: "SKU-1",
				productId: null,
				qty: 2,
				reservationId: reserved.reservationId,
				expiresAt: new Date(h.clock.now().getTime() + 15 * 60 * 1000).toISOString(),
				key: idempotencyKey("k1"),
			}),
		);
		expect(failed()).toBe(1);

		// What durably landed: the decrement and the hold, and NO line. A store that
		// wrote the line outside the completion would fail here.
		expect(await h.onHand("SKU-1")).toBe(3);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);

		const clean = makeCartHarness(bound.storage);
		const replay = await addLine(clean.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.line.reservationId).toBe(reserved.reservationId); // the SAME hold
		expect(await clean.onHand("SKU-1")).toBe(3); // still one decrement
		expect((await getCart(clean.deps, cartId))?.lines).toHaveLength(1);
	});

	test("(c) expireHold crashed after the once-only flip — the replay completes it and stock returns exactly once", async () => {
		const { h, arm, failed } = faulted(1, "after");
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";
		h.advance(PAST_TTL_MS);
		const now = h.clock.now().toISOString();
		const cutoff = new Date(h.clock.now().getTime() - 15 * 60 * 1000).toISOString();

		// mode "after": the flip really lands, then the process dies.
		arm();
		await expectCrash(h.deps.cartStore.expireHold(reservationId, now, cutoff));
		expect(failed()).toBe(1);

		// What durably landed: the token, and NOTHING else. The line is still there
		// and the stock is still off the shelf — which is what makes the token the
		// once-only permit rather than a record of a finished expiry.
		const parked = normalizeCartDoc(await mustCart(h, cartId));
		expect(findLineByReservation(parked, reservationId)?.expiring?.token).toEqual(
			expect.any(String),
		);
		expect(await h.onHand("SKU-1")).toBe(3);

		// Any replayer completes it — and does NOT report a win, because it did not
		// mint the token: the reclaim is counted once across every replayer.
		const clean = makeCartHarness(bound.storage);
		expect(await clean.deps.cartStore.expireHold(reservationId, now, cutoff)).toBe(false);
		expect(await clean.onHand("SKU-1")).toBe(5); // returned exactly once
		expect((await getCart(clean.deps, cartId))?.lines).toHaveLength(0);
		// And a further replay of the whole sweep changes nothing.
		clean.advance(PAST_TTL_MS);
		expect(await expireHolds(clean.deps)).toBe(0);
		expect(await clean.onHand("SKU-1")).toBe(5);
	});

	test("(d) expireHold crashed after the release — the replay removes the line once and never double-returns", async () => {
		// The second cart write is the completion, so failing it leaves the flip AND
		// the release landed: the hardest of the four, because the stock is already
		// back while the line is still visible.
		const { h, arm, failed } = faulted(2, "instead");
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";
		h.advance(PAST_TTL_MS);
		const now = h.clock.now().toISOString();
		const cutoff = new Date(h.clock.now().getTime() - 15 * 60 * 1000).toISOString();

		arm();
		await expectCrash(h.deps.cartStore.expireHold(reservationId, now, cutoff));
		expect(failed()).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5); // the release landed
		const parked = normalizeCartDoc(await mustCart(h, cartId));
		expect(findLineByReservation(parked, reservationId)?.expiring).toBeDefined();

		// The completion is re-runnable from here: the release is idempotent by the
		// reservation's own state machine, so the line goes and the stock does NOT
		// come back a second time.
		const clean = makeCartHarness(bound.storage);
		expect(await clean.deps.cartStore.expireHold(reservationId, now, cutoff)).toBe(false);
		expect(await clean.onHand("SKU-1")).toBe(5); // not 7
		expect((await getCart(clean.deps, cartId))?.lines).toHaveLength(0);
	});

	test("(e) checkout crashed after the cart flip — the flip is the whole atom and the replay is a benign false", async () => {
		const { h, arm, failed } = faulted(1, "after");
		const cartId = await createCart(h.deps, USD);

		arm();
		await expectCrash(h.deps.cartStore.checkout(cartId, brandOrderId("order-1")));
		expect(failed()).toBe(1);

		// BOTH fields landed together. A store that wrote them in two statements
		// could leave `checked_out` with a null order id here.
		const stored = await h.carts.get(cartId);
		expect({ state: stored?.state, orderId: stored?.orderId }).toEqual({
			state: "checked_out",
			orderId: "order-1",
		});

		const clean = makeCartHarness(bound.storage);
		expect(await clean.deps.cartStore.checkout(cartId, brandOrderId("order-2"))).toBe(false);
		expect((await clean.carts.get(cartId))?.orderId).toBe("order-1"); // never rewritten
	});

	test("(f) a hold left live in the aggregate after its reservation went terminal is NOT reaped", async () => {
		// The obligation the inventory tier hands every reaping path: the terminal
		// record is written BEFORE the hold is pruned, so a batch replayer (or a
		// crash) can leave a `committed` reservation whose hold still LOOKS live in
		// the aggregate. Its units are spent. Returning them would be an oversell.
		const h = makeCartHarness(bound.storage);
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";

		// Terminal written, prune not run — exactly the intermediate state the
		// ordered settle passes through, built directly rather than assumed.
		const reservations = collectionOf<ReservationIndexDoc>(
			bound.storage,
			RESERVATION_INDEX_COLLECTION,
		);
		const current = await reservations.getVersioned(reservationId);
		if (current === null) throw new Error("missing reservation index entry");
		await reservations.compareAndSet(reservationId, current.revision, {
			...current.value,
			terminalState: "committed",
		});
		const inventoryDoc = await h.inventoryDocs.get("SKU-1");
		if (inventoryDoc === null) throw new MissingDocumentError("inventory", "SKU-1");
		const stillLive = normalizeInventoryDoc(inventoryDoc).holds[idempotencyKey("k1")];
		expect(stillLive?.state).toBe("held"); // the hold really does look live

		h.advance(PAST_TTL_MS);
		const now = h.clock.now().toISOString();
		const cutoff = new Date(h.clock.now().getTime() - 15 * 60 * 1000).toISOString();
		expect(await h.deps.cartStore.expireHold(reservationId, now, cutoff)).toBe(false);
		expect(await h.onHand("SKU-1")).toBe(3); // the spent units stay spent
		// And the line survives on purpose: completing this reservation is the
		// per-id commit/prune the sweeper owns, not something the cart may force.
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
		expect(await expireHolds(h.deps)).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(3);
	});

	test("(h) a settled-but-unpruned reservation cannot be stamped, so no line may attach to it", async () => {
		// The write-side twin of (f). The terminal record lands BEFORE the prune, so a
		// committed reservation can leave a hold that still reads `held`. The deadline
		// stamp — which IS the cart's attach guard — must refuse it, or a late add
		// replay would attach a line to units that are already spent.
		const h = makeCartHarness(bound.storage);
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";

		const reservations = collectionOf<ReservationIndexDoc>(
			bound.storage,
			RESERVATION_INDEX_COLLECTION,
		);
		const current = await reservations.getVersioned(reservationId);
		if (current === null) throw new MissingDocumentError("reservation_index", reservationId);
		await reservations.compareAndSet(reservationId, current.revision, {
			...current.value,
			terminalState: "committed",
		});

		// The hold still looks live, and the stamp still refuses — the gate is the
		// terminal record, not the hold's own state field.
		const inventoryDoc = await h.inventoryDocs.get("SKU-1");
		if (inventoryDoc === null) throw new MissingDocumentError("inventory", "SKU-1");
		expect(normalizeInventoryDoc(inventoryDoc).holds[idempotencyKey("k1")]?.state).toBe("held");
		expect(await h.inventory.stampHoldDeadline(reservationId, "2026-07-10T00:30:00.000Z")).toBe(
			false,
		);

		// And therefore no line can be attached to it: a fresh-key add replay over the
		// same reservation is the port's typed `HoldExpiredError`.
		await expect(
			h.deps.cartStore.upsertLine({
				cartId,
				sku: "SKU-1",
				productId: null,
				qty: 2,
				reservationId,
				expiresAt: "2026-07-10T00:30:00.000Z",
				key: idempotencyKey("k-late"),
			}),
		).rejects.toBeInstanceOf(HoldExpiredError);
		expect(await h.onHand("SKU-1")).toBe(3); // the spent units stay spent
	});

	test("(g) a release the cart may not perform is a TYPED refusal the expiry can classify", async () => {
		// The recorded follow-up this increment carries: `release` on a hold that is
		// no longer live used to throw a bare `Error`, so the only way to classify it
		// was to match the message. `expireHold` has to classify it — a hold an order
		// already committed is not the cart's to return — so it is typed.
		const h = makeCartHarness(bound.storage);
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";
		await h.inventory.commit(reservationId);

		const err = await h.inventory.release(reservationId).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(isReservationNotReleasableError(err)).toBe(true);
		expect(err).toMatchObject({
			name: "ReservationNotReleasableError",
			code: "RESERVATION_NOT_RELEASABLE",
			reservationId,
			state: "committed",
		});
		// And the units stay consumed: a refused release moves nothing.
		expect(await h.onHand("SKU-1")).toBe(3);
	});
});
