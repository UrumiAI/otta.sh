/**
 * `CouponStore` over the EmDash plugin-storage primitives.
 *
 * ## What the SQL guaranteed, and what replaces it
 *
 * One statement carried the whole no-over-redeem invariant:
 * `UPDATE coupons SET uses_count = uses_count + 1 WHERE id = :id AND (max_uses IS
 * NULL OR uses_count < max_uses)`, with zero rows meaning exhausted. Around it,
 * one transaction held a `coupon_redemptions` insert (unique on
 * `(coupon_id, idempotency_key)`) and a per-customer `COUNT(*)` taken AFTER the
 * bump had locked the coupon row — and a per-customer refusal was undone by
 * rolling the transaction back.
 *
 * | The SQL | Here |
 * |---|---|
 * | the `OR` inside one guard | TWO client-side branches: a guarded `updateIf` when `maxUses` is set, an unguarded delta when it is not — an uncapped coupon has no invariant to violate |
 * | the insert conflict that made one caller of a key wait for the winner | the key document's OWN state: `claimed → bumping` is a revision compare-and-set exactly one completer wins |
 * | the unique `(coupon_id, idempotency_key)` | the document id `coupon_redemptions/{couponId}:{idempotencyKey}`, claimed create-if-absent |
 * | the per-customer `COUNT(*)` under the row lock | `coupon_customer_caps/{couponId}:{customerId}`, claimed BEFORE the bump |
 * | `ROLLBACK` undoing a per-customer refusal | an explicit, idempotent compensation — the inverted order is what makes one possible |
 * | `uses_count - 1 WHERE uses_count > 0` | the mirror-image `updateIf` guard, the one place a decrement stays lock-free |
 * | `DELETE … WHERE NOT EXISTS (redemptions)` | a `count()` on the coupon's redemptions, read before the delete, with the same typed result |
 *
 * The two `updateIf` sites are the whole of this store's lock-free path, and they
 * are the first in the package: every other write here — and every write in every
 * sibling adapter — is a `compareAndSet` read-modify-write. A counter whose entire
 * invariant is one comparison on one field is exactly what the guarded statement
 * is for.
 *
 * ## The redemption state machine
 *
 * The key document `coupon_redemptions/{couponId}:{idempotencyKey}` OWNS the right
 * to move the counter, and its state is that ownership:
 *
 * ```
 *   read coupons/{couponId}            (no write yet: an unknown coupon throws)
 *        │
 *   1. claim the key document          create-if-absent, full intent, `claimed`
 *        ├── already TERMINAL ───────► return the RECORDED answer; no counter moves
 *        │
 *   2. claim the per-customer slot     add the key to coupon_customer_caps/…
 *        │                            (idempotent: the key may already be there)
 *        ├── the cap is full ────────► record COUPON_MAX_PER_CUSTOMER, and NO
 *        │                            global headroom was ever consumed
 *   3. take the BUMP RIGHT             `claimed → bumping`, a revision CAS that
 *        │                            exactly ONE completer wins, under a LEASE
 *        ├── lost ──────────────────► read the winner's answer back; take over only
 *        │                            once their lease has lapsed
 *   4. bump the counter                updateIf guarded on the CAP ALONE when
 *        │                            capped, a plain delta when not
 *        ├── refused ───────────────► release the slot (idempotent), record
 *        │                            COUPON_EXHAUSTED
 *   5. record `applied` on the key document
 * ```
 *
 * **Why step 3 exists, and why the guard carries nothing but the cap.** N callers
 * completing ONE idempotency key — which is what a retried checkout looks like —
 * must add exactly one use. Making the guarded statement itself once-only would mean
 * pinning a per-key witness in its `where`, which turns the delta into a revision
 * compare-and-set: every redemption would then contend with every other redemption
 * of the same coupon, and the retry depth would grow with the CROWD (50 racers
 * against a 24-attempt ceiling exhaust it on a coupon with 95 uses left). So
 * once-only lives in the key document instead, where it is per KEY and contends with
 * nothing, and the counter's guard is the invariant and nothing else. A redemption's
 * guard can then fail for exactly one reason — the coupon reached its cap — which
 * the next read settles, so the counter's attempt depth is 2 in the worst case
 * however large the crowd.
 *
 * **Every step is idempotent, and the ORDER is the invariant.** A per-customer
 * rejection never consumes global headroom, because step 4 is not reached. A refused
 * bump never leaves a per-customer count consumed, because step 4's refusal path
 * compensates step 2 — and that compensation is "remove this key from the set", so it
 * cannot run twice and cannot release a slot that is not this key's.
 *
 * **The lease is what makes the takeover safe.** A step held by a live owner and a
 * step held by a crashed one look identical, and a taker that guesses wrong bumps
 * twice — which is why `bumping` carries `bumpLeaseUntil` and a waiter takes over
 * only after it lapses. Until then it reads, and if it runs out of patience it raises
 * the typed retryable failure so the caller's own retry observes the answer. This is
 * the email-outbox lease, applied to the same problem.
 *
 * **The seams, and the one that is inexact.** A crash between 2 and 4 leaves a
 * claimed-but-unapplied key that any later replayer completes with counters exact: it
 * finds its own key already in the slot set, wins the bump right, and bumps once. A
 * crash between 4 and 5 leaves the key `bumping`, and THAT is the one seam a guarded
 * delta cannot make exact from another document: the taker recognises a surviving
 * `lastRedeemedKey` witness and does not repeat the bump, but a peer's redemption can
 * overwrite the witness, and then the taker re-bumps. The counter therefore ends at
 * most ONE HIGH per crash in that seam — never low. High refuses a redemption that
 * might have fit; it never grants one that does not, which is the same direction as
 * the release residual below, and it is asserted rather than argued in
 * `test/coupon-crash-seams.dialects.test.ts`.
 *
 * ## Reading a coupon by code
 *
 * `coupons` is keyed by coupon id, because `redeem`, `findById`, `update` and
 * `delete` are all given an id and the money path must not pay a lookup to reach
 * the counter — and because the admin list is keyset-ordered on `(createdAt, id)`,
 * which is the host's own total order only when the document id IS that id. The
 * code is a claim document, `coupon_codes/{foldedCode}`, which is both the
 * uniqueness enforcement and the way `findByCode` and the list's case-insensitive
 * exact search reach a coupon — as a document read, never a scan.
 */
import {
	customerId as toCustomerId,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	type Clock,
	type CouponListFilter,
	type CouponListPage,
	type CouponListResult,
	type CouponRecord,
	type CouponRedemption,
	type CouponStore,
	type CreateCouponInput,
	type DeleteCouponResult,
	type IdGen,
	type OrderId,
	type RedeemCouponInput,
	type RedeemResult,
	type UpdateCouponInput,
	type UpdateCouponResult,
} from "@otta-sh/domain";
import {
	CAS_BASE_DELAY_MS,
	CAS_MAX_ATTEMPTS,
	CAS_MAX_DELAY_MS,
	CAS_RETRY,
	casDone,
	isStorageContentionError,
	StorageContentionError,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import {
	COUPON_CODES_COLLECTION,
	COUPON_CUSTOMER_CAPS_COLLECTION,
	COUPON_REDEMPTIONS_COLLECTION,
	COUPONS_COLLECTION,
	couponCustomerCapId,
	couponRedemptionDocId,
	foldCouponCode,
	holdsUseFor,
	isTerminalRedemption,
	normalizeCouponDoc,
	normalizeCustomerCapDoc,
	normalizeRedemptionDoc,
	toCouponRecord,
	toCouponSummary,
	type CouponCodeDoc,
	type CouponCustomerCapDoc,
	type CouponDoc,
	type CouponRedemptionDoc,
	type RedemptionOutcome,
} from "./coupon-documents.js";
import {
	CouponCodeConflictError,
	CouponIdCollisionError,
	CouponNotFoundError,
} from "./coupon-errors.js";
import { ScanPageLimitError } from "./errors.js";
// The two plain code-unit comparators every admin list in this package sorts with.
// They live with the product-commerce documents because that list needed them
// first; sharing them is what keeps "the adapter's total order" one order.
import { codeUnitAsc, codeUnitDesc } from "./product-commerce-documents.js";
import type { OrderBy, StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const LIST_PAGE_SIZE = 100;

/**
 * Page ceiling for every bounded scan in this store. Reaching it is a typed
 * {@link ScanPageLimitError}, never a silently short list.
 */
const MAX_LIST_PAGES = 1000;

/**
 * Rounds of the claim-resolution loop. A create-if-absent claim can only fail
 * because a document now exists, so one re-read resolves it; the second round is
 * the margin, and exhausting it is contention rather than a bare failure.
 */
const CLAIM_ROUNDS = 2;

/**
 * How long a completer owns the bump step before another may take it over, in
 * milliseconds.
 *
 * It is a LEASE, and it is what makes the takeover safe rather than a guess: a live
 * owner needs one round trip to finish and is therefore never overtaken, while a
 * crashed one's key becomes completable the moment its lease lapses. Ten seconds is
 * generous against a redemption whose whole retry budget is under a second, and
 * short against any human-noticeable wait; it is the same device — and the same
 * reasoning — as the email-outbox lease.
 */
export const COUPON_BUMP_LEASE_MS = 10_000;

/**
 * How many times a completer that LOST the bump right re-reads the key document
 * while its owner's lease is still live.
 *
 * This is LATENCY, not correctness: the lease above decides whether a takeover is
 * allowed at all, and this only decides how long a caller is willing to wait for an
 * answer it can read instead of recompute. It shares the package's one budget knob
 * (`maxCasAttempts`), so a suite that wants a short wait asks for a short budget. Running out is the typed retryable
 * failure, never a takeover of a live owner. Backoff is the same jittered schedule
 * the retry loop uses.
 */
const BUMP_WAIT_ATTEMPTS = CAS_MAX_ATTEMPTS;

export interface EmdashCouponStoreOptions {
	/** The collections the plugin descriptor declared (`COUPON_COLLECTIONS`). */
	storage: StorageAccess;
	/** Mints redemption ids, exactly as the SQL adapter's `uuidIdGen` did. */
	idGen: IdGen;
	/** Stamps `createdAt` on `create()` — the admin list's ordering column. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for the bounded scans. Default 1000. */
	maxListPages?: number;
	/** Override the bump step's lease, in ms. Defaults to {@link COUPON_BUMP_LEASE_MS}. */
	bumpLeaseMs?: number;
}

/** What one resolved redemption claim is: the document, and how it got there. */
interface ResolvedClaim {
	readonly docId: string;
	readonly doc: CouponRedemptionDoc;
	/** True when the claim already existed — the SQL's insert-conflict path. */
	readonly replayed: boolean;
}

export class EmdashCouponStore implements CouponStore {
	readonly #coupons: StorageCollection<CouponDoc>;
	readonly #codes: StorageCollection<CouponCodeDoc>;
	readonly #redemptions: StorageCollection<CouponRedemptionDoc>;
	readonly #caps: StorageCollection<CouponCustomerCapDoc>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxListPages: number;
	readonly #bumpLeaseMs: number;

	constructor(options: EmdashCouponStoreOptions) {
		this.#coupons = collectionOf<CouponDoc>(options.storage, COUPONS_COLLECTION);
		this.#codes = collectionOf<CouponCodeDoc>(options.storage, COUPON_CODES_COLLECTION);
		this.#redemptions = collectionOf<CouponRedemptionDoc>(
			options.storage,
			COUPON_REDEMPTIONS_COLLECTION,
		);
		this.#caps = collectionOf<CouponCustomerCapDoc>(
			options.storage,
			COUPON_CUSTOMER_CAPS_COLLECTION,
		);
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxListPages = options.maxListPages ?? MAX_LIST_PAGES;
		this.#bumpLeaseMs = options.bumpLeaseMs ?? COUPON_BUMP_LEASE_MS;
	}

	// -- the coupon row --------------------------------------------------------

	/**
	 * Mint a coupon: claim its code, then create its document.
	 *
	 * The code claim comes FIRST, as every claim in this package does — a document
	 * that exists is reachable, and a claim that outlives its owner is taken over
	 * rather than left to block the code forever (see {@link #claimCode}).
	 */
	async create(input: CreateCouponInput): Promise<CouponRecord> {
		const now = this.#clock.now().toISOString();
		const codeKey = foldCouponCode(input.code);
		await this.#claimCode(codeKey, input.code, input.id, now);
		const doc: CouponDoc = {
			couponId: input.id,
			code: input.code,
			codeKey,
			type: input.type,
			amountCents: input.amountCents,
			rateBps: input.rateBps,
			capCents: input.capCents,
			currency: input.currency,
			minSubtotalCents: input.minSubtotalCents,
			startsAt: input.startsAt,
			expiresAt: input.expiresAt,
			maxUses: input.maxUses,
			maxUsesPerCustomer: input.maxUsesPerCustomer,
			usesCount: 0,
			lastRedeemedKey: null,
			createdAt: now,
		};
		const written = await this.#coupons.compareAndSet(input.id, null, doc);
		if (!written.applied) {
			// The code claim was taken for a coupon this call is NOT going to create. Give
			// it back, or the code is stranded pointing at a coupon that carries a
			// different one — an alias no reader could ever resolve correctly.
			await this.#releaseCode(doc);
			throw new CouponIdCollisionError(input.id);
		}
		return toCouponRecord(doc);
	}

	async findById(couponId: string): Promise<CouponRecord | null> {
		const doc = await this.#coupons.get(couponId);
		return doc === null ? null : toCouponRecord(normalizeCouponDoc(doc));
	}

	/**
	 * Reach a coupon by its code, through the claim document.
	 *
	 * The match stays case-SENSITIVE — the claim is keyed by the folded code, but
	 * the code it stores is the one the merchant typed, and that is what is
	 * compared. The SQL's `WHERE code = ?` therefore keeps its exact semantics,
	 * while the admin list's deliberately case-INSENSITIVE search uses the same
	 * document with the comparison dropped.
	 */
	async findByCode(code: string): Promise<CouponRecord | null> {
		const doc = await this.#couponByCode(code, { fold: false });
		return doc === null ? null : toCouponRecord(doc);
	}

	/**
	 * Edit the economics + window. LWW by port contract (no `stale` outcome), but
	 * written as a read-modify-write compare-and-set rather than a blind put —
	 * `usesCount` and its witness are store-owned and move under real concurrency,
	 * and a blind put would roll a concurrent redemption's bump back.
	 */
	async update(couponId: string, input: UpdateCouponInput): Promise<UpdateCouponResult> {
		return this.#cas<UpdateCouponResult>("updateCoupon", async () => {
			const current = await this.#coupons.getVersioned(couponId);
			if (current === null) return casDone<UpdateCouponResult>({ ok: false, reason: "not_found" });
			const doc = normalizeCouponDoc(current.value);
			const next: CouponDoc = {
				...doc,
				amountCents: input.amountCents,
				rateBps: input.rateBps,
				capCents: input.capCents,
				minSubtotalCents: input.minSubtotalCents,
				startsAt: input.startsAt,
				expiresAt: input.expiresAt,
				maxUses: input.maxUses,
				maxUsesPerCustomer: input.maxUsesPerCustomer,
			};
			const written = await this.#coupons.compareAndSet(couponId, current.revision, next);
			return written.applied
				? casDone<UpdateCouponResult>({ ok: true, coupon: toCouponRecord(next) })
				: CAS_RETRY;
		});
	}

	/**
	 * Delete a coupon, forbidden while a redemption references it.
	 *
	 * The guard is one `count()` over the coupon's redemptions that HOLD a use —
	 * the indexed `holdsUse` mirror is what keeps a refused key (whose SQL row was
	 * rolled back and never existed) from forbidding a delete. A redemption still
	 * in flight counts as holding one, which is the conservative direction.
	 *
	 * **A refused key's document is NOT removed by a delete, and outlives the coupon.**
	 * It holds no use, so it never forbids the delete; it stays because it is the
	 * record that makes a replay of that idempotency key answer the same way twice,
	 * and because document ids are never reused. Nothing reads it after its coupon is
	 * gone — `redeem` reads the coupon first and throws — so it is inert history,
	 * collectable by a sweep and by nothing on a request path.
	 *
	 * The count and the delete are two statements, where the SQL was one
	 * conditional `DELETE`. A `redeem` that reads the coupon between them can still
	 * claim a key against a coupon this call then removes; nothing is miscounted
	 * when it does — the redeem finds no document to bump and records a refusal —
	 * and the ordering inside `redeem` (read the coupon before any write) is what
	 * keeps the common interleaving on the safe side.
	 */
	async delete(couponId: string): Promise<DeleteCouponResult> {
		const doc = await this.#coupons.get(couponId);
		if (doc === null) return { ok: false, reason: "not_found" };
		const holding = await this.#redemptions.count({ couponId, holdsUse: "yes" });
		if (holding > 0) return { ok: false, reason: "in_use_by_redemptions" };
		const removed = await this.#coupons.delete(couponId);
		if (!removed) return { ok: false, reason: "not_found" };
		await this.#releaseCode(normalizeCouponDoc(doc));
		return { ok: true };
	}

	// -- redemption ------------------------------------------------------------

	async redeem(input: RedeemCouponInput): Promise<RedeemResult> {
		// The coupon is read BEFORE anything is written: an unknown coupon must not
		// leave a claim behind (the SQL's foreign key would have refused the insert),
		// and the branch decision needs `maxUses` and `maxUsesPerCustomer`.
		const coupon = await this.#requireCoupon(input.couponId);
		const claim = await this.#resolveClaim(input);
		const answer = await this.#advance(coupon, claim);
		// The compensation is a property of the ANSWER, not of one code path. A caller
		// that lost the bump right can claim its slot AFTER the winner has already
		// refused and compensated, so re-asserting it here is what makes "a global
		// refusal never leaves a per-customer count consumed" true for every caller
		// rather than for the one that ran the refusal. Removing a key that is already
		// gone is a no-op, which is why this can be unconditional.
		if (
			!answer.ok &&
			answer.reason === "COUPON_EXHAUSTED" &&
			capInForce(coupon, claim.doc) !== null
		) {
			await this.#releaseCustomerSlot(claim.doc);
		}
		return answer;
	}

	/**
	 * Release one redemption: free the per-customer slot, delete the record, and
	 * decrement — in that order, and each step idempotent.
	 *
	 * The DELETE is the once-only claim of the decrement. Two concurrent releases of
	 * the same id both remove the same key from the per-customer set (idempotent,
	 * and only ever this key's slot), but exactly one wins the guarded delete and
	 * exactly one decrement follows. A crash between the delete and the decrement
	 * leaves `usesCount` one HIGH — a use nobody holds, which refuses a redemption
	 * that might have fit and never grants one that does not. That is the only
	 * direction a two-document release can fail in without a transaction, and it is
	 * the safe one.
	 */
	async release(redemptionId: string): Promise<void> {
		const found = await this.#findByRedemptionId(redemptionId);
		if (found === null) return;
		await this.#releaseClaim(found.docId, found.doc);
	}

	async releaseByOrder(orderId: OrderId): Promise<number> {
		const found = await this.#scanRedemptions("releaseByOrder", { orderId, holdsUse: "yes" }, {});
		let released = 0;
		for (const entry of found) {
			if (await this.#releaseClaim(entry.docId, entry.doc)) released++;
		}
		return released;
	}

	/**
	 * The reconciliation read: redemptions created strictly before `cutoff`.
	 *
	 * Ordered `(createdAt, redemptionId)` exactly as the SQL's `ORDER BY created_at,
	 * id` was — `redemptionId` is the row id the SQL ordered on, and it is a field
	 * here rather than the document id. A REFUSED key is not listed: the SQL rolled
	 * its row back, so the sweep never saw one.
	 */
	async listRedemptionsCreatedBefore(cutoff: string): Promise<CouponRedemption[]> {
		const found = await this.#scanRedemptions(
			"listRedemptionsCreatedBefore",
			{ createdAt: { lt: cutoff }, holdsUse: "yes" },
			{ createdAt: "asc" },
		);
		return found
			.map((entry) => entry.doc)
			.toSorted(
				(a, b) =>
					codeUnitAsc(a.createdAt, b.createdAt) || codeUnitAsc(a.redemptionId, b.redemptionId),
			)
			.map((doc) => ({
				id: doc.redemptionId,
				couponId: doc.couponId,
				orderId: toOrderId(doc.orderId),
				customerId: doc.customerId === null ? null : toCustomerId(doc.customerId),
				idempotencyKey: toIdempotencyKey(doc.idempotencyKey),
				createdAt: doc.createdAt,
			}));
	}

	// -- the admin list --------------------------------------------------------

	/**
	 * The admin Coupons list: keyset-ordered `createdAt DESC, id DESC`.
	 *
	 * `search` is a case-insensitive EXACT match on the code, and it is resolved
	 * through the `coupon_codes` claim — one document read instead of a scan, and
	 * the strictest possible reading of "exact", since a folded code either names a
	 * claim or names nothing.
	 *
	 * With no search the `coupons` index is paged under a coarse `createdAt` bound
	 * and the exact cursor position is applied in memory, because the filter algebra
	 * is AND-only and a keyset seek is a disjunction. The scan drains past its
	 * boundary tie group before slicing, so a page boundary inside a group of
	 * identical `createdAt` values cannot depend on the host's collation.
	 */
	async listCoupons(filter: CouponListFilter, page: CouponListPage): Promise<CouponListResult> {
		const cursor = page.cursor ?? null;
		if (filter.search !== undefined) {
			const doc = await this.#couponByCode(filter.search, { fold: true });
			const rows = doc !== null && isAfterCursor(doc, cursor) ? [toCouponSummary(doc)] : [];
			return { coupons: rows.slice(0, page.limit), nextCursor: null };
		}
		// `limit + 1` is the port's own next-page probe: one row past the page decides
		// whether `nextCursor` is a position or null.
		const wanted = page.limit + 1;
		const scanned = await this.#scanCoupons("listCoupons", couponListWhere(cursor), wanted, (doc) =>
			isAfterCursor(doc, cursor),
		);
		const merged = scanned.toSorted(byNewestFirst).slice(0, wanted);
		const returned = merged.length > page.limit ? merged.slice(0, page.limit) : merged;
		const last = returned.at(-1);
		const nextCursor =
			merged.length > page.limit && last !== undefined
				? { createdAt: last.createdAt, couponId: last.couponId }
				: null;
		return { coupons: returned.map(toCouponSummary), nextCursor };
	}

	/**
	 * The count that captions the page — the SAME predicate, by construction. With
	 * no search it is one `count()` over the collection; with one it is the presence
	 * of a single claim document, which is what the list itself reads.
	 */
	async countCoupons(filter: CouponListFilter): Promise<number> {
		if (filter.search !== undefined) {
			return (await this.#couponByCode(filter.search, { fold: true })) === null ? 0 : 1;
		}
		return this.#coupons.count();
	}

	// -- internals: the coupon row --------------------------------------------

	async #requireCoupon(couponId: string): Promise<CouponDoc> {
		const doc = await this.#coupons.get(couponId);
		if (doc === null) throw new CouponNotFoundError(couponId);
		return normalizeCouponDoc(doc);
	}

	/**
	 * Take the code claim, or prove it is genuinely held.
	 *
	 * A claim whose owning coupon is GONE, or whose owner no longer carries this
	 * code, is taken over on its own revision: otherwise a crash between deleting a
	 * coupon and releasing its code would strand that code permanently, and a
	 * uniqueness rule that can be broken by a crash is not one.
	 */
	async #claimCode(codeKey: string, code: string, couponId: string, now: string): Promise<void> {
		const mine: CouponCodeDoc = { codeKey, code, couponId, claimedAt: now };
		return this.#cas<void>("createCoupon", async () => {
			const current = await this.#codes.getVersioned(codeKey);
			if (current === null) {
				const written = await this.#codes.compareAndSet(codeKey, null, mine);
				return written.applied ? casDone(undefined) : CAS_RETRY;
			}
			const held = current.value;
			if (held.couponId === couponId) return casDone(undefined);
			const owner = await this.#coupons.get(held.couponId);
			if (owner !== null && owner.codeKey === codeKey) {
				throw new CouponCodeConflictError(code, held.couponId);
			}
			const written = await this.#codes.compareAndSet(codeKey, current.revision, mine);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/** Drop a deleted coupon's code claim, iff it is still the coupon's own. */
	async #releaseCode(doc: CouponDoc): Promise<void> {
		const current = await this.#codes.getVersioned(doc.codeKey);
		if (current === null || current.value.couponId !== doc.couponId) return;
		// A refusal means a peer already re-claimed the code for another coupon, which
		// is exactly the state this call wanted to reach.
		await this.#codes.compareAndDelete(doc.codeKey, current.revision);
	}

	/** The coupon a code names, folded or exact — the claim document, then a read. */
	async #couponByCode(code: string, options: { fold: boolean }): Promise<CouponDoc | null> {
		const claim = await this.#codes.get(foldCouponCode(code));
		if (claim === null) return null;
		if (!options.fold && claim.code !== code) return null;
		const doc = await this.#coupons.get(claim.couponId);
		return doc === null ? null : normalizeCouponDoc(doc);
	}

	// -- internals: redemption -------------------------------------------------

	/**
	 * Resolve the per-key claim: read it, or create it carrying the whole intent.
	 *
	 * A create-if-absent refusal can only mean a document now exists, so one re-read
	 * settles it; the loop is bounded and exhausting it is typed contention rather
	 * than a bare failure.
	 */
	async #resolveClaim(input: RedeemCouponInput): Promise<ResolvedClaim> {
		const docId = couponRedemptionDocId(input.couponId, input.idempotencyKey);
		for (let round = 0; round < CLAIM_ROUNDS; round++) {
			const current = await this.#redemptions.get(docId);
			if (current !== null) {
				return { docId, doc: normalizeRedemptionDoc(current), replayed: true };
			}
			const fresh: CouponRedemptionDoc = {
				redemptionId: this.#idGen.newId(),
				couponId: input.couponId,
				orderId: input.orderId,
				customerId: input.customerId ?? null,
				idempotencyKey: input.idempotencyKey,
				createdAt: input.createdAt,
				state: "claimed",
				holdsUse: holdsUseFor("claimed"),
				bumpLeaseUntil: null,
				outcome: null,
				capClaimed: false,
			};
			const written = await this.#redemptions.compareAndSet(docId, null, fresh);
			if (written.applied) return { docId, doc: fresh, replayed: false };
		}
		// Two rounds that each found no document and then lost the create can only
		// happen if the key is being deleted underneath the claim as fast as it is
		// made. That is contention beyond what this loop can resolve, and it is the
		// same typed retryable failure an exhausted retry budget raises — nothing was
		// applied, so the call is safe to re-issue.
		throw new StorageContentionError("redeem", CLAIM_ROUNDS);
	}

	/** Drive a resolved claim to its answer, from whichever state it is in. */
	async #advance(coupon: CouponDoc, claim: ResolvedClaim): Promise<RedeemResult> {
		const { state, outcome } = claim.doc;
		if (isTerminalRedemption(state) && outcome !== null) return answerOf(claim.doc, outcome, true);
		if (state === "bumping") return this.#awaitOrTakeOver(coupon, claim);
		return this.#fromClaimed(coupon, claim);
	}

	/**
	 * The ordinary path: take the per-customer slot, then take the RIGHT to bump.
	 *
	 * Losing the right is not a failure and not a retry of the bump — it means a peer
	 * completing the same key owns the counter write, and this caller's job is to read
	 * that caller's answer.
	 */
	async #fromClaimed(coupon: CouponDoc, claim: ResolvedClaim): Promise<RedeemResult> {
		const cap = capInForce(coupon, claim.doc);
		if (cap !== null && !(await this.#claimCustomerSlot(claim.doc, cap))) {
			// Step 3 was never reached, so no global headroom was consumed and there is
			// nothing to compensate.
			return this.#finish(claim, { ok: false, reason: "COUPON_MAX_PER_CUSTOMER" });
		}
		const owned = await this.#takeBumpRight(claim, cap !== null, "fresh");
		if (owned === null) return this.#awaitOrTakeOver(coupon, claim);
		return this.#runBump(coupon, { ...claim, doc: owned }, cap !== null);
	}

	/**
	 * Move the key document into `bumping` on its own revision — the once-only gate
	 * on the counter.
	 *
	 * Of N callers holding the same revision exactly one wins, and the winner is the
	 * only one that touches `usesCount`. WHICH state it is allowed to move out of is
	 * the caller's to say, and it is load-bearing:
	 *
	 * - `"fresh"` takes the step only from `claimed`. A caller that arrives to find the
	 *   step already owned must NOT take it, or a late completer of the same key would
	 *   walk straight past a live owner and bump a second time.
	 * - `"lapsed"` takes it from a `bumping` document whose lease has run out — the
	 *   healing path, re-checking the lease against the revision it is about to write,
	 *   so an owner that renewed in the meantime is not overtaken.
	 *
	 * Returns the document as written, or `null` when the step was not available.
	 */
	async #takeBumpRight(
		claim: ResolvedClaim,
		capClaimed: boolean,
		from: "fresh" | "lapsed",
	): Promise<CouponRedemptionDoc | null> {
		const current = await this.#redemptions.getVersioned(claim.docId);
		if (current === null) return null;
		const doc = normalizeRedemptionDoc(current.value);
		if (isTerminalRedemption(doc.state)) return null;
		if (from === "fresh" ? doc.state !== "claimed" : !this.#leaseLapsed(doc)) return null;
		const next: CouponRedemptionDoc = {
			...doc,
			state: "bumping",
			holdsUse: holdsUseFor("bumping"),
			bumpLeaseUntil: new Date(this.#clock.now().getTime() + this.#bumpLeaseMs).toISOString(),
			capClaimed: doc.capClaimed || capClaimed,
		};
		const written = await this.#redemptions.compareAndSet(claim.docId, current.revision, next);
		return written.applied ? next : null;
	}

	/**
	 * Somebody else owns the bump: read their answer back, and take the step over only
	 * once their LEASE has lapsed.
	 *
	 * The lease is what separates "slow" from "gone". A live owner is never overtaken,
	 * however long this caller has been waiting, so a crowd completing one key adds
	 * exactly one use no matter how the crowd is scheduled. A lapsed lease means the
	 * owner is not coming back, and then the takeover is the healing path.
	 *
	 * Running out of patience while the lease is still live is the typed RETRYABLE
	 * failure — the caller's own retry will read the recorded answer — never a
	 * takeover. A document that VANISHES while being waited on was released underneath
	 * this call, and there is no honest answer to return for that either.
	 */
	async #awaitOrTakeOver(coupon: CouponDoc, claim: ResolvedClaim): Promise<RedeemResult> {
		const patience = this.#retry.maxAttempts ?? BUMP_WAIT_ATTEMPTS;
		for (let attempt = 1; attempt <= patience; attempt++) {
			const doc = await this.#redemptions.get(claim.docId);
			if (doc === null) throw new StorageContentionError("redeem", attempt);
			const settled = normalizeRedemptionDoc(doc);
			if (settled.outcome !== null) {
				this.#retry.onAttempts?.("redeemAwait", attempt);
				return answerOf(settled, settled.outcome, true);
			}
			if (this.#leaseLapsed(settled)) {
				this.#retry.onAttempts?.("redeemAwait", attempt);
				return this.#takeOverBump(coupon, { ...claim, doc: settled });
			}
			await this.#backoff(attempt);
		}
		this.#retry.onAttempts?.("redeemAwait", patience);
		throw new StorageContentionError("redeem", patience);
	}

	/** Has the owner of this step stopped owning it? A `claimed` doc owns nothing. */
	#leaseLapsed(doc: CouponRedemptionDoc): boolean {
		if (doc.state !== "bumping") return true;
		const until = doc.bumpLeaseUntil;
		return until === null || until <= this.#clock.now().toISOString();
	}

	/**
	 * Finish a step whose owner never came back.
	 *
	 * THE ONE INEXACT SEAM, stated plainly. The predecessor may have crashed after
	 * its `+1` landed but before it recorded the answer, and a guarded delta cannot
	 * be made idempotent from another document. Where the witness survives — the
	 * common case, since a crash window is short — the bump is recognised and NOT
	 * repeated. Where a peer's redemption has overwritten it, this taker re-bumps, so
	 * the counter ends at most ONE HIGH per crash in this seam. High refuses a
	 * redemption that might have fit; it never grants one that does not, which is the
	 * same direction (and the same reasoning) as the release residual.
	 */
	async #takeOverBump(coupon: CouponDoc, claim: ResolvedClaim): Promise<RedeemResult> {
		const cap = capInForce(coupon, claim.doc);
		// Idempotent by key: re-claiming a slot this key already holds is a no-op, and
		// a takeover from `claimed` may be the first to take it at all.
		if (cap !== null && !(await this.#claimCustomerSlot(claim.doc, cap))) {
			return this.#finish(claim, { ok: false, reason: "COUPON_MAX_PER_CUSTOMER" });
		}
		const owned = await this.#takeBumpRight(claim, cap !== null, "lapsed");
		if (owned === null) {
			const doc = await this.#redemptions.get(claim.docId);
			const settled = doc === null ? null : normalizeRedemptionDoc(doc);
			if (settled !== null && settled.outcome !== null) {
				return answerOf(settled, settled.outcome, true);
			}
			throw new StorageContentionError("redeem", this.#retry.maxAttempts ?? BUMP_WAIT_ATTEMPTS);
		}
		const taken = { ...claim, doc: owned };
		const live = await this.#coupons.get(coupon.couponId);
		if (live !== null && normalizeCouponDoc(live).lastRedeemedKey === owned.idempotencyKey) {
			return this.#finish(taken, { ok: true });
		}
		return this.#runBump(coupon, taken, cap !== null);
	}

	/** The counter write itself, plus the compensation its refusal owes. */
	async #runBump(coupon: CouponDoc, claim: ResolvedClaim, capped: boolean): Promise<RedeemResult> {
		if (await this.#bumpGlobal(coupon.couponId, claim.doc.idempotencyKey)) {
			return this.#finish(claim, { ok: true });
		}
		// The compensation the transaction used to be. Idempotent, and scoped to this
		// key's own slot, so a second replayer cannot release it twice.
		if (capped) await this.#releaseCustomerSlot(claim.doc);
		return this.#finish(claim, { ok: false, reason: "COUPON_EXHAUSTED" });
	}

	/**
	 * Add this key to the customer's slot set, or refuse.
	 *
	 * Idempotent by the key itself: a replay whose key is already in the set holds
	 * the slot it took, and no second slot is consumed. The set's size IS the count
	 * the cap is compared against, so two concurrent same-customer redemptions
	 * serialize on this one document's revision and exactly `cap` of them win.
	 */
	async #claimCustomerSlot(doc: CouponRedemptionDoc, cap: number): Promise<boolean> {
		const customerId = doc.customerId;
		if (customerId === null) return true;
		const capId = couponCustomerCapId(doc.couponId, customerId);
		return this.#cas<boolean>("redeem", async () => {
			const current = await this.#caps.getVersioned(capId);
			if (current === null) {
				const written = await this.#caps.compareAndSet(capId, null, {
					couponId: doc.couponId,
					customerId,
					keys: [doc.idempotencyKey],
				});
				return written.applied ? casDone(true) : CAS_RETRY;
			}
			const held = normalizeCustomerCapDoc(current.value);
			if (held.keys.includes(doc.idempotencyKey)) return casDone(true);
			if (held.keys.length >= cap) return casDone(false);
			const written = await this.#caps.compareAndSet(capId, current.revision, {
				...held,
				keys: [...held.keys, doc.idempotencyKey],
			});
			return written.applied ? casDone(true) : CAS_RETRY;
		});
	}

	/** Give back this key's slot. A key that holds none is already done. */
	async #releaseCustomerSlot(doc: CouponRedemptionDoc): Promise<void> {
		const customerId = doc.customerId;
		if (customerId === null) return;
		const capId = couponCustomerCapId(doc.couponId, customerId);
		return this.#cas<void>("releaseCoupon", async () => {
			const current = await this.#caps.getVersioned(capId);
			if (current === null) return casDone(undefined);
			const held = normalizeCustomerCapDoc(current.value);
			if (!held.keys.includes(doc.idempotencyKey)) return casDone(undefined);
			const written = await this.#caps.compareAndSet(capId, current.revision, {
				...held,
				keys: held.keys.filter((key) => key !== doc.idempotencyKey),
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * The guarded `+1` — the no-over-redeem statement, in its two branches.
	 *
	 * A CAPPED coupon is guarded on `usesCount < maxUses` and on NOTHING ELSE, which
	 * is what keeps a redemption from ever waiting on a peer redemption of the same
	 * coupon: once-only per key is the key document's job (see {@link #takeBumpRight}),
	 * not the guard's. An UNCAPPED one takes a plain delta — there is no invariant to
	 * violate — and because `updateIf` never inserts, a refusal there can only mean
	 * the document is gone.
	 *
	 * The refusal DECISION is taken from the READ (`usesCount >= maxUses`), never from
	 * `applied: false`, because `updateIf` conflates a failed guard with an absent
	 * row. So a refused write means only "the document moved, read it again" — and the
	 * ONLY thing that can move it into refusing is the coupon reaching its cap, which
	 * the next read settles. The attempt depth is therefore 2 in the worst case, plus
	 * one per concurrent RELEASE that hands headroom back mid-flight.
	 */
	async #bumpGlobal(couponId: string, key: string): Promise<boolean> {
		return this.#cas<boolean>("redeem", async () => {
			const live = await this.#coupons.get(couponId);
			if (live === null) throw new CouponNotFoundError(couponId);
			const max = normalizeCouponDoc(live).maxUses;
			if (max !== null && normalizeCouponDoc(live).usesCount >= max) return casDone(false);
			const result = await this.#coupons.updateIf(couponId, {
				where: max === null ? {} : { usesCount: { lt: max } },
				// A best-effort witness for the takeover seam, never a guard: see
				// `#takeOverBump`, and `CouponDoc.lastRedeemedKey`.
				set: { lastRedeemedKey: key },
				delta: { usesCount: { inc: 1 } },
			});
			if (result.applied) return casDone(true);
			if (max === null) throw new CouponNotFoundError(couponId);
			return CAS_RETRY;
		});
	}

	/** The mirror-image guard: never below zero, and a release at zero matches nothing. */
	async #decrementGlobal(couponId: string): Promise<void> {
		await this.#cas<void>("releaseCoupon", async () => {
			await this.#coupons.updateIf(couponId, {
				where: { usesCount: { gt: 0 } },
				delta: { usesCount: { dec: 1 } },
			});
			return casDone(undefined);
		});
	}

	/**
	 * Record the terminal state on the key document — the replay's only source.
	 *
	 * Returns the answer that is ACTUALLY recorded, which is not always the one this
	 * caller computed: a taker and a slow owner can both finish, and the first write
	 * is the truth for everybody.
	 */
	async #finish(claim: ResolvedClaim, outcome: RedemptionOutcome): Promise<RedeemResult> {
		const recorded = await this.#cas<RedemptionOutcome>("redeem", async () => {
			const current = await this.#redemptions.getVersioned(claim.docId);
			// Released underneath us: there is nothing left to record an answer on, and
			// the release already undid whatever this key held.
			if (current === null) return casDone(outcome);
			const doc = normalizeRedemptionDoc(current.value);
			if (doc.outcome !== null) return casDone(doc.outcome);
			const state = outcome.ok ? "applied" : "refused";
			const written = await this.#redemptions.compareAndSet(claim.docId, current.revision, {
				...doc,
				state,
				holdsUse: holdsUseFor(state),
				bumpLeaseUntil: null,
				outcome,
			});
			return written.applied ? casDone(outcome) : CAS_RETRY;
		});
		return answerOf(claim.doc, recorded, claim.replayed);
	}

	/** The jittered wait between two reads of a key somebody else owns. */
	async #backoff(attempt: number): Promise<void> {
		const sleep = this.#retry.sleep ?? defaultSleep;
		const random = this.#retry.random ?? Math.random;
		await sleep(random() * Math.min(CAS_BASE_DELAY_MS * 2 ** (attempt - 1), CAS_MAX_DELAY_MS));
	}

	/**
	 * Free one redemption's slot, delete it, and decrement iff it consumed a use.
	 *
	 * "Consumed a use" is read off the key document's STATE, not guessed from a
	 * witness a peer may have overwritten. The state is authoritative because the
	 * counter is only ever touched AFTER `bumping` is durable: `claimed` provably
	 * never bumped, and `applied` provably did. `bumping` is the one ambiguous state,
	 * and it is COMPLETED first rather than guessed at — so a release can never
	 * delete an applied redemption without giving its use back.
	 *
	 * Returns whether THIS call was the one that deleted the record.
	 */
	async #releaseClaim(docId: string, doc: CouponRedemptionDoc): Promise<boolean> {
		const settled = doc.state === "bumping" ? await this.#settleForRelease(docId, doc) : doc;
		if (settled === null) return false;
		await this.#releaseCustomerSlot(settled);
		const consumed = settled.state === "applied";
		const deleted = await this.#cas<boolean>("releaseCoupon", async () => {
			const current = await this.#redemptions.getVersioned(docId);
			if (current === null) return casDone(false);
			const written = await this.#redemptions.compareAndDelete(docId, current.revision);
			return written.applied ? casDone(true) : CAS_RETRY;
		});
		if (deleted && consumed) await this.#decrementGlobal(settled.couponId);
		return deleted;
	}

	/**
	 * Drive a mid-flight redemption to a terminal state so a release can read its
	 * answer instead of guessing.
	 *
	 * Completing it may bump the counter that this release is about to decrement.
	 * That is net zero and it is the point: the alternative is deciding `applied`
	 * from a witness, which is exactly the guess this method exists to remove.
	 *
	 * Losing the takeover to a live completer is not a failure — it means somebody
	 * else is recording the answer, and the re-read below finds it. A document still
	 * `bumping` after that is left to the witness as a last resort, in the
	 * conservative direction: not decrementing leaves the counter HIGH, never low.
	 */
	async #settleForRelease(
		docId: string,
		doc: CouponRedemptionDoc,
	): Promise<CouponRedemptionDoc | null> {
		const coupon = await this.#coupons.get(doc.couponId);
		if (coupon !== null) {
			try {
				// Through the lease-aware waiter, not straight into the takeover: a release
				// must not overtake a live completer any more than a redemption may.
				await this.#awaitOrTakeOver(normalizeCouponDoc(coupon), { docId, doc, replayed: true });
			} catch (err) {
				if (!isStorageContentionError(err)) throw err;
			}
		}
		const reread = await this.#redemptions.get(docId);
		if (reread === null) return null;
		const settled = normalizeRedemptionDoc(reread);
		if (settled.state !== "bumping") return settled;
		const live = coupon === null ? null : await this.#coupons.get(doc.couponId);
		const bumped =
			live !== null && normalizeCouponDoc(live).lastRedeemedKey === settled.idempotencyKey;
		return bumped ? { ...settled, state: "applied" } : settled;
	}

	/** The redemption a generated id names — the port's `release` handle. */
	async #findByRedemptionId(
		redemptionId: string,
	): Promise<{ docId: string; doc: CouponRedemptionDoc } | null> {
		const page = await this.#redemptions.query({ where: { redemptionId }, limit: 1 });
		const first = page.items[0];
		if (first === undefined) return null;
		return { docId: first.id, doc: normalizeRedemptionDoc(first.data) };
	}

	// -- internals: bounded scans ---------------------------------------------

	/**
	 * Page the redemption index under one where clause, collecting every match.
	 *
	 * The host's own cursor drives the paging INSIDE one call, which is safe for the
	 * reason it is not safe across calls: the row it re-reads to seek is a row this
	 * same call just read. Reaching the page budget is a typed
	 * {@link ScanPageLimitError}, never a silently short list.
	 */
	async #scanRedemptions(
		operation: string,
		where: WhereClause,
		orderBy: OrderBy,
	): Promise<{ docId: string; doc: CouponRedemptionDoc }[]> {
		const collected: { docId: string; doc: CouponRedemptionDoc }[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#redemptions.query({
				where,
				orderBy,
				limit: LIST_PAGE_SIZE,
				cursor,
			});
			for (const { id, data } of result.items) {
				collected.push({ docId: id, doc: normalizeRedemptionDoc(data) });
			}
			if (!result.hasMore || result.cursor === undefined) return collected;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxListPages, collected.length, "maxListPages");
	}

	/**
	 * Page the `coupons` index newest-first, keeping what `keep` accepts, until
	 * `need` rows are collected — and then DRAINING to the end of the boundary tie
	 * group, because the ordering is on `createdAt` alone and stopping at `need`
	 * would make a page boundary depend on the host's collation for the id.
	 */
	async #scanCoupons(
		operation: string,
		where: WhereClause,
		need: number,
		keep: (doc: CouponDoc) => boolean,
	): Promise<CouponDoc[]> {
		const collected: CouponDoc[] = [];
		let boundary: string | null = null;
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#coupons.query({
				where,
				orderBy: { createdAt: "desc" },
				limit: LIST_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) {
				const doc = normalizeCouponDoc(data);
				if (boundary !== null && doc.createdAt !== boundary) return collected;
				if (!keep(doc)) continue;
				collected.push(doc);
				if (boundary === null && collected.length >= need) boundary = doc.createdAt;
			}
			if (!result.hasMore || result.cursor === undefined) return collected;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxListPages, collected.length, "maxListPages");
	}

	#cas<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

// -- predicates and projections ---------------------------------------------

/** What a recorded outcome answers with. A refusal carries no replay flag. */
function answerOf(
	doc: CouponRedemptionDoc,
	outcome: RedemptionOutcome,
	replayed: boolean,
): RedeemResult {
	return outcome.ok
		? { ok: true, redemptionId: doc.redemptionId, replayed }
		: { ok: false, reason: outcome.reason };
}

/**
 * A cap applies only to an IDENTIFIED customer: a guest checkout carries no
 * customer id and degrades to the global cap alone, exactly as the SQL did.
 */
function capInForce(coupon: CouponDoc, doc: CouponRedemptionDoc): number | null {
	return doc.customerId === null ? null : coupon.maxUsesPerCustomer;
}

/** The wait between two reads of a key document somebody else owns. */
const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * The pushed-down half of the list predicate: the cursor's COARSE `createdAt`
 * bound only. The exact position is a disjunction the AND-only filter algebra
 * cannot express, so {@link isAfterCursor} applies it in memory over the rows this
 * bound already narrowed.
 */
function couponListWhere(cursor: { createdAt: string; couponId: string } | null): WhereClause {
	return cursor === null ? {} : { createdAt: { lte: cursor.createdAt } };
}

/** Strictly after the cursor position under `createdAt DESC, couponId DESC`. */
function isAfterCursor(
	doc: CouponDoc,
	cursor: { createdAt: string; couponId: string } | null,
): boolean {
	if (cursor === null) return true;
	if (doc.createdAt > cursor.createdAt) return false;
	if (doc.createdAt < cursor.createdAt) return true;
	return doc.couponId < cursor.couponId;
}

/** `createdAt DESC, couponId DESC` in plain code-unit order — the adapter's total order. */
function byNewestFirst(a: CouponDoc, b: CouponDoc): number {
	return codeUnitDesc(a.createdAt, b.createdAt) || codeUnitDesc(a.couponId, b.couponId);
}
