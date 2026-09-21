/**
 * The cart document model: **one aggregate document per cart**, carrying its
 * lines, its embedded mutation ledger and its denormalized hold deadline, plus
 * one lookup collection the port signature forces.
 *
 * **Why one document.** Every cart invariant spans facts that must agree: one
 * line per sku, a line's qty against the ledger entry that produced it, the
 * cart's terminal state against the order id it handed off to, and the
 * once-only expiry token against the line it reaps. There is no transaction
 * here, so each of those becomes a single `compareAndSet` on `carts/{cartId}` —
 * ADR-0019 §1's rule applied to the cart aggregate.
 *
 * Three SQL features disappear into the shape rather than being reproduced:
 *
 * - **`cart_lines (cart_id, sku)` UNIQUE** becomes {@link CartDoc.lines} being a
 *   map keyed by sku. One line per sku is structural; no index enforces it, which
 *   matters because no tier here materializes a unique index at all.
 * - **The `cart_mutations` table** becomes {@link CartDoc.mutations}, read and
 *   written in the SAME compare-and-set as the line it records. That is what
 *   makes "claim the key, then write the line, then mark it completed" one atom
 *   on the cart side instead of three statements that can tear.
 * - **`reservations.expires_at <= now` as a scan target** becomes the declared,
 *   denormalized {@link CartDoc.holdExpiresAt} index — the only way the sweep can
 *   find work, since the filter algebra has no OR and cannot reach inside a map.
 *
 * **The one lookup collection.** `CartStore.recordedMutation(key)` and
 * `CartStore.expireHold(reservationId)` are handed an identifier with no cart id,
 * and an embedded map cannot be queried by its keys. So
 * {@link CART_MUTATION_INDEX_COLLECTION} maps a mutation key to its cart, for
 * exactly the reason `reservation_index` exists on the inventory side: six port
 * methods take reservation ids and a per-sku embedded hold cannot be found from an
 * id alone. It is a **locator, never the record** — the authoritative ledger entry
 * is the one inside the cart document, because that is the one that commits with
 * the line.
 *
 * **The ledger is bounded.** See {@link CART_MUTATION_LEDGER_SIZE}.
 */
import type { CartMutationKind, CartState, Currency } from "@otta-sh/domain";
import type { CollectionIndexDeclaration } from "./inventory-documents.js";

/** Collection name: the per-cart aggregate. Id is the cart id. */
export const CARTS_COLLECTION = "carts";
/** Collection name: mutation idempotency key → the cart whose ledger holds it. */
export const CART_MUTATION_INDEX_COLLECTION = "cart_mutation_index";

/**
 * The collections `EmdashCartStore` reads and writes, with the indexes each must
 * declare. A declared index is a **read contract**, not a performance knob: a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, so
 * this list and the descriptor's must not drift.
 *
 * `carts` declares the two fields ADR-0019 §4 names. `state` is for the admin
 * cart views a later increment renders; `holdExpiresAt` is what `listExpired`
 * queries, and the store would be unable to sweep without it. The lookup
 * collection declares none — every access to it is by document id.
 */
export const CART_COLLECTIONS: Readonly<Record<string, CollectionIndexDeclaration>> = {
	[CARTS_COLLECTION]: { indexes: ["state", "holdExpiresAt"] },
	[CART_MUTATION_INDEX_COLLECTION]: {},
};

/**
 * How many COMPLETED mutation records one cart document remembers.
 *
 * The ledger has to be bounded — it lives on the hot document, and a long
 * browsing session appends to it on every add, adjust and remove — but the bound
 * cannot be allowed to break the two things the ledger is for. So the rule is
 * narrow: **only `completed` records are ever pruned, oldest first, and a
 * claimed-but-incomplete record is never pruned at any age.** An incomplete
 * record is a crash marker — it is what tells a replayer to resume, and what
 * scopes the sweep's dangling-hold arm to cart-originated holds — so dropping one
 * would silently orphan a real hold.
 *
 * **Why 64 rather than a time window.** A count is checkable inside the same
 * compare-and-set that appends; an age window would need the clock to agree with
 * whatever wrote the record, and a cart's records are all within one session
 * anyway. 64 is far above a realistic cart (a 20-line cart with three edits each
 * is 80 mutations across its whole life, and the pruned ones are the oldest, long
 * since replayed), and small enough that the document stays a few kilobytes.
 *
 * **The residual, stated exactly.** A replay of a key whose completed record has
 * been evicted no longer short-circuits: `recordedMutation` returns null and the
 * mutation re-runs. Re-running is not a double-apply — `reserve`/`adjust` are
 * themselves idempotent by key in the inventory aggregate, and a re-run `add`
 * upserts the same sku line — but it does stop returning the ORIGINAL recorded
 * qty, so a replay that late answers with current truth instead. Reaching it takes
 * this many later mutations on ONE cart between a request and its retry.
 */
export const CART_MUTATION_LEDGER_SIZE = 64;

/**
 * How many ABANDONED mutation records one cart document remembers.
 *
 * An abandoned record is the audit trail of a crash the sweep reaped: its hold's
 * units are already back and its claim is retired, so it is no longer outstanding
 * work and evicting an old one reopens no window and changes no answer. It still
 * has to be bounded, because a long-lived cart that keeps crashing mid-add would
 * otherwise accumulate them forever on the hot document.
 *
 * 16 rather than 64: reaching even one of these takes a crash between a claim and
 * its completion, so a cart with sixteen of them has a problem no ledger size will
 * fix, and keeping the most recent sixteen is enough to see it in the document.
 */
export const CART_ABANDONED_LEDGER_SIZE = 16;

/**
 * One cart line. Keyed in {@link CartDoc.lines} by **sku** — the uniqueness the
 * SQL got from an index — while `lineId` remains the identifier the port's
 * `adjustLine`/`removeLine` address it by, and is preserved across an upsert
 * exactly as the SQL's `ON CONFLICT … DO UPDATE` preserved the row id.
 */
export interface CartLineDoc {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	/** Null for a digital line (Phase 4 §6), which reserves nothing. */
	reservationId: string | null;
	/**
	 * The reserve idempotency key the hold is filed under in `inventory/{sku}`.
	 * Recorded here so the hold can be read without a second lookup; null exactly
	 * when `reservationId` is.
	 */
	reserveKey: string | null;
	/** The hold deadline (ISO-8601 UTC); null when there is no reservation. */
	expiresAt: string | null;
	/**
	 * The once-only expiry token (ADR-0019 §7.7). Set by `expireHold`'s guarded
	 * flip and never cleared: the line is deleted by the completion, so a token on
	 * a still-present line means "an expiry was claimed and did not finish", which
	 * is precisely what any replayer must complete. Only the writer that MINTED it
	 * reports the expiry as won.
	 */
	expiring?: { token: string; at: string };
	createdAt: string;
	updatedAt: string;
}

/**
 * One embedded ledger entry — the uniform replay record, in the two states
 * `CartStore.claimMutation` distinguishes.
 *
 * `completed: false` is the intent claim: written BEFORE the inventory movement,
 * so a crash between the two leaves a marker that identifies the hold as
 * cart-originated and tells a replayer to resume. `completed: true` carries the
 * recorded answer, and a replay is short-circuited to it.
 */
export interface CartMutationRecord {
	kind: CartMutationKind;
	lineId: string | null;
	resultingQty: number | null;
	completed: boolean;
	claimedAt: string;
	completedAt?: string;
	/**
	 * `expireHold`'s once-only token for the CRASHED-CLAIM arm — a hold whose
	 * cart-line write never landed, so there is no line to put the token on.
	 *
	 * It deliberately does NOT retire the record: the record is what makes the
	 * dangling hold listable, and it must stay listable until the release has
	 * actually landed, or a crash between the flip and the release would orphan
	 * the stock with nothing left to find it. `abandoned` is set only afterwards.
	 */
	expiring?: { token: string; at: string };
	/**
	 * Set when the sweep has reaped the hold this claim created, so the claim can
	 * never be listed again. It is NOT `completed` — the mutation never happened —
	 * but it is no longer outstanding work, and it is not prunable either: it stays
	 * as the audit trail of a reaped crash.
	 */
	abandoned?: boolean;
}

/** `carts/{cartId}` — the aggregate. */
export interface CartDoc {
	cartId: string;
	state: CartState;
	/**
	 * The order this cart handed off to, written by `checkout` in the SAME
	 * compare-and-set as `state`, so the two are never observable apart.
	 */
	orderId: string | null;
	currency: Currency;
	/** Lines by sku. One line per sku is structural, not an index. */
	lines: Record<string, CartLineDoc>;
	/** The embedded mutation ledger by idempotency key; bounded, see the constant. */
	mutations: Record<string, CartMutationRecord>;
	/**
	 * DECLARED INDEX. The earliest instant at which this cart has expiry work:
	 * the minimum over its held lines' deadlines and over the `claimedAt` of every
	 * still-outstanding `add` claim, or null when it has none.
	 *
	 * It is a **candidate** filter, deliberately. The SQL's predicate was an OR of
	 * a stamped-deadline arm (`expires_at <= now`) and a crashed-claim arm
	 * (`expires_at IS NULL AND created_at <= cutoff`), against two different
	 * instants; the filter algebra has no OR, so both arms fold into one `<= now`
	 * field and the exact per-arm predicate is re-evaluated on the fetched
	 * document. A cart can therefore be listed and yield nothing, which costs a
	 * read and changes no answer.
	 */
	holdExpiresAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** `cart_mutation_index/{key}` — the locator, never the record. */
export interface CartMutationIndexDoc {
	cartId: string;
}

/** A fresh cart. */
export function newCartDoc(cartId: string, currency: Currency, now: string): CartDoc {
	return {
		cartId,
		state: "active",
		orderId: null,
		currency,
		lines: {},
		mutations: {},
		holdExpiresAt: null,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Normalize a stored cart so the two maps are always present. A document written
 * by an earlier build (or a hand-seeded one in a test) may lack them, and
 * `noUncheckedIndexedAccess` protects the element type, not the container.
 */
export function normalizeCartDoc(doc: CartDoc): CartDoc {
	return { ...doc, lines: doc.lines ?? {}, mutations: doc.mutations ?? {} };
}

/** The line addressed by `lineId`, or undefined — the lines map is keyed by sku. */
export function findLineById(doc: CartDoc, lineId: string): CartLineDoc | undefined {
	return Object.values(doc.lines).find((line) => line.lineId === lineId);
}

/** The line holding `reservationId`, or undefined. */
export function findLineByReservation(
	doc: CartDoc,
	reservationId: string,
): CartLineDoc | undefined {
	return Object.values(doc.lines).find((line) => line.reservationId === reservationId);
}

/**
 * Recompute the denormalized {@link CartDoc.holdExpiresAt} from the document's
 * own content — never incrementally, so it cannot drift from the lines and claims
 * it summarizes.
 *
 * An outstanding `add` claim contributes its `claimedAt`, which is always in the
 * past: the crashed-claim arm's real predicate is `claimedAt <= cutoff` and the
 * cutoff is earlier than now, so a claim must be listed as a candidate the moment
 * it exists and be rejected precisely on the fetched document.
 */
export function computeHoldExpiresAt(doc: Pick<CartDoc, "lines" | "mutations">): string | null {
	let earliest: string | null = null;
	const consider = (at: string | null): void => {
		if (at !== null && (earliest === null || at < earliest)) earliest = at;
	};
	for (const line of Object.values(doc.lines)) {
		if (line.reservationId !== null) consider(line.expiresAt);
	}
	for (const record of Object.values(doc.mutations)) {
		if (record.kind === "add" && !record.completed && record.abandoned !== true) {
			consider(record.claimedAt);
		}
	}
	return earliest;
}

/**
 * Bound the embedded ledger in the two places it can grow, and in neither case
 * touch a record that is still outstanding work.
 *
 * Three classes of record, and the rule differs per class:
 *
 * - **claimed but neither completed nor abandoned** — never pruned, at any age. It
 *   is a crash marker: it is what tells a replayer to resume, and what makes a
 *   dangling hold listable. Dropping one would orphan real stock.
 * - **completed** — the last {@link CART_MUTATION_LEDGER_SIZE} are kept, oldest
 *   evicted. Losing one costs a replay its recorded answer, nothing more.
 * - **abandoned** — the audit trail of a reaped crash, and the second thing that
 *   could grow without limit on a long-lived cart, so the last
 *   {@link CART_ABANDONED_LEDGER_SIZE} are kept. An abandoned record is not
 *   outstanding work — its hold has already been returned and its claim retired —
 *   so evicting an old one changes no answer and reopens no window.
 *
 * Each class is ordered by the store's own clock (`completedAt`, the expiry token's
 * `at`, then `claimedAt`), so a record never sorts against a foreign timestamp.
 */
export function pruneMutations(
	mutations: Readonly<Record<string, CartMutationRecord>>,
): Record<string, CartMutationRecord> {
	const entries = Object.entries(mutations);
	const evicted = new Set([
		...overBound(
			entries.filter(([, record]) => record.completed),
			CART_MUTATION_LEDGER_SIZE,
		),
		...overBound(
			entries.filter(([, record]) => !record.completed && record.abandoned === true),
			CART_ABANDONED_LEDGER_SIZE,
		),
	]);
	if (evicted.size === 0) return { ...mutations };
	return Object.fromEntries(entries.filter(([key]) => !evicted.has(key)));
}

/** The keys of everything past `keep`, oldest first. */
function overBound(entries: ReadonlyArray<[string, CartMutationRecord]>, keep: number): string[] {
	if (entries.length <= keep) return [];
	return entries
		.toSorted(([, a], [, b]) => (stampOf(a) === stampOf(b) ? 0 : stampOf(a) < stampOf(b) ? -1 : 1))
		.slice(0, entries.length - keep)
		.map(([key]) => key);
}

/** The record's own most recent timestamp, all from the store's clock. */
function stampOf(record: CartMutationRecord): string {
	return record.completedAt ?? record.expiring?.at ?? record.claimedAt;
}
