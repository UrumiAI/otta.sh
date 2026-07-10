import type { Currency } from "../money/cents.js";
import type { IdempotencyKey, Sku } from "../money/ids.js";
import type { Cart, CartLine, CartStore } from "../ports/cart-store.js";
import type { Clock } from "../ports/clock.js";
import type { InventoryStore } from "../ports/inventory-store.js";

/**
 * IO-free cart orchestration over `CartStore` + `InventoryStore` + `Clock`
 * (Phase 3 §6). Partial failure between "reserve/adjust succeeded" and "cart
 * line written" is healed by idempotency (a replay recovers) + TTL (a dangling
 * hold is reaped) — no cross-store interactive transaction (D1 can't).
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
 * shopper never acts on stock they no longer hold. The release is guarded and
 * idempotent, so a lazy read racing the scheduled sweep never double-returns.
 */
export async function getCart(deps: CartDeps, cartId: string): Promise<Cart | null> {
	const cart = await deps.cartStore.get(cartId);
	if (cart === null) return null;

	const nowIso = deps.clock.now().toISOString();
	let expiredAny = false;
	for (const line of cart.lines) {
		if (isExpiredHeld(line, nowIso)) {
			await deps.inventoryStore.release(line.reservationId);
			await deps.cartStore.releaseExpired(line.reservationId);
			expiredAny = true;
		}
	}
	return expiredAny ? deps.cartStore.get(cartId) : cart;
}

/**
 * Add `{sku, qty}` to a cart: reserve via the atomic inventory port, then record
 * the line. `OUT_OF_STOCK` writes **no** line. Idempotent: reserve is keyed and
 * the ledger dedupes the line write, so a double-click decrements once.
 */
export async function addLine(
	deps: CartDeps,
	cartId: string,
	sku: Sku,
	productId: string | null,
	qty: number,
	key: IdempotencyKey,
): Promise<AddLineResult> {
	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

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
 * Change a line to `newQty` via **delta reserve / partial release** (§4). Fenced
 * guard-first: reject a non-`active` cart (`CART_CHECKED_OUT`) or a line whose
 * hold is no longer `held` (`LINE_CHECKED_OUT`) **before** touching inventory. An
 * increase that outruns stock leaves the line untouched and reports
 * `OUT_OF_STOCK`.
 */
export async function updateLine(
	deps: CartDeps,
	cartId: string,
	lineId: string,
	newQty: number,
	key: IdempotencyKey,
): Promise<UpdateLineResult> {
	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

	const line = guard.cart.lines.find((l) => l.lineId === lineId);
	if (line === undefined) return { ok: false, reason: "LINE_NOT_FOUND" };
	if (line.reservationId === null || line.reservationState !== "held") {
		return { ok: false, reason: "LINE_CHECKED_OUT" };
	}

	const adjusted = await deps.inventoryStore.adjust(line.reservationId, newQty, key);
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
 * Remove a line: release the whole (held) reservation, then drop the line.
 * Double-remove is a no-op. Fenced: a line whose hold is no longer `held`
 * (adopted by a Phase-4 order) is `LINE_CHECKED_OUT` and never released.
 */
export async function removeLine(
	deps: CartDeps,
	cartId: string,
	lineId: string,
	key: IdempotencyKey,
): Promise<RemoveLineResult> {
	const guard = await guardActiveCart(deps, cartId);
	if (!guard.ok) return guard;

	const line = guard.cart.lines.find((l) => l.lineId === lineId);
	if (line === undefined) return { ok: true }; // already gone: idempotent no-op

	if (line.reservationId !== null) {
		if (line.reservationState !== "held") return { ok: false, reason: "LINE_CHECKED_OUT" };
		await deps.inventoryStore.release(line.reservationId);
	}
	await deps.cartStore.removeLine(cartId, lineId, key);
	return { ok: true };
}

/**
 * Reclaim every globally-expired hold (the scheduled sweep §5). Shares the exact
 * guarded, idempotent release path with lazy-on-read, so the two racing the same
 * reservation cannot double-return stock. Returns the count reclaimed.
 */
export async function expireHolds(deps: CartDeps, at?: Date): Promise<number> {
	const now = at ?? deps.clock.now();
	const nowIso = now.toISOString();
	const cutoff = new Date(now.getTime() - ttl(deps)).toISOString();

	const expired = await deps.cartStore.listExpired(nowIso, cutoff);
	for (const hold of expired) {
		await deps.inventoryStore.release(hold.reservationId);
		await deps.cartStore.releaseExpired(hold.reservationId);
	}
	return expired.length;
}

type ActiveCartGuard = { ok: true; cart: Cart } | { ok: false; reason: CartFailure };

/** Cart-state fence (secondary): reject a mutation on a non-`active` cart up front. */
async function guardActiveCart(deps: CartDeps, cartId: string): Promise<ActiveCartGuard> {
	const cart = await deps.cartStore.get(cartId);
	if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (cart.state !== "active") return { ok: false, reason: "CART_CHECKED_OUT" };
	return { ok: true, cart };
}
