/**
 * The admin PRODUCT operations: the decision half of every stock movement and
 * commerce edit, with no payload parsing and no notice.
 *
 * WHY THEY ARE HERE. These rules used to live inline in the console actions
 * (`products-actions.ts`), one layer above `AdminProductsSurface`: a stock
 * movement's per-click nonce key and the live re-read after a ledger replay, the
 * classification of a removal refused against a moved on-hand (DA-3a), and an
 * edit's unsupported-currency guard and content-derived key. A second caller
 * (the MCP tools) calling the surface directly would skip all of them. So each
 * write is one function here, and both callers go through it: the action parses
 * its payload, calls the operation, and turns the outcome into a notice; an MCP
 * route validates its input, calls the operation, and turns the outcome into
 * JSON. Moved verbatim — no rule changed on the way. See `products-actions.ts`'s
 * module header for the full rationale of each rule.
 *
 * INPUT IS TYPED, NOT PARSED. Reading an untrusted payload (integer strings, the
 * nonce's presence, the edit form's fields into a `ProductEditWire`) stays with
 * each caller. What an operation cannot safely run without, it ASSERTS and throws
 * `RangeError` on — a caller that let one through has a bug, and no write is
 * attempted.
 */
import { isSupportedCurrency } from "@urumi.ai/otta-domain";
import type {
	AdminProductsSurface,
	ProductEditResult,
	ProductEditWire,
	RestockResult,
	StockRemovalResult,
} from "../admin-products-surface.js";

function assertInput(condition: boolean, message: string): asserts condition {
	if (!condition) throw new RangeError(message);
}

// -- stock movements ----------------------------------------------------------

/** A caller-minted nonce: 32 hex characters from `mintMovementNonce` (the
 *  console), or a UUID (the staging demo seed). The shape is checked so a key is
 *  never built from arbitrary operator-round-tripped text, and is loose enough
 *  to admit any opaque id of comparable entropy. */
export const NONCE_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/** The movement's idempotency key: per intent, from the caller's nonce. The
 *  `nonce:` segment keeps it apart from the content-derived keys an earlier
 *  release wrote to the ledger. */
export function stockMovementKey(
	productId: string,
	direction: "restock" | "removal",
	nonce: string,
): string {
	return `${productId}:${direction}:nonce:${nonce}`;
}

export interface StockMovementInput {
	productId: string;
	/** The on-hand the operator SAW. A removal's watermark (DA-3a); a restock is
	 *  not judged against it, but it is required for both. A non-negative integer. */
	onHand: number;
	/** A positive whole number of units. */
	qty: number;
	/** Minted per decision; matches {@link NONCE_PATTERN}. The same nonce again is a
	 *  retry of that decision, answered once from the ledger. */
	nonce: string;
}

export type StockOutcome<
	R extends RestockResult | StockRemovalResult = RestockResult | StockRemovalResult,
> =
	/** The units moved; `result.onHand` is the count the movement produced. */
	| { kind: "moved"; result: R }
	/** An earlier call with this nonce moved the units and this one moved nothing.
	 *  `liveOnHand` is RE-READ now (the shelf may have moved since); `null` when the
	 *  re-read failed. */
	| { kind: "replayed"; liveOnHand: number | null }
	/** A REMOVAL refused because the count is no longer the one the operator saw
	 *  (DA-3a); nothing moved. `null` means there is no inventory record at all —
	 *  never a count of zero. A restock never answers this. */
	| { kind: "stock_changed"; liveOnHand: number | null }
	/** Refused for any other reason; `result` is the surface's typed one. */
	| { kind: "failed"; result: R };

function assertMovement(input: StockMovementInput): void {
	assertInput(NONCE_PATTERN.test(input.nonce), "nonce must match NONCE_PATTERN");
	assertInput(Number.isSafeInteger(input.qty) && input.qty > 0, "qty must be a positive integer");
	assertInput(
		Number.isSafeInteger(input.onHand) && input.onHand >= 0,
		"onHand must be a non-negative integer",
	);
}

/** A replay's live count, re-read now — the recorded one is the count the
 *  EARLIER call produced, and the shelf may have moved since. */
async function liveOnHand(client: AdminProductsSurface, productId: string): Promise<number | null> {
	const live = await client.getProduct(productId).catch(() => null);
	return live === null ? null : live.onHand;
}

/**
 * Add `qty` units. NOT PINNED to the count the operator saw: an add is
 * commutative, so two tabs that both saw 4 and both add 3 end at 10 — two
 * decisions, two nonces. Lost-response safety is the nonce's job.
 */
export async function restock(
	client: AdminProductsSurface,
	input: StockMovementInput,
): Promise<Exclude<StockOutcome<RestockResult>, { kind: "stock_changed" }>> {
	assertMovement(input);
	const { productId, qty, nonce } = input;
	const key = stockMovementKey(productId, "restock", nonce);
	const result = await client.restock(productId, qty, key);
	if (result.ok && result.replayed === true) {
		return { kind: "replayed", liveOnHand: await liveOnHand(client, productId) };
	}
	return result.ok ? { kind: "moved", result } : { kind: "failed", result };
}

/**
 * Remove `qty` units, against the on-hand the operator saw. DA-3a, mandatory and
 * atomic: the watermark rides with the movement as `expectedOnHand` and the store
 * refuses a mismatch in the same write. The store's guarded decrement refuses an
 * over-removal as `insufficient_stock` — never a negative.
 */
export async function removeStock(
	client: AdminProductsSurface,
	input: StockMovementInput,
): Promise<StockOutcome<StockRemovalResult>> {
	assertMovement(input);
	const { productId, onHand, qty, nonce } = input;
	const key = stockMovementKey(productId, "removal", nonce);
	const result = await client.removeStock(productId, qty, key, onHand);
	if (result.ok && result.replayed === true) {
		return { kind: "replayed", liveOnHand: await liveOnHand(client, productId) };
	}
	if (result.ok) return { kind: "moved", result };
	if (result.reason === "stale_on_hand")
		return { kind: "stock_changed", liveOnHand: result.onHand };
	// The operator decided against a count, so they saw a record: its absence now
	// is a change since then, not the "never had one" a restock reports.
	if (result.reason === "no_inventory_row") return { kind: "stock_changed", liveOnHand: null };
	return { kind: "failed", result };
}

// -- the commerce edit ----------------------------------------------------------

/** Stable content-derived idempotency key for an edit save (F-2a, `Edit /
 *  save` row: "content hash of the submitted wire + `expectedUpdatedAt`").
 *  FNV-1a twice with independent seeds — dependency-free and sandbox-safe.
 *
 *  KNOWN FOOTGUN, INHERITED VERBATIM AND UNREACHABLE TODAY. `?? null`
 *  canonicalises an ABSENT field and an EXPLICIT `null` identically, so "clear
 *  the compare-at" and "leave the compare-at alone" hash to the same key. That
 *  cannot bite across the three forms this screen ships: each carries its
 *  clearable fields in every submit, so a form that can send `null` never omits
 *  the field, and one that omits it can never send `null`. A FOURTH form that
 *  submits a clearable field only sometimes would collide the two — and, under a
 *  once-only store, silently drop the second write. Whoever adds one must
 *  distinguish the cases here (an absent sentinel, not `null`) rather than
 *  assume this holds. */
export function deriveEditIdempotencyKey(productId: string, wire: ProductEditWire): string {
	const canonical = JSON.stringify([
		productId,
		wire.expectedUpdatedAt,
		wire.sku ?? null,
		wire.price ?? null,
		// No `title` component — the wire cannot carry one (ADR-0013).
		wire.taxClass ?? null,
		wire.compareAtPrice ?? null,
		wire.unitCost ?? null,
		wire.weightGrams ?? null,
		wire.lengthMm ?? null,
		wire.widthMm ?? null,
		wire.heightMm ?? null,
		wire.productKind ?? null,
		// PR 2b: without it, two saves at one watermark that differ only in tax
		// status share a key, and the second is answered as the first's replay.
		wire.taxStatus ?? null,
	]);
	return `${productId}:edit:${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01234567)}`;
}

/** FNV-1a over UTF-16 code units, base-36. Shared with the download-attach key. */
export function fnv1a(input: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/**
 * The currency this edit would AUTHOR when it is not in the currency table
 * (`@urumi.ai/otta-domain`'s `isSupportedCurrency`), or `null` when the edit is fine.
 *
 * MEMBERSHIP IS CHECKED ONLY FOR A NEW CURRENCY. A product priced before the
 * table existed may sit in any shape-valid code, and its form re-submits that
 * code with every save: refusing it would lock the merchant out of editing the
 * product at all. So an unlisted code is allowed exactly when it is the one
 * already stored (the store refuses re-currencying a priced product anyway), and
 * the read that tells is made only in that rare case — a listed code costs
 * nothing.
 */
async function unsupportedNewCurrency(
	client: AdminProductsSurface,
	productId: string,
	wire: ProductEditWire,
): Promise<string | null> {
	const codes = new Set<string>();
	for (const money of [wire.price, wire.compareAtPrice, wire.unitCost]) {
		if (money !== undefined && money !== null && !isSupportedCurrency(money.currency)) {
			codes.add(money.currency);
		}
	}
	if (codes.size === 0) return null;
	const stored = (await client.getProduct(productId))?.currency ?? null;
	for (const code of codes) if (code !== stored) return code;
	return null;
}

export type ProductEditOutcome =
	/** The edit would author a currency the store does not support; nothing was
	 *  sent. */
	| { kind: "unsupported_currency"; currency: string }
	/** The write was attempted; `result` is the surface's typed answer. */
	| { kind: "result"; result: ProductEditResult };

/**
 * A sparse commerce edit under the optimistic-concurrency watermark
 * `wire.expectedUpdatedAt` — mandatory, and blank counts as absent (a save with
 * no watermark is a clobber of whatever landed since). Refuses a NEW unsupported
 * currency before anything is sent, then PATCHes under the content-derived key
 * {@link deriveEditIdempotencyKey}, so the same edit twice at one watermark is
 * one write.
 */
export async function editProduct(
	client: AdminProductsSurface,
	productId: string,
	wire: ProductEditWire,
): Promise<ProductEditOutcome> {
	assertInput(wire.expectedUpdatedAt.trim().length > 0, "expectedUpdatedAt is required");
	const unsupported = await unsupportedNewCurrency(client, productId, wire);
	if (unsupported !== null) return { kind: "unsupported_currency", currency: unsupported };
	const key = deriveEditIdempotencyKey(productId, wire);
	return { kind: "result", result: await client.updateProduct(productId, wire, key) };
}
