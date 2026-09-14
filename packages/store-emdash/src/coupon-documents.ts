/**
 * The coupon documents: the coupon aggregate, its code claim, the per-key
 * redemption record and the per-customer counter.
 *
 * The SQL adapter held all of this in two tables and one transaction: a guarded
 * `uses_count + 1 WHERE max_uses IS NULL OR uses_count < max_uses`, a
 * `coupon_redemptions` insert with a unique `(coupon_id, idempotency_key)`, and a
 * per-customer `COUNT(*)` taken after the row lock — with a ROLLBACK as the undo.
 * There is no transaction and no rollback here, so the same guarantees are
 * reassembled out of four documents:
 *
 * | Document | What it is |
 * |---|---|
 * | `coupons/{couponId}` | the aggregate: economics, window, `usesCount` |
 * | `coupon_codes/{foldedCode}` | the code-uniqueness claim, and the only way to reach a coupon by code |
 * | `coupon_redemptions/{couponId}:{idempotencyKey}` | the per-key claim, and then the RECORD of its outcome |
 * | `coupon_customer_caps/{couponId}:{customerId}` | the per-customer counter, as the set of keys holding a slot |
 *
 * Two of those shapes carry the whole once-only story, so they are worth stating
 * plainly.
 *
 * **The redemption document is the record, not a ring entry — and it owns the
 * right to bump.** Its id is `${couponId}:${idempotencyKey}`, so create-if-absent
 * IS the once-only guard (the storage table's primary key), and the recorded
 * {@link CouponRedemptionDoc.outcome} is what a replay reads back — for a refusal
 * exactly as much as for a success. Nothing about that is bounded: there is no
 * eviction, so no replay can ever lose its witness. Its
 * {@link CouponRedemptionDoc.state} is what makes the counter's `+1` once-only per
 * key: exactly one completer wins the move into `bumping`, so the guarded
 * statement itself carries only the CAP and a redemption never contends with a
 * peer redemption of the same coupon.
 *
 * **The per-customer counter stores KEYS, not a count.** A count would need a
 * second write to say "this key already consumed a slot", and a crash between the
 * two would either double-count (the customer loses a slot they hold) or lose the
 * claim (the cap is breached). The keys of the redemptions currently holding a
 * slot answer both questions from one document: the count is `keys.length`, and
 * claiming is adding a key that may already be there. Claim and compensation are
 * therefore idempotent by construction, and a compensation can never release
 * somebody else's slot. The array is bounded by the cap it enforces, because the
 * document exists only while a cap is in force.
 */
import type { Cents, Currency, CouponRecord, CouponSummary, CouponType } from "@otta-sh/domain";

/** Collection name: the coupon aggregate, one document per coupon. */
export const COUPONS_COLLECTION = "coupons";
/** Collection name: the code-uniqueness claim, one document per folded code. */
export const COUPON_CODES_COLLECTION = "coupon_codes";
/** Collection name: the per-key redemption claim and record. */
export const COUPON_REDEMPTIONS_COLLECTION = "coupon_redemptions";
/** Collection name: the per-customer redemption counter. */
export const COUPON_CUSTOMER_CAPS_COLLECTION = "coupon_customer_caps";

/** One collection as the plugin descriptor declares it. */
export interface CouponCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The four collections `EmdashCouponStore` owns, with the indexes each must
 * declare. A declared index is a **read contract**, not a performance knob: a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, so
 * this list and the descriptor's must not drift.
 *
 * `coupons` declares `createdAt` alone, which is what the admin list ORDERS by —
 * and ordering on an undeclared field throws exactly as filtering on one does.
 * The list's only FILTER is a code search, and that is served by the
 * `coupon_codes` claim as a document read rather than by a query, so no `code`
 * or folded-code index is declared: it would be a read contract for a query
 * that is never issued. There is deliberately no `active` index — the coupon
 * table has no active or soft-delete column at all.
 *
 * `coupon_redemptions` declares five fields, and every one of them is a port
 * method's only handle:
 *
 * - `couponId` — the delete guard counts the coupon's redemptions.
 * - `orderId` — `releaseByOrder` finds them by order.
 * - `createdAt` — `listRedemptionsCreatedBefore` both RANGES and ORDERS on it.
 * - `redemptionId` — `release` is given the generated id, not the document id.
 * - `holdsUse` — the text mirror that keeps a REFUSED key out of all three of
 *   those reads (see {@link holdsUseFor}). The `state` it mirrors is NOT indexed:
 *   nothing queries by it, and every reader that needs it has the document.
 *
 * The two counter collections are reached by document id alone and declare
 * nothing. Neither declares a unique index: uniqueness here is the claim
 * document and its create-if-absent write, never an index (no physical index
 * exists in any tier).
 */
export const COUPON_COLLECTIONS: Readonly<Record<string, CouponCollectionIndexDeclaration>> = {
	[COUPONS_COLLECTION]: { indexes: ["createdAt"] },
	[COUPON_CODES_COLLECTION]: {},
	[COUPON_REDEMPTIONS_COLLECTION]: {
		indexes: ["couponId", "orderId", "createdAt", "redemptionId", "holdsUse"],
	},
	[COUPON_CUSTOMER_CAPS_COLLECTION]: {},
};

/**
 * Whether a redemption document holds a use of its coupon, as indexed TEXT.
 *
 * A boolean cannot be bound as a `where` value on the better-sqlite3 path — it
 * reaches the driver unconverted and throws before any comparison runs — so the
 * filterable form of a flag in this package is a string mirror, exactly as
 * `publishKey` mirrors a product's `active` gate. See
 * `product-commerce-documents.ts` for the measurement behind that rule; this is
 * the same pattern and not a second invention.
 */
export type RedemptionHoldsUse = "yes" | "no";

/** The terminal answer a redemption key is recorded with. */
export type RedemptionOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "COUPON_EXHAUSTED" | "COUPON_MAX_PER_CUSTOMER" };

/**
 * The coupon aggregate.
 *
 * `usesCount` is the one field under real concurrency, and the only one written
 * by a guarded delta rather than by a read-modify-write. The guard is the cap and
 * NOTHING else, so a redemption never waits on another redemption of the same
 * coupon: the retry depth is bounded by the headroom, not by the crowd.
 *
 * `lastRedeemedKey` is stamped by that same statement, but it is NOT what makes
 * the bump once-only — the redemption document's own state machine is (see
 * `EmdashCouponStore`). It is a best-effort WITNESS for one crash seam, and a
 * peer's bump overwrites it, which is exactly why it may never be load-bearing.
 */
export interface CouponDoc {
	readonly couponId: string;
	readonly code: string;
	/** The folded code — the `coupon_codes` document id this coupon holds. */
	readonly codeKey: string;
	readonly type: CouponType;
	readonly amountCents: Cents | null;
	readonly rateBps: number | null;
	readonly capCents: Cents | null;
	readonly currency: Currency | null;
	readonly minSubtotalCents: Cents | null;
	readonly startsAt: string | null;
	readonly expiresAt: string | null;
	readonly maxUses: number | null;
	readonly maxUsesPerCustomer: number | null;
	readonly usesCount: number;
	/**
	 * The idempotency key whose `+1` the counter last applied, stamped by the
	 * guarded increment itself. A replayer that finds its own key here knows the
	 * bump landed and must not repeat it.
	 */
	readonly lastRedeemedKey: string | null;
	readonly createdAt: string;
}

/** The code claim: which coupon owns a folded code. Reached by id alone. */
export interface CouponCodeDoc {
	readonly codeKey: string;
	/** The code as the merchant typed it — the exact form `findByCode` matches. */
	readonly code: string;
	readonly couponId: string;
	readonly claimedAt: string;
}

/**
 * How far one redemption key has got. The document OWNS the right to bump the
 * global counter, and this field is that ownership:
 *
 * ```
 * claimed ──(revision CAS, exactly one winner)──► bumping ──► applied
 *                                                        └──► refused
 * ```
 *
 * The transition into `bumping` is a compare-and-set on the document's revision,
 * so of N callers completing one key exactly ONE reaches the counter and the rest
 * read the answer back. That is what makes the guarded `+1` once-only per key
 * WITHOUT the guard having to carry a witness — and therefore what keeps the
 * counter's contention bounded by the coupon's headroom instead of by the crowd.
 *
 * `bumping` carries a LEASE, so a live owner is never overtaken and a crashed one
 * does not hold the step forever.
 *
 * The states are strictly forward-moving, which is what lets `release` decide
 * whether a use was consumed by READING the state rather than by guessing:
 * `claimed` means the counter was provably never touched (the bump runs only
 * after `bumping` is durable), and `applied` means it provably was. `bumping` is
 * the one ambiguous state, and a reader that needs the answer completes it rather
 * than guessing — see `EmdashCouponStore`.
 */
export type RedemptionState = "claimed" | "bumping" | "applied" | "refused";

/**
 * One redemption key: the claim, the bump right, and then the recorded outcome.
 *
 * A non-terminal {@link RedemptionState} IS the unfinished marker; there is no
 * separate flag. Any later replayer completes it.
 */
export interface CouponRedemptionDoc {
	/** The id the port hands back, and the only handle `release` is given. */
	readonly redemptionId: string;
	readonly couponId: string;
	readonly orderId: string;
	readonly customerId: string | null;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	/** How far this key has got, and who owns the bump — {@link RedemptionState}. */
	readonly state: RedemptionState;
	/**
	 * While `bumping`: when the owner's claim on the step lapses, so a crashed owner
	 * cannot hold the step forever and a LIVE one is never overtaken. `null` in every
	 * other state. It is the same device the email-outbox lease uses, for the same
	 * reason: without it, "the owner is taking a while" and "the owner is gone" are
	 * indistinguishable, and a taker that guesses wrong bumps the counter twice.
	 */
	readonly bumpLeaseUntil: string | null;
	/** The indexed mirror of "this document holds a use" — {@link holdsUseFor}. */
	readonly holdsUse: RedemptionHoldsUse;
	/** `null` until the state is terminal; the recorded answer once it is. */
	readonly outcome: RedemptionOutcome | null;
	/**
	 * Whether this key took a per-customer slot. ADVISORY only: the slot's real
	 * record is the key's presence in {@link CouponCustomerCapDoc.keys}, so a
	 * stale or missing flag can never cause a double claim or a double release.
	 */
	readonly capClaimed: boolean;
}

/**
 * The per-customer counter, as the set of keys holding a slot.
 *
 * `keys.length` IS the count the cap is compared against. The document exists
 * only while `maxUsesPerCustomer` is in force, so the array is bounded by the cap.
 */
export interface CouponCustomerCapDoc {
	readonly couponId: string;
	readonly customerId: string;
	readonly keys: readonly string[];
}

/**
 * The ONE derivation of the indexed mirror from the state, so the two cannot
 * drift.
 *
 * Anything short of `refused` counts as holding a use: `claimed` and `bumping`
 * may be about to consume one, and treating an in-flight redemption as absent
 * would let a coupon be deleted out from under it. A REFUSED key holds nothing —
 * the SQL adapter rolled its row back entirely, and a refusal must not forbid a
 * delete, appear in the reconciliation sweep, or be released by order.
 */
export function holdsUseFor(state: RedemptionState): RedemptionHoldsUse {
	return state === "refused" ? "no" : "yes";
}

/** Is this state one the document will never move out of? */
export function isTerminalRedemption(state: RedemptionState): boolean {
	return state === "applied" || state === "refused";
}

/**
 * The folded form of a code: the `coupon_codes` document id.
 *
 * Folding is what makes the admin list's case-insensitive EXACT search a document
 * read rather than a scan. `findByCode` stays case-SENSITIVE by comparing the
 * claim's stored `code`, so the SQL adapter's `WHERE code = ?` semantics survive.
 */
export function foldCouponCode(code: string): string {
	return code.toLowerCase();
}

/** The redemption document id: the once-only guard for `(couponId, key)`. */
export function couponRedemptionDocId(couponId: string, idempotencyKey: string): string {
	return `${couponId}:${idempotencyKey}`;
}

/** The per-customer counter document id. */
export function couponCustomerCapId(couponId: string, customerId: string): string {
	return `${couponId}:${customerId}`;
}

/**
 * Fill in what an older document may not carry, and RE-DERIVE the mirror rather
 * than trust it: a document written by any path that set an outcome without its
 * mirror would otherwise read as refused while filtering as live.
 */
export function normalizeCouponDoc(doc: CouponDoc): CouponDoc {
	return { ...doc, usesCount: doc.usesCount ?? 0, lastRedeemedKey: doc.lastRedeemedKey ?? null };
}

/** As above, for a redemption document. */
export function normalizeRedemptionDoc(doc: CouponRedemptionDoc): CouponRedemptionDoc {
	const state = doc.state ?? "claimed";
	return {
		...doc,
		state,
		bumpLeaseUntil: doc.bumpLeaseUntil ?? null,
		outcome: doc.outcome ?? null,
		holdsUse: holdsUseFor(state),
		capClaimed: doc.capClaimed ?? false,
	};
}

/** As above, for a per-customer counter document. */
export function normalizeCustomerCapDoc(doc: CouponCustomerCapDoc): CouponCustomerCapDoc {
	return { ...doc, keys: doc.keys ?? [] };
}

/** The port's record, rebuilt from the document (`createdAt` is summary-only). */
export function toCouponRecord(doc: CouponDoc): CouponRecord {
	return {
		id: doc.couponId,
		code: doc.code,
		type: doc.type,
		amountCents: doc.amountCents,
		rateBps: doc.rateBps,
		capCents: doc.capCents,
		currency: doc.currency,
		minSubtotalCents: doc.minSubtotalCents,
		startsAt: doc.startsAt,
		expiresAt: doc.expiresAt,
		maxUses: doc.maxUses,
		maxUsesPerCustomer: doc.maxUsesPerCustomer,
		usesCount: doc.usesCount,
	};
}

/** The admin-list row: every record field plus the ordering column. */
export function toCouponSummary(doc: CouponDoc): CouponSummary {
	return { ...toCouponRecord(doc), createdAt: doc.createdAt };
}
