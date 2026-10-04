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
 * already grants access to the spent cart itself. The replacement is in the spent
 * cart's currency.
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
): Promise<ReplaceSpentCartResult> {
	const spent = await deps.cartStore.get(spentCartId);
	if (spent === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (spent.state !== "checked_out") return { ok: false, reason: "CART_NOT_CHECKED_OUT" };
	const order =
		spent.orderId === null ? null : await deps.orderStore.getById(brandOrderId(spent.orderId));
	if (order === null || order.state === "pending") {
		return { ok: false, reason: "ORDER_NOT_FINISHED" };
	}
	const cartId = await deps.cartStore.create(
		spent.currency,
		brandIdempotencyKey(`rotate:${spentCartId}`),
	);
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
	const now = at ?? deps.clock.now();
	const nowIso = now.toISOString();
	const cutoff = cutoffIso(deps, now);

	const expired = await deps.cartStore.listExpired(nowIso, cutoff);
	let reclaimed = 0;
	for (const hold of expired) {
		const won = await deps.cartStore.expireHold(hold.reservationId, nowIso, cutoff);
		if (won) reclaimed++;
	}
	return reclaimed;
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
