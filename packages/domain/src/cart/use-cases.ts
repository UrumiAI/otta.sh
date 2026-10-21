import type { Currency } from "../money/cents.js";
import {
	idempotencyKey as brandIdempotencyKey,
	orderId as brandOrderId,
	type IdempotencyKey,
	type Sku,
} from "../money/ids.js";
import type { FulfillmentKind } from "../orders/model.js";
import {
	type Cart,
	type CartLine,
	type CartStore,
	HoldExpiredError,
	type RecordedCartMutation,
} from "../ports/cart-store.js";
import type { Clock } from "../ports/clock.js";
import type { OrderStore } from "../ports/order-store.js";
import { type InventoryStore, ReservationNotHeldError } from "../ports/inventory-store.js";
import {
	listLimitFor,
	mayContinue,
	type SweepBatchOptions,
	type SweepBatchResult,
} from "../sweep/batch.js";

/**
 * IO-free cart orchestration over `CartStore` + `InventoryStore` + `Clock`
 * (Phase 3 §6), **ledger-first** (§4): every mutation consults, then claims, its
 * `idempotencyKey` in the `cart_mutations` ledger BEFORE any inventory movement.
 * A completed entry short-circuits to the recorded result — so a stale replay
 * arriving after intervening mutations re-applies nothing — and an incomplete
 * entry (a crashed/in-flight peer) resumes the choreography, whose every step is
 * itself idempotent. Partial failure between steps is healed by that resumption
 * plus the TTL sweep — no cross-store interactive transaction (D1 can't).
 */

/** 15 minutes — the default hold TTL (§5), configurable per deployment. */
export const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000;

export interface CartDeps {
	cartStore: CartStore;
	inventoryStore: InventoryStore;
	clock: Clock;
	/** Hold TTL in ms; defaults to {@link DEFAULT_HOLD_TTL_MS}. */
	ttlMs?: number;
}

/** Typed cart-mutation failures (never status-code-as-logic; §6). */
export type CartFailure =
	| "CART_NOT_FOUND"
	| "CART_CHECKED_OUT"
	| "LINE_NOT_FOUND"
	| "LINE_CHECKED_OUT"
	| "HOLD_EXPIRED"
	| "OUT_OF_STOCK";

export type AddLineResult = { ok: true; line: CartLine } | { ok: false; reason: CartFailure };
export type UpdateLineResult = { ok: true; line: CartLine } | { ok: false; reason: CartFailure };
export type RemoveLineResult = { ok: true } | { ok: false; reason: CartFailure };

function ttl(deps: CartDeps): number {
	return deps.ttlMs ?? DEFAULT_HOLD_TTL_MS;
}

function deadline(deps: CartDeps): string {
	return new Date(deps.clock.now().getTime() + ttl(deps)).toISOString();
}

function cutoffIso(deps: CartDeps, now: Date): string {
	return new Date(now.getTime() - ttl(deps)).toISOString();
}

function isExpiredHeld(
	line: CartLine,
	nowIso: string,
): line is CartLine & { reservationId: string } {
	return (
		line.reservationId !== null &&
		line.reservationState === "held" &&
		line.expiresAt !== null &&
		line.expiresAt <= nowIso
	);
}

/** Mint a new cart. There is no keyed variant here on purpose: the only code that
 *  makes a create key is `replaceSpentCart`, which derives it server-side. */
export async function createCart(deps: CartDeps, currency: Currency): Promise<string> {
	return deps.cartStore.create(currency);
}

export type ReplaceSpentCartResult =
	| { ok: true; cartId: string }
	| { ok: false; reason: "CART_NOT_FOUND" | "CART_NOT_CHECKED_OUT" | "ORDER_NOT_FINISHED" };

/** The cart deps, plus the order read the "finished" check needs. */
export interface ReplaceSpentCartDeps extends CartDeps {
	orderStore: Pick<OrderStore, "getById">;
}

/**
 * The cart that REPLACES a spent one — a cart checked out into an order that can
 * no longer be paid.
 *
 * The key is derived HERE, `rotate:<spentCartId>`, and this is the only code that
 * makes a create key: the same spent cart always has the same replacement, so two
 * requests racing to replace it converge on one cart. Cart ids are bearer secrets,
 * so a spent cart's id grants access to the cart that replaces it — exactly as it
 * already grants access to the spent cart itself.
 *
 * The replacement's currency is what `resolveCurrency` answers, else the spent
 * cart's. The resolver is called ONLY once the spent cart has validated, so a
 * refusal stays typed and costs no read (the plugin's resolver reads settings).
 * Racers converge regardless: the first create under the key wins, and a later
 * racer gets that cart whatever its own resolver answered.
 *
 * Refused, in order: `CART_NOT_FOUND` (no such cart), `CART_NOT_CHECKED_OUT` (an
 * active cart needs no replacing, and rotating it would orphan its lines), and
 * `ORDER_NOT_FINISHED` — the cart names no order, the order cannot be found, or it
 * is still `pending`. A pending order's payment may still happen, and its cart is
 * how the shopper resumes it (the storefront applies the same rule before asking;
 * this is where it cannot be skipped).
 */
export async function replaceSpentCart(
	deps: ReplaceSpentCartDeps,
	spentCartId: string,
	resolveCurrency?: () => Promise<Currency | undefined>,
): Promise<ReplaceSpentCartResult> {
	const spent = await deps.cartStore.get(spentCartId);
	if (spent === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (spent.state !== "checked_out") return { ok: false, reason: "CART_NOT_CHECKED_OUT" };
	const order =
		spent.orderId === null ? null : await deps.orderStore.getById(brandOrderId(spent.orderId));
	if (order === null || order.state === "pending") {
		return { ok: false, reason: "ORDER_NOT_FINISHED" };
	}
	const currency = (await resolveCurrency?.()) ?? spent.currency;
	const cartId = await deps.cartStore.create(
		currency,
		brandIdempotencyKey(`rotate:${spentCartId}`),
	);
	return { ok: true, cartId };
}

/**
 * Whether `cart` is STALE against the store currency: still `active` (a shopper's
 * workspace, not an order's record) but in another currency than the one the
 * store now sells in. A stale cart can still check out lines priced in its own
 * currency, but nothing priced in the store currency can ever be quoted in it
 * (`CURRENCY_MISMATCH`) — the case `replaceStaleCurrencyCart` exists for (#440).
 */
export function isStaleCurrencyCart(
	cart: Pick<Cart, "state" | "currency">,
	storeCurrency: Currency,
): boolean {
	return cart.state === "active" && cart.currency !== storeCurrency;
}

export type ReplaceStaleCurrencyCartResult =
	| { ok: true; cartId: string }
	| {
			ok: false;
			reason: "CART_NOT_FOUND" | "CART_CHECKED_OUT" | "CART_CURRENCY_CURRENT" | "LINE_CHECKED_OUT";
	  };

/**
 * How many of a stale cart's holds one `replaceStaleCurrencyCart` call releases.
 * A FIXED number, so the call's cost does not grow with the cart: on Workers Free
 * a request gets 50 D1 queries, and a release is a handful of them. The rest are
 * not leaked — see the use-case.
 */
export const STALE_CART_RELEASE_LIMIT = 2;

/**
 * The cart that REPLACES a stale-currency one (#440): a new, EMPTY cart in
 * `storeCurrency`, and the stale cart's stock handed back.
 *
 * A cart is never rewritten — its currency is fixed at creation, and the stale
 * cart keeps its own. Nothing is converted and no line is carried over: a line's
 * price is read live at quote time, so the shopper re-adds what they want and is
 * quoted the current price in the new currency.
 *
 * BOUNDED COST, whatever the cart's size. One cart read (the same read the cart
 * page itself makes), the keyed create, then at most `releaseLimit` hold releases
 * through the inventory port — never `removeLine`, which re-reads the whole cart
 * per line. The holds left behind are still the stale cart's `held` lines with a
 * deadline at most one hold TTL away, and the hold sweep (`expireHolds`, the
 * cron's budgeted `expire-holds` leg) reaps every expired `held` hold of an
 * ACTIVE cart — releasing the stock and dropping the line — so they come back on
 * their own within one TTL plus a sweep. A released line is left on the stale
 * cart (nobody reads it again: the shopper's cookie now names the new cart), and
 * the sweep's listing drops it as a dead candidate.
 *
 * ORDER, for a request that can always finish: the new cart is created FIRST,
 * under `recurrency:<cartId>:<currency>`, so a request that dies mid-release has
 * still minted the cart its retry will be handed. A retry re-reads the cart,
 * skips the holds already released (a release is idempotent by the reservation's
 * own state) and releases the next ones; racers converge on the same cart. A
 * second switch to another currency is a different key and its own cart.
 *
 * Refused, in order, touching nothing: `CART_NOT_FOUND`; `CART_CHECKED_OUT` (its
 * holds belong to an order now); `CART_CURRENCY_CURRENT` (nothing to replace);
 * and `LINE_CHECKED_OUT` when any line's hold is already `adopted` or `committed`
 * — a checkout is mid-flight on this cart (it adopts every hold before it flips
 * the cart), and its stock is the order's, not the shopper's to free.
 *
 * Accepted residual, shared with `removeLine`: a checkout that adopts a hold
 * between this read and its release. Releasing an adopted hold is the inventory
 * port's own rule (`held|adopted → released`); the window is one request wide and
 * needs the shopper to check the stale cart out in another tab at that instant.
 */
export async function replaceStaleCurrencyCart(
	deps: Pick<CartDeps, "cartStore" | "inventoryStore" | "clock">,
	staleCartId: string,
	storeCurrency: Currency,
	releaseLimit: number = STALE_CART_RELEASE_LIMIT,
): Promise<ReplaceStaleCurrencyCartResult> {
	// ONE read, no lazy expiry: expiring lapsed holds here is a write per line.
	const cart = await deps.cartStore.get(staleCartId);
	if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (cart.state !== "active") return { ok: false, reason: "CART_CHECKED_OUT" };
	if (!isStaleCurrencyCart(cart, storeCurrency)) {
		return { ok: false, reason: "CART_CURRENCY_CURRENT" };
	}
	if (
		cart.lines.some(
			(line) => line.reservationState === "adopted" || line.reservationState === "committed",
		)
	) {
		return { ok: false, reason: "LINE_CHECKED_OUT" };
	}

	const cartId = await deps.cartStore.create(
		storeCurrency,
		brandIdempotencyKey(`recurrency:${staleCartId}:${storeCurrency}`),
	);

	// Live holds only: one past its deadline is the sweep's already, and a
	// released one is done (a retry after a crash lands here).
	const nowIso = deps.clock.now().toISOString();
	const live = cart.lines.filter(
		(line): line is CartLine & { reservationId: string } =>
			line.reservationId !== null &&
			line.reservationState === "held" &&
			(line.expiresAt === null || line.expiresAt > nowIso),
	);
	for (const line of live.slice(0, releaseLimit)) {
		await deps.inventoryStore.release(line.reservationId);
	}
	return { ok: true, cartId };
}

/**
 * Read a cart, running **lazy expiry first** (§5): any of this cart's held lines
 * whose hold has lapsed is released and dropped before the caller sees it, so a
 * shopper never acts on stock they no longer hold. The release is the store's
 * guarded `expireHold` flip, which re-checks the deadline atomically — a lazy
 * read racing the sweep never double-returns, and one racing a concurrent
 * TTL-reset (or checkout) reaps nothing and throws nothing.
 */
export async function getCart(deps: CartDeps, cartId: string): Promise<Cart | null> {
	const cart = await deps.cartStore.get(cartId);
	if (cart === null) return null;

	const now = deps.clock.now();
	const nowIso = now.toISOString();
	const cutoff = cutoffIso(deps, now);
	let expiredAny = false;
	for (const line of cart.lines) {
		if (isExpiredHeld(line, nowIso)) {
			const won = await deps.cartStore.expireHold(line.reservationId, nowIso, cutoff);
			expiredAny = expiredAny || won;
		}
	}
	return expiredAny ? deps.cartStore.get(cartId) : cart;
}

/**
 * Add `{sku, qty}` to a cart. Ledger-first: a completed replay returns the
 * recorded line; otherwise claim the key, reserve via the atomic inventory port,
 * then complete the line. `OUT_OF_STOCK` writes **no** line and RETIRES the
 * claim (`abandonClaim`): it stays incomplete, so a replay resumes and re-reads
 * reserve's recorded `failed` state, but it is no longer the sweep's work.
 * The pre-reserve claim marks the hold cart-originated so a crash between
 * reserve and the line write leaves a hold the sweep can identify and reap.
 *
 * **Re-adding a sku already in the cart adds to that line** (one line per sku,
 * one reservation per physical line — phase-3 plan §4): the add becomes an
 * {@link updateLine} of the existing line to `line.qty + qty`, keyed by this
 * add's `idempotencyKey`, so stock moves by delta on the line's OWN hold. A
 * fresh `reserve` here would be attached over the line's current reservation
 * and orphan it until the TTL sweep — locking stock no cart line accounts for.
 */
export async function addLine(
	deps: CartDeps,
	cartId: string,
	sku: Sku,
	productId: string | null,
	qty: number,
	key: IdempotencyKey,
	fulfillmentKind: FulfillmentKind = "physical",
): Promise<AddLineResult> {
	const recorded = await deps.cartStore.recordedMutation(key);
	if (recorded !== null && recorded.completed) return replayLine(deps, cartId, recorded);

	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

	// The sku already has a line: add to it through the line's own hold. The one
	// exception is RESUMING this key's own incomplete `add` claim — that attempt
	// may already have reserved under the key, so it must finish the reserve
	// choreography it started (its hold is ledger-scoped, so the sweep can reap it).
	const existing = guard.cart.lines.find((l) => l.sku === sku);
	if (existing !== undefined && recorded?.kind !== "add") {
		return updateLine(deps, cartId, existing.lineId, existing.qty + qty, key);
	}

	const claim = await deps.cartStore.claimMutation({ key, cartId, kind: "add" });
	if (!claim.claimed && claim.recorded.completed) return replayLine(deps, cartId, claim.recorded);
	// Claim won, or lost to an incomplete (crashed/in-flight) peer: resume — every
	// step below is idempotent (reserve replays by state; upsertLine by ledger).

	// v1 digital goods NEVER reserve (Phase 4 §6, decision 6): unlimited stock ⇒
	// no inventory row, no reserve, the line carries reservation_id/expires_at NULL
	// and is thus invisible to the Phase-3 hold sweep.
	if (fulfillmentKind === "digital") {
		const line = await deps.cartStore.upsertLine({
			cartId,
			sku,
			productId,
			qty,
			reservationId: null,
			expiresAt: null,
			key,
		});
		return { ok: true, line };
	}

	const reserved = await deps.inventoryStore.reserve(sku, qty, key);
	if (!reserved.ok) {
		// Decided: no hold exists under this key, and none ever will (the reserve
		// key is once-only). Retire the claim so it is not swept forever (QA U-16);
		// a same-key replay still resumes here and answers OUT_OF_STOCK again.
		// BEST-EFFORT: the answer is already decided and the retirement only spares
		// the sweep a read, so a failed write (contention, a fault) is logged and
		// the shopper still gets OUT_OF_STOCK — never a 500 or a BUSY for it. An
		// unretired claim is exactly the pre-fix state, which the sweep tolerates.
		try {
			await deps.cartStore.abandonClaim(cartId, key);
		} catch (err) {
			console.warn(
				"[domain] addLine: could not retire an out-of-stock claim:",
				err instanceof Error ? err.message : String(err),
			);
		}
		return { ok: false, reason: "OUT_OF_STOCK" };
	}

	try {
		const line = await deps.cartStore.upsertLine({
			cartId,
			sku,
			productId,
			qty,
			reservationId: reserved.reservationId,
			expiresAt: deadline(deps),
			key,
		});
		return { ok: true, line };
	} catch (err) {
		// The hold is no longer held — the sweep reaped a crashed dangling hold
		// before this late replay arrived (reserve replays `released` as ok, per
		// Phase-0 semantics). Refuse to resurrect a visible line over dead stock;
		// the shopper simply adds again with a fresh key.
		if (err instanceof HoldExpiredError) return { ok: false, reason: "HOLD_EXPIRED" };
		throw err;
	}
}

/**
 * Change a line to `newQty` via **delta reserve / partial release** (§4).
 * Ledger-first (a completed replay short-circuits to the recorded result, moving
 * no stock), then fenced guard-first: reject a non-`active` cart
 * (`CART_CHECKED_OUT`) or a line whose hold is no longer `held`
 * (`LINE_CHECKED_OUT`) **before** touching inventory — and `adjust` itself
 * re-verifies `held` inside its guarded CAS, so a checkout racing this call
 * surfaces as `LINE_CHECKED_OUT`, never a leaked movement. An increase that
 * outruns stock leaves the line untouched and reports `OUT_OF_STOCK`.
 */
export async function updateLine(
	deps: CartDeps,
	cartId: string,
	lineId: string,
	newQty: number,
	key: IdempotencyKey,
): Promise<UpdateLineResult> {
	const recorded = await deps.cartStore.recordedMutation(key);
	if (recorded !== null && recorded.completed) return replayLine(deps, cartId, recorded);

	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

	const line = guard.cart.lines.find((l) => l.lineId === lineId);
	if (line === undefined) return { ok: false, reason: "LINE_NOT_FOUND" };

	// Digital line (Phase 4 §6): no reservation ever existed — adjust the qty
	// directly, moving no inventory. Distinguished from a checked-out physical
	// line (reservationId set / reservationState adopted-or-gone) by BOTH the id
	// and the live state being null.
	if (line.reservationId === null && line.reservationState === null) {
		const dclaim = await deps.cartStore.claimMutation({ key, cartId, kind: "adjust", lineId });
		if (!dclaim.claimed && dclaim.recorded.completed) {
			return replayLine(deps, cartId, dclaim.recorded);
		}
		const updated = await deps.cartStore.adjustLine({
			cartId,
			lineId,
			newQty,
			expiresAt: null,
			key,
		});
		return { ok: true, line: updated };
	}

	if (line.reservationId === null || line.reservationState !== "held") {
		return { ok: false, reason: "LINE_CHECKED_OUT" };
	}

	const claim = await deps.cartStore.claimMutation({ key, cartId, kind: "adjust", lineId });
	if (!claim.claimed && claim.recorded.completed) return replayLine(deps, cartId, claim.recorded);

	let adjusted;
	try {
		adjusted = await deps.inventoryStore.adjust(line.reservationId, newQty, key);
	} catch (err) {
		// The hold left `held` between the fence read and the guarded CAS (e.g. a
		// racing checkout adopted it): typed rejection, no stock moved.
		if (err instanceof ReservationNotHeldError) return { ok: false, reason: "LINE_CHECKED_OUT" };
		throw err;
	}
	if (!adjusted.ok) return { ok: false, reason: "OUT_OF_STOCK" };

	const updated = await deps.cartStore.adjustLine({
		cartId,
		lineId,
		newQty,
		expiresAt: deadline(deps),
		key,
	});
	return { ok: true, line: updated };
}

/**
 * Remove a line: claim the key, release the (held) reservation, then drop the
 * line and complete the claim. Double-remove is a no-op; a replay of a remove
 * that crashed after `release` but before the line delete finds the reservation
 * `released` and COMPLETES the removal (never a spurious `LINE_CHECKED_OUT`).
 * Fenced: a hold that is `committed`/`adopted` (a Phase-4 order owns it) is
 * `LINE_CHECKED_OUT` and never released.
 */
export async function removeLine(
	deps: CartDeps,
	cartId: string,
	lineId: string,
	key: IdempotencyKey,
): Promise<RemoveLineResult> {
	const recorded = await deps.cartStore.recordedMutation(key);
	if (recorded !== null && recorded.completed) return { ok: true };

	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

	const line = guard.cart.lines.find((l) => l.lineId === lineId);
	if (line === undefined) return { ok: true }; // already gone: idempotent no-op

	if (line.reservationId !== null) {
		// `held` → release it; `released` → a crashed/expired remove already freed
		// the stock, so the removal is completable; anything else (committed /
		// adopted / …) is no longer the cart's to touch.
		if (line.reservationState === "held") {
			await deps.cartStore.claimMutation({ key, cartId, kind: "remove", lineId });
			await deps.inventoryStore.release(line.reservationId);
		} else if (line.reservationState !== "released") {
			return { ok: false, reason: "LINE_CHECKED_OUT" };
		}
	}
	await deps.cartStore.removeLine(cartId, lineId, key);
	return { ok: true };
}

/**
 * Reclaim every globally-expired hold (the scheduled sweep §5) via the store's
 * guarded `expireHold` flip — the exact same atomic path lazy-on-read uses, so
 * the two racing the same reservation cannot double-return, and a hold whose
 * TTL was reset between listing and flipping is left alone. Returns the count
 * actually reclaimed (flips won).
 */
export async function expireHolds(deps: CartDeps, at?: Date): Promise<number> {
	return (await expireHoldsBatch(deps, at)).count;
}

/**
 * `expireHolds`, bounded: at most `limit` holds attempted, each only while
 * `shouldContinue` allows, reporting whether the expired set was `drained`. The
 * scheduled sweep calls this so a hold backlog drains over several ticks instead
 * of overrunning the host's hook timeout (see `sweep/batch.ts`). A hold not
 * reached is still expired-and-listed next time; the guarded flip is unchanged.
 */
export async function expireHoldsBatch(
	deps: CartDeps,
	at?: Date,
	options: SweepBatchOptions = {},
): Promise<SweepBatchResult> {
	const now = at ?? deps.clock.now();
	const nowIso = now.toISOString();
	const cutoff = cutoffIso(deps, now);

	const expired = await deps.cartStore.listExpired(nowIso, cutoff, listLimitFor(options));
	let reclaimed = 0;
	let attempted = 0;
	for (const hold of expired) {
		if (!mayContinue(options, attempted)) return { count: reclaimed, drained: false };
		attempted++;
		const won = await deps.cartStore.expireHold(hold.reservationId, nowIso, cutoff);
		if (won) reclaimed++;
	}
	return { count: reclaimed, drained: true };
}

type ActiveCartGuard = { ok: true; cart: Cart } | { ok: false; reason: CartFailure };

/** Cart-state fence (secondary): reject a mutation on a non-`active` cart up front. */
async function guardActiveCart(deps: CartDeps, cartId: string): Promise<ActiveCartGuard> {
	const cart = await deps.cartStore.get(cartId);
	if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (cart.state !== "active") return { ok: false, reason: "CART_CHECKED_OUT" };
	return { ok: true, cart };
}

/**
 * Build the response for a completed ledger replay: the recorded line with its
 * RECORDED qty (the original response), regardless of later mutations — plan §4:
 * "a replay looks up the row and returns its recorded result instead of
 * re-applying". If the line was since removed, the replay cannot (and must not)
 * recreate it: report `LINE_NOT_FOUND` rather than resurrect a released hold.
 */
async function replayLine(
	deps: CartDeps,
	cartId: string,
	recorded: RecordedCartMutation,
): Promise<{ ok: true; line: CartLine } | { ok: false; reason: CartFailure }> {
	const cart = await deps.cartStore.get(cartId);
	const line = cart?.lines.find((l) => l.lineId === recorded.lineId);
	if (line === undefined) return { ok: false, reason: "LINE_NOT_FOUND" };
	return { ok: true, line: { ...line, qty: recorded.resultingQty ?? line.qty } };
}
