import type { Currency } from "../money/cents.js";
import type { IdempotencyKey, Sku } from "../money/ids.js";
import type { Cart, CartLine, CartStore, RecordedCartMutation } from "../ports/cart-store.js";
import type { Clock } from "../ports/clock.js";
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

export async function createCart(deps: CartDeps, currency: Currency): Promise<string> {
	return deps.cartStore.create(currency);
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
 * then complete the line. `OUT_OF_STOCK` writes **no** line (the claim stays
 * incomplete; a replay resumes and re-reads reserve's recorded `failed` state).
 * The pre-reserve claim marks the hold cart-originated so a crash between
 * reserve and the line write leaves a hold the sweep can identify and reap.
 */
export async function addLine(
	deps: CartDeps,
	cartId: string,
	sku: Sku,
	productId: string | null,
	qty: number,
	key: IdempotencyKey,
): Promise<AddLineResult> {
	const recorded = await deps.cartStore.recordedMutation(key);
	if (recorded !== null && recorded.completed) return replayLine(deps, cartId, recorded);

	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

	const claim = await deps.cartStore.claimMutation({ key, cartId, kind: "add" });
	if (!claim.claimed && claim.recorded.completed) return replayLine(deps, cartId, claim.recorded);
	// Claim won, or lost to an incomplete (crashed/in-flight) peer: resume — every
	// step below is idempotent (reserve replays by state; upsertLine by ledger).

	const reserved = await deps.inventoryStore.reserve(sku, qty, key);
	if (!reserved.ok) return { ok: false, reason: "OUT_OF_STOCK" };

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
