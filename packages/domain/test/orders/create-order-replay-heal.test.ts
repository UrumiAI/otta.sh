import {
	addLine,
	cents,
	createOrderFromCart,
	currency,
	expireHolds,
	expireOrders,
	idempotencyKey,
	removeLine,
	settleOrder,
	sku,
	type AdoptManyInput,
	type AdoptManyResult,
} from "@otta-sh/domain";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

const USD = currency("USD");
const KEY = idempotencyKey("k-replay-heal");

/**
 * The domain-side stand-in for the document store's `StorageContentionError`: a
 * hot-SKU compare-and-set that ran out of retries. Typed, retryable, nothing
 * written — so it propagates out of checkout and the client retries the SAME key.
 */
class ContentionError extends Error {
	override readonly name = "ContentionError";
	readonly retryable = true as const;
}

function cmd(cartId: string, over: Record<string, unknown> = {}) {
	return {
		cartId,
		idempotencyKey: KEY,
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe" as const,
		...over,
	};
}

/**
 * A checkout that throws AFTER its order is durable (adoption or the cart flip
 * blew up) is retried by the client under the SAME key. The I1 short-circuit finds
 * the `pending` order — and must FINISH the steps the crashed call never reached,
 * or the order is handed a payment intent while its holds are still cart-`held`
 * (reapable by the cart sweep, releasable by a line removal) and its cart is still
 * `active`: a later-paid order whose stock is gone.
 */
describe("createOrderFromCart — a same-key replay finishes an interrupted checkout", () => {
	let h: OrderHarness;

	beforeEach(async () => {
		h = makeOrderHarness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "A",
			onHand: 10,
		});
		await h.seedPhysical({
			productId: "p2",
			sku: "SKU-2",
			priceCents: 700,
			title: "B",
			onHand: 10,
		});
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 300, title: "Ebook" });
	});

	function cart(): Promise<string> {
		return h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 2, kind: "physical" },
			{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" },
		]);
	}

	/** Make the NEXT `adoptMany` throw contention without writing anything. */
	function adoptThrowsOnce(): void {
		const real = h.inventory.adoptMany.bind(h.inventory);
		let thrown = false;
		h.inventory.adoptMany = async (input: AdoptManyInput): Promise<AdoptManyResult> => {
			if (!thrown) {
				thrown = true;
				throw new ContentionError("adoptMany: hot SKU contended");
			}
			return real(input);
		};
	}

	/** Make the NEXT `cartStore.checkout` throw without flipping the cart. */
	function cartCheckoutThrowsOnce(): void {
		const real = h.cartStore.checkout.bind(h.cartStore);
		let thrown = false;
		h.cartStore.checkout = async (cartId, orderId) => {
			if (!thrown) {
				thrown = true;
				throw new ContentionError("cart checkout: contended");
			}
			return real(cartId, orderId);
		};
	}

	async function reservationIdsOf(orderId: string): Promise<string[]> {
		const order = await h.orderStore.getById(orderId as never);
		if (order === null) throw new Error("order must exist");
		return order.lines
			.map((line) => line.reservationId)
			.filter((id): id is NonNullable<typeof id> => id !== null);
	}

	test("adopt throws contention after the order is durable → same-key replay leaves every hold adopted and the cart checked out", async () => {
		const cartId = await cart();
		adoptThrowsOnce();
		await expect(createOrderFromCart(h.createDeps, cmd(cartId))).rejects.toThrow(ContentionError);

		// The seam, read back rather than assumed: a durable pending order whose holds
		// are still cart-`held`, behind a still-`active` cart.
		const stranded = await h.orderStore.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the crashed checkout must leave a durable order");
		const ids = await reservationIdsOf(stranded.id);
		expect(ids).toHaveLength(2);
		expect(ids.map((id) => h.inventory.reservationState(id))).toEqual(["held", "held"]);
		expect((await h.cartStore.get(cartId))?.state).toBe("active");

		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.id).toBe(stranded.id);
		expect(replay.intent.intentId).not.toBe("");

		expect(ids.map((id) => h.inventory.reservationState(id))).toEqual(["adopted", "adopted"]);
		const cartRow = await h.cartStore.get(cartId);
		expect({ state: cartRow?.state, orderId: cartRow?.orderId }).toEqual({
			state: "checked_out",
			orderId: stranded.id,
		});
		// Stock moved exactly once (the original reserves) — the heal re-reserves nothing.
		expect(h.inventory.onHand("SKU-1")).toBe(9);
		expect(h.inventory.onHand("SKU-2")).toBe(8);

		// The harm the heal prevents: the CART sweep past the cart hold's deadline
		// must no longer be able to return this order's units to the shelf.
		h.clock.advance(16 * 60 * 1000);
		expect(await expireHolds(h.cartDeps)).toBe(0);
		expect(ids.map((id) => h.inventory.reservationState(id))).toEqual(["adopted", "adopted"]);
		expect(h.inventory.onHand("SKU-1")).toBe(9);
	});

	test("cart checkout throws after the holds are adopted → same-key replay flips the cart and stamps the order", async () => {
		const cartId = await cart();
		cartCheckoutThrowsOnce();
		await expect(createOrderFromCart(h.createDeps, cmd(cartId))).rejects.toThrow(ContentionError);

		const stranded = await h.orderStore.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the crashed checkout must leave a durable order");
		expect((await h.cartStore.get(cartId))?.state).toBe("active");

		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.id).toBe(stranded.id);
		const cartRow = await h.cartStore.get(cartId);
		expect({ state: cartRow?.state, orderId: cartRow?.orderId }).toEqual({
			state: "checked_out",
			orderId: stranded.id,
		});
		const ids = await reservationIdsOf(stranded.id);
		expect(ids.map((id) => h.inventory.reservationState(id))).toEqual(["adopted", "adopted"]);
	});

	test("a replay whose stranded hold was reaped meanwhile is RESERVATION_LOST — no intent, coupon freed, and the order EXPIRED at once with its adopted sibling back on the shelf", async () => {
		await h.couponStore.create({
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
			maxUses: 100,
			maxUsesPerCustomer: null,
		});
		const cartId = await cart();
		adoptThrowsOnce();
		await expect(
			createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" })),
		).rejects.toThrow(ContentionError);
		expect(h.couponStore.usesCount("cpn"), "the durable order owns the redemption").toBe(1);

		// While the order sat un-adopted, the cart sweep reaped one of its holds.
		const stranded = await h.orderStore.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the crashed checkout must leave a durable order");
		const [first, second] = await reservationIdsOf(stranded.id);
		if (first === undefined || second === undefined) {
			throw new Error("the order must hold two reservations");
		}
		await h.inventory.release(first);
		expect(h.inventory.onHand("SKU-1")).toBe(10);

		const intentsBefore = h.stripeGw.intentCalls.length;
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(replay).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		expect(h.stripeGw.intentCalls.length, "no payable intent for a lost hold").toBe(intentsBefore);
		expect(h.couponStore.usesCount("cpn"), "eagerly released, as the fresh path does").toBe(0);
		// The cart is NOT flipped: this order can never be paid, so it must not
		// claim the cart (the fresh path's ordering — adopt before checkout).
		expect((await h.cartStore.get(cartId))?.state).toBe("active");
		// The order is abandoned NOW, exactly as the expiry sweep would abandon it:
		// `expired`, and the sibling this call adopted is released — its units are
		// back on sale instead of waiting out the order's TTL.
		expect((await h.orderStore.getById(stranded.id))?.state).toBe("expired");
		expect(h.inventory.reservationState(second)).toBe("released");
		expect(h.inventory.onHand("SKU-2")).toBe(10);

		// A further same-key place answers the expired order (no intent), which the
		// storefront routes to the order page and its "Start a new cart" — never
		// RESERVATION_LOST again and again until a sweep runs.
		const again = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(again.ok, JSON.stringify(again)).toBe(true);
		if (!again.ok) return;
		expect(again.order.id).toBe(stranded.id);
		expect(again.order.state).toBe("expired");
		expect(again.intent).toEqual({
			gateway: "stripe",
			intentId: "",
			clientAction: { kind: "none" },
		});
		expect(h.stripeGw.intentCalls.length).toBe(intentsBefore);
		expect(h.couponStore.usesCount("cpn"), "never released twice").toBe(0);
	});

	test("buyer journey: a checkout that ended RESERVATION_LOST is not a dead end — the replay (even after re-adding the item) lands on the expired order, and a NEW cart checks out and pays", async () => {
		const cartId = await cart();
		const row = await h.cartStore.get(cartId);
		const held = row?.lines.find((line) => line.reservationId !== null)?.reservationId;
		if (held === undefined || held === null) throw new Error("the cart must hold a reservation");
		// The buyer sat on the form past the hold's deadline; the sweep reaped it.
		await h.inventory.release(held);

		const lost = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(lost).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		const order = await h.orderStore.getByIdempotencyKey(KEY);
		if (order === null) throw new Error("the lost checkout minted a durable order");
		expect(order.state).toBe("expired");
		expect(await expireOrders(h.expireDeps, new Date("2027-01-01T00:00:00.000Z"))).toBe(0);

		// "Review your cart and try again": the buyer removes the lapsed line and
		// re-adds the item (a FRESH reservation), then places again from the same
		// cart — under the same fixed key.
		const lapsed = row?.lines.find((line) => line.reservationId === held);
		if (lapsed === undefined) throw new Error("the lapsed line must be on the cart");
		expect(await removeLine(h.cartDeps, cartId, lapsed.lineId, idempotencyKey("remove-1"))).toEqual(
			{ ok: true },
		);
		const readd = await addLine(
			h.cartDeps,
			cartId,
			sku("SKU-1"),
			"p1",
			1,
			idempotencyKey("readd-1"),
			"physical",
		);
		expect(readd.ok, JSON.stringify(readd)).toBe(true);
		const retry = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(retry.ok, JSON.stringify(retry)).toBe(true);
		if (!retry.ok) return;
		expect(retry.order.state).toBe("expired");
		expect(retry.intent.clientAction).toEqual({ kind: "none" });

		// The order page's "Start a new cart": a new cart has a new checkout key.
		const fresh = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const placed = await createOrderFromCart(h.createDeps, {
			...cmd(fresh),
			idempotencyKey: idempotencyKey(`checkout:${fresh}`),
		});
		expect(placed.ok, JSON.stringify(placed)).toBe(true);
		if (!placed.ok) return;
		expect(placed.intent.intentId).not.toBe("");
		await settle(placed.order.id, placed.order.totals.total);
		expect((await h.orderStore.getById(placed.order.id))?.state).toBe("paid");
	});

	test("a replay racing EXPIRY (swept between its I1 read and its adopt) never adopts for the dead order — stock back on sale, no intent, cart untouched", async () => {
		const cartId = await cart();
		adoptThrowsOnce();
		await expect(createOrderFromCart(h.createDeps, cmd(cartId))).rejects.toThrow(ContentionError);
		const stranded = await h.orderStore.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the crashed checkout must leave a durable order");
		const ids = await reservationIdsOf(stranded.id);

		// The replay reads the order `pending`; the order sweep then expires it
		// before the replay's adoption runs. Its `releaseAdopted` finds the holds
		// still cart-`held` — a no-op — so only the replay itself can undo them.
		const real = h.orderStore.getByIdempotencyKey.bind(h.orderStore);
		h.orderStore.getByIdempotencyKey = async (key) => {
			const stale = await real(key);
			if (stale !== null && stale.state === "pending") {
				expect(await expireOrders(h.expireDeps, new Date(stale.holdExpiresAt))).toBe(1);
			}
			return stale;
		};
		const intentsBefore = h.stripeGw.intentCalls.length;
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));

		expect(replay.ok, JSON.stringify(replay)).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.state).toBe("expired");
		expect(replay.intent).toEqual({
			gateway: "stripe",
			intentId: "",
			clientAction: { kind: "none" },
		});
		expect(h.stripeGw.intentCalls.length).toBe(intentsBefore);
		expect(ids.map((id) => h.inventory.reservationState(id))).toEqual(["released", "released"]);
		expect(h.inventory.onHand("SKU-1")).toBe(10);
		expect(h.inventory.onHand("SKU-2")).toBe(10);
		const cartRow = await h.cartStore.get(cartId);
		expect({ state: cartRow?.state, orderId: cartRow?.orderId }).toEqual({
			state: "active",
			orderId: null,
		});
	});

	test("a replay of a COMPLETED checkout is unchanged: same order, holds still adopted, cart still stamped", async () => {
		const cartId = await cart();
		const first = await createOrderFromCart(h.createDeps, cmd(cartId));
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(first.ok && replay.ok).toBe(true);
		if (!first.ok || !replay.ok) return;
		expect(replay.order.id).toBe(first.order.id);
		const ids = await reservationIdsOf(first.order.id);
		expect(ids.map((id) => h.inventory.reservationState(id))).toEqual(["adopted", "adopted"]);
		expect((await h.cartStore.get(cartId))?.orderId).toBe(first.order.id);
	});

	/**
	 * Settle the order (the Stripe webhook): `markPaid`, then `commitMany` — after
	 * which every hold is `committed`, so an adoption racing it classifies `lost`.
	 */
	async function settle(orderId: string, total: number): Promise<void> {
		const res = await settleOrder(
			h.settleDeps,
			h.stripeGw,
			h.stripeGw.webhook({
				outcome: "succeeded",
				orderId,
				providerRef: "pi_race",
				amount: total,
				currency: "USD",
				dedupeKey: "evt-race",
			}),
		);
		if (!res.ok) throw new Error(`settle failed: ${JSON.stringify(res)}`);
	}

	async function seedSave5(): Promise<void> {
		await h.couponStore.create({
			id: "cpn5",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 1,
			maxUsesPerCustomer: null,
		});
	}

	test("a replay racing SETTLE (paid between its I1 read and its adopt) returns the paid order — never RESERVATION_LOST, never a coupon release", async () => {
		await seedSave5();
		const cartId = await cart();
		const first = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		if (!first.ok) throw new Error(`checkout failed: ${first.reason}`);
		expect(h.couponStore.usesCount("cpn5")).toBe(1);

		// The replay reads the order `pending`; the webhook settles it before the
		// replay's adoption runs, so that adoption sees `committed` holds.
		const real = h.orderStore.getByIdempotencyKey.bind(h.orderStore);
		h.orderStore.getByIdempotencyKey = async (key) => {
			const stale = await real(key);
			if (stale !== null) await settle(stale.id, stale.totals.total);
			return stale;
		};
		const intentsBefore = h.stripeGw.intentCalls.length;
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));

		expect(replay.ok, JSON.stringify(replay)).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.id).toBe(first.order.id);
		expect(replay.order.state).toBe("paid");
		// Exactly the non-pending I1 short-circuit's shape: no intent minted.
		expect(replay.intent).toEqual({
			gateway: "stripe",
			intentId: "",
			clientAction: { kind: "none" },
		});
		expect(h.stripeGw.intentCalls.length).toBe(intentsBefore);
		expect(h.couponStore.usesCount("cpn5"), "a PAID order keeps its coupon use").toBe(1);
		expect(h.couponStore.redemptionCount("cpn5")).toBe(1);
	});

	test("the FRESH path's adoption racing a settle (paid via a concurrent same-key replay's intent) keeps the coupon and reports the paid order", async () => {
		await seedSave5();
		const cartId = await cart();
		// A concurrent same-key replay adopted the holds, minted the intent, and the
		// buyer paid — all before this call's own adoption ran.
		const realAdopt = h.inventory.adoptMany.bind(h.inventory);
		let raced = false;
		h.inventory.adoptMany = async (input: AdoptManyInput): Promise<AdoptManyResult> => {
			if (!raced) {
				raced = true;
				await realAdopt(input);
				const order = await h.orderStore.getById(input.orderId as never);
				if (order === null) throw new Error("the order must be durable before adoption");
				await settle(order.id, order.totals.total);
			}
			return realAdopt(input);
		};
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));

		expect(res.ok, JSON.stringify(res)).toBe(true);
		if (!res.ok) return;
		expect(res.order.state).toBe("paid");
		expect(res.intent).toEqual({ gateway: "stripe", intentId: "", clientAction: { kind: "none" } });
		expect(h.couponStore.usesCount("cpn5"), "a PAID order keeps its coupon use").toBe(1);
		expect(h.couponStore.redemptionCount("cpn5")).toBe(1);
	});

	/** A cart whose FIRST physical hold the cart sweep reaped before checkout. */
	async function cartWithReapedHold(): Promise<{
		cartId: string;
		reaped: string;
		sibling: string;
	}> {
		const cartId = await cart();
		const held = (await h.cartStore.get(cartId))?.lines
			.map((line) => line.reservationId)
			.filter((id): id is string => id !== null);
		const [reaped, sibling] = held ?? [];
		if (reaped === undefined || sibling === undefined) {
			throw new Error("the cart must hold two reservations");
		}
		await h.inventory.release(reaped);
		return { cartId, reaped, sibling };
	}

	test("a lost hold abandons the order WITHOUT an expiry email — the buyer is told synchronously", async () => {
		const { cartId } = await cartWithReapedHold();
		expect(await createOrderFromCart(h.createDeps, cmd(cartId))).toEqual({
			ok: false,
			reason: "RESERVATION_LOST",
		});
		const order = await h.orderStore.getByIdempotencyKey(KEY);
		if (order === null) throw new Error("the lost checkout minted a durable order");
		expect(order.state).toBe("expired");
		expect(h.orderStore.outboxFor(order.id), "no outbox row of any kind").toEqual([]);
	});

	test("a lost hold whose hold release THROWS after the flip still frees the coupon (released before the holds)", async () => {
		await seedSave5();
		const { cartId } = await cartWithReapedHold();
		h.inventory.releaseAdopted = async () => {
			throw new ContentionError("releaseAdopted: hot SKU contended");
		};
		await expect(
			createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" })),
		).rejects.toThrow(ContentionError);
		const order = await h.orderStore.getByIdempotencyKey(KEY);
		expect(order?.state).toBe("expired");
		expect(h.couponStore.usesCount("cpn5"), "the use is freed before the holds").toBe(0);
		expect(h.couponStore.redemptionCount("cpn5")).toBe(0);
	});

	test("a crash between the expiry flip and the coupon release is healed by the next same-key replay", async () => {
		await seedSave5();
		const { cartId } = await cartWithReapedHold();
		const realRelease = h.couponStore.release.bind(h.couponStore);
		let crashed = false;
		h.couponStore.release = async (redemptionId) => {
			if (!crashed) {
				crashed = true;
				throw new ContentionError("process died after the flip");
			}
			return realRelease(redemptionId);
		};
		await expect(
			createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" })),
		).rejects.toThrow(ContentionError);
		expect((await h.orderStore.getByIdempotencyKey(KEY))?.state).toBe("expired");
		expect(h.couponStore.usesCount("cpn5"), "the crash leaked the use").toBe(1);
		// `expireOrders` only lists `pending` orders — it can never heal this one.
		expect(await expireOrders(h.expireDeps, new Date("2027-01-01T00:00:00.000Z"))).toBe(0);

		const replay = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(replay.ok, JSON.stringify(replay)).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.state).toBe("expired");
		expect(h.couponStore.usesCount("cpn5"), "the replay freed the leaked use").toBe(0);
		expect(h.couponStore.redemptionCount("cpn5")).toBe(0);
	});

	test("a lost-hold call that LOSES the pending → expired flip to a concurrent settle answers the paid order and releases nothing", async () => {
		await seedSave5();
		const { cartId, sibling } = await cartWithReapedHold();
		// The webhook settles the order between this call's re-read and its flip.
		const realTransition = h.orderStore.transition.bind(h.orderStore);
		h.orderStore.transition = async (input) => {
			const order = await h.orderStore.getById(input.orderId);
			if (order === null) throw new Error("the order must be durable");
			await settleOrder(
				h.settleDeps,
				h.stripeGw,
				h.stripeGw.webhook({
					outcome: "succeeded",
					orderId: order.id,
					providerRef: "pi_flip_race",
					amount: order.totals.total,
					currency: "USD",
					dedupeKey: "evt-flip-race",
				}),
			);
			return realTransition(input);
		};
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));

		expect(res.ok, JSON.stringify(res)).toBe(true);
		if (!res.ok) return;
		expect(res.order.state).toBe("paid");
		expect(res.intent).toEqual({ gateway: "stripe", intentId: "", clientAction: { kind: "none" } });
		expect(h.stripeGw.intentCalls.length, "no intent minted").toBe(0);
		expect(h.couponStore.usesCount("cpn5"), "a PAID order keeps its coupon use").toBe(1);
		expect(h.inventory.reservationState(sibling), "the settle's commit stands").toBe("committed");
	});

	test("double-click race: a same-key call expires the order AFTER the other call's post-adopt re-read — the other call mints no intent", async () => {
		await seedSave5();
		const cartId = await cart();
		const ids = (await h.cartStore.get(cartId))?.lines
			.map((line) => line.reservationId)
			.filter((id): id is string => id !== null);
		// The cart holds' deadline: 15 minutes out (the fake stamps none by itself).
		const deadline = new Date(h.clock.now().getTime() + 15 * 60 * 1000).toISOString();
		for (const id of ids ?? []) h.inventory.setHoldExpiry(id, deadline);

		let bResult: Promise<unknown> = Promise.resolve();
		let bAtFlip!: () => void;
		const bReachedFlip = new Promise<void>((resolve) => {
			bAtFlip = resolve;
		});
		let aStamping!: () => void;
		const aReachedStamp = new Promise<void>((resolve) => {
			aStamping = resolve;
		});

		// A's adoption is held back until B has classified the holds lost (B's `now`
		// is past the cart holds' deadline; A's was read before it) and is parked
		// at its pending → expired flip.
		const realAdopt = h.inventory.adoptMany.bind(h.inventory);
		let adoptCalls = 0;
		h.inventory.adoptMany = async (input: AdoptManyInput): Promise<AdoptManyResult> => {
			adoptCalls++;
			if (adoptCalls === 1) {
				h.clock.advance(16 * 60 * 1000);
				bResult = createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
				await bReachedFlip;
			}
			return realAdopt(input);
		};
		const realTransition = h.orderStore.transition.bind(h.orderStore);
		h.orderStore.transition = async (input) => {
			bAtFlip();
			await aReachedStamp;
			return realTransition(input);
		};
		// A has adopted every hold and re-read the order `pending`; B's flip lands now.
		const realCheckout = h.cartStore.checkout.bind(h.cartStore);
		h.cartStore.checkout = async (id, orderId) => {
			aStamping();
			await bResult;
			return realCheckout(id, orderId);
		};

		const a = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		const b = await bResult;

		expect(b).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		expect(a.ok, JSON.stringify(a)).toBe(true);
		if (!a.ok) return;
		expect(a.order.state).toBe("expired");
		expect(a.intent).toEqual({ gateway: "stripe", intentId: "", clientAction: { kind: "none" } });
		expect(h.stripeGw.intentCalls.length, "no payable intent for an expired order").toBe(0);
		expect((ids ?? []).map((id) => h.inventory.reservationState(id))).toEqual([
			"released",
			"released",
		]);
		expect(h.inventory.onHand("SKU-1")).toBe(10);
		expect(h.inventory.onHand("SKU-2")).toBe(10);
		expect(h.couponStore.usesCount("cpn5")).toBe(0);
	});
});
