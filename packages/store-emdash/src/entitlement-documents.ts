/**
 * The entitlement documents: one grant per grant-idempotency key, plus a lookup
 * document per scope that turns the delivery gate into a keyed read.
 *
 * The SQL adapter held this in one table with a UNIQUE `grant_idempotency_key`
 * and two composite lookup indices — `(order_id, sku, state)` and
 * `(lower(buyer_ref), sku, state)` — behind a `check` whose predicate is
 * `state = 'active' AND sku = ? AND (order_id = ?)? AND (lower(buyer_ref) = ?)?`.
 * Both halves are reassembled here:
 *
 * | Document | What it is |
 * |---|---|
 * | `entitlements/{grantIdempotencyKey}` | the grant — the once-only is the document id |
 * | `entitlement_lookups/{scope}` | a pointer from one authorization scope to the grant that satisfies it |
 *
 * **The grant's document id is its idempotency key.** That is the whole of
 * grant-once: `compareAndSet(key, null, …)` is a DB-level
 * `INSERT … ON CONFLICT DO NOTHING`, so a webhook or proof replay re-grants
 * nothing and reads back the grant it already made.
 *
 * **The lookup is a cache over a query that is itself correct.** Every field
 * `check` filters on is a declared index, so the scope query alone answers the
 * gate; the pointer exists so the hot delivery path pays two keyed reads instead
 * of an index scan. It is therefore never the definition of authorization
 * (ADR-0019's cross-cutting rule (b)): a pointer that is missing, stale or names
 * a grant that is no longer `active` falls through to the indexed query, and the
 * query's answer is the one returned. That is what makes a crash between the
 * grant write and the pointer write harmless, and it is why revoking a grant needs
 * no pointer maintenance at all.
 *
 * **A scope id is an authorization key, so its parts are escaped.** A scope is a
 * pair — an order id or a folded buyer reference, and a sku — and joining two
 * arbitrary strings with a separator is ambiguous: `("ord", "A:B")` and
 * `("ord:A", "B")` would produce the same id, and one document authorizing the
 * other's delivery is a security bug rather than a collision statistic. Both parts
 * are therefore percent-escaped before they are joined (see {@link entitlementLookupId}).
 */
import type { Entitlement, EntitlementSource, EntitlementState } from "@otta-sh/domain";
import { orderId as toOrderId, productId as toProductId, sku as toSku } from "@otta-sh/domain";
import { foldBuyerRef } from "./order-documents.js";

/** Collection name: one grant per grant-idempotency key. */
export const ENTITLEMENTS_COLLECTION = "entitlements";
/** Collection name: one pointer per authorization scope. */
export const ENTITLEMENT_LOOKUPS_COLLECTION = "entitlement_lookups";

/** One collection as the plugin descriptor declares it. */
export interface EntitlementCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The two collections the entitlement store owns, with the indexes each must
 * declare. A declared index is a **read contract**, not a performance knob: a
 * `where` on an undeclared field is a runtime `StorageQueryError`.
 *
 * - `entitlements` declares the four fields `check`'s scope query binds —
 *   `orderId`, `buyerRefLower`, `sku` and `state`. They are the document-store
 *   spelling of the SQL's two composite indices: the filter algebra is AND-only
 *   over single fields, so the composite becomes a conjunction of declarations,
 *   and `state` is declared rather than filtered in code because a page of
 *   revoked grants must not be able to hide an active one behind the limit.
 *   `state` is a two-value TEXT field, so the boolean-binding rule that forces a
 *   text mirror elsewhere in this package does not apply.
 * - `entitlement_lookups` is reached by document id alone and declares nothing.
 */
export const ENTITLEMENT_COLLECTIONS: Readonly<
	Record<string, EntitlementCollectionIndexDeclaration>
> = {
	[ENTITLEMENTS_COLLECTION]: { indexes: ["orderId", "buyerRefLower", "sku", "state"] },
	[ENTITLEMENT_LOOKUPS_COLLECTION]: {},
};

/** One granted entitlement. The document id is its grant-idempotency key. */
export interface EntitlementDoc {
	/** The entitlement's own id — minted by the store, never the document id. */
	readonly entitlementId: string;
	readonly orderId: string;
	readonly productId: string | null;
	readonly sku: string;
	/** The buyer reference as given, preserved for the returned entitlement. */
	readonly buyerRef: string;
	/** The folded buyer reference — the indexed axis, because a ref is an email. */
	readonly buyerRefLower: string;
	readonly state: EntitlementState;
	readonly source: EntitlementSource;
	readonly grantedAt: string;
}

/**
 * The document as READ.
 *
 * `buyerRefLower` is optional on this side and required on {@link EntitlementDoc},
 * which is the write side: a document written before that field existed would have no
 * value for it, and the store's normalization derives one. Typing the read side
 * separately is what keeps that guard LIVE — under a required type the `??` below is
 * unreachable code the compiler cannot see, and the day an older document turns up it
 * would be invisible to the buyer-scoped query rather than healed.
 *
 * Collections are typed to this shape, because a full {@link EntitlementDoc} is
 * assignable to it: writes stay total, reads stay honest.
 */
export type StoredEntitlementDoc = Omit<EntitlementDoc, "buyerRefLower"> & {
	readonly buyerRefLower?: string;
};

/** `entitlement_lookups/{scope}` — which grant satisfies one authorization scope. */
export interface EntitlementLookupDoc {
	/** The grant's document id: its grant-idempotency key. */
	readonly grantKey: string;
	readonly pointedAt: string;
}

/** Which axis a scope is keyed on. Kept out of the joined value, so it cannot collide. */
export type EntitlementScopeKind = "order" | "buyer";

/**
 * Escape one part of a scope id so the join is unambiguous.
 *
 * `%` first, then the separator: escaping the escape character last would make
 * `"%3A"` and `":"` collapse onto the same encoding.
 */
function escapePart(value: string): string {
	return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

/**
 * The `entitlement_lookups` document id for one scope.
 *
 * `order:{orderId}:{sku}` or `buyer:{foldedBuyerRef}:{sku}`, with both value parts
 * escaped — see this file's docblock for why an authorization key may not be built
 * by concatenating raw ids.
 */
export function entitlementLookupId(kind: EntitlementScopeKind, key: string, sku: string): string {
	return `${kind}:${escapePart(key)}:${escapePart(sku)}`;
}

/**
 * Fill the fields an older document may not carry, so a read never depends on
 * every field having existed at write time.
 *
 * `buyerRefLower` is derived rather than defaulted: it is the indexed axis, and a
 * document written without it would be invisible to the buyer-scoped query, which
 * is a missed authorization rather than a cosmetic gap.
 */
export function normalizeEntitlementDoc(doc: StoredEntitlementDoc): EntitlementDoc {
	return doc.buyerRefLower === undefined
		? { ...doc, buyerRefLower: foldBuyerRef(doc.buyerRef) }
		: { ...doc, buyerRefLower: doc.buyerRefLower };
}

/** The port's shape. `id` is the entitlement's own id, not its document id. */
export function toEntitlement(doc: EntitlementDoc): Entitlement {
	return {
		id: doc.entitlementId,
		orderId: toOrderId(doc.orderId),
		productId: doc.productId === null ? null : toProductId(doc.productId),
		sku: toSku(doc.sku),
		buyerRef: doc.buyerRef,
		state: doc.state,
		source: doc.source,
		grantedAt: doc.grantedAt,
	};
}

/** True iff this grant currently authorizes delivery. */
export function isActiveGrant(doc: EntitlementDoc): boolean {
	return doc.state === "active";
}
