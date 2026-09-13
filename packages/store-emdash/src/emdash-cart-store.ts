/**
 * `CartStore` over EmDash's plugin-storage primitives, on the one-document cart
 * aggregate: `carts/{cartId}` carries the lines, the mutation ledger and the
 * denormalized hold deadline, so every cart-only invariant is one document's
 * compare-and-set.
 *
 * ## The cart is the first real cross-aggregate edge
 *
 * Inventory could keep every invariant it owns inside `inventory/{sku}`. The cart
 * cannot: `upsertLine`, `adjustLine`, `removeLine`, `expireHold` and the
 * expiry-driven paths all pair a cart-document write with an inventory movement,
 * and the two live in different aggregates with no transaction between them. So
 * every one of them is written as ADR-0019 §1's other primitive — **intent claim,
 * inventory op, deterministic completion**:
 *
 * 1. **Claim** on the cart document: `claimMutation` adds the key to
 *    {@link CartDoc.mutations} with `completed: false`, create-if-absent by the
 *    map's own compare-and-set. A key that is already there is either a completed
 *    mutation (the caller returns its recorded result and re-applies nothing) or a
 *    crashed/in-flight peer's claim, which this caller RESUMES.
 * 2. **The inventory op**, through `InventoryStore` and nothing else. It is
 *    idempotent on its own terms — `reserve`/`adjust` by their key, `release` by
 *    the reservation's state machine — which is what makes step 3 safe to reach
 *    from any interruption point.
 * 3. **Complete** on the cart document: the line write and `completed: true` land
 *    in the SAME compare-and-set. There is no interval in which a line exists
 *    without its ledger entry, or vice versa.
 *
 * Nothing here writes an inventory document. The store READS
 * `inventory`/`reservation_index`/`reservation_keys` — it has to, because a line's
 * live hold state and a crashed claim's reservation id are facts about the other
 * aggregate that the port asks this one to report — and every WRITE to inventory
 * goes through the injected `InventoryStore`.
 *
 * ## What each SQL guard became (ADR-0019 §7.7, §7.14)
 *
 * - **The `cart_mutations` claim/complete pair** → the embedded ledger, read and
 *   written in the same compare-and-set as the line.
 * - **`(cart_id, sku)` UNIQUE** → the lines map keyed by sku. Never an index: no
 *   tier here materializes one.
 * - **`upsertLine`'s hold stamp scoped `state='held'`** → the same precondition
 *   READ off the hold in the inventory document before the cart document is
 *   written; a hold that is no longer live is {@link HoldExpiredError}, never a
 *   line resurrected over reaped stock.
 * - **`adjustLine`'s correlated subselect** → the stored qty is re-derived from the
 *   hold the store just read, and the write is then RECONCILED against the hold
 *   before the call returns, so racing different-key adjusts converge on one
 *   `(line.qty, hold.qty)` instead of desyncing to the last writer.
 * - **The expiry transaction** → the guarded flip of the line to `expiring` (the
 *   once-only token), then the release, then the removal. Any replayer completes a
 *   partial, and only the writer that MINTED the token reports the expiry as won,
 *   so stock returns exactly once.
 * - **The checkout fence** → one compare-and-set guarded on `state === "active"`,
 *   setting `state` and `orderId` together. The guard IS the write-once.
 */
import {
	type AdjustLineInput,
	type Cart,
	type CartLine,
	type CartStore,
	type ClaimMutationInput,
	type ClaimMutationResult,
	type Clock,
	type Currency,
	type ExpiredHold,
	HoldExpiredError,
	type IdempotencyKey,
	type IdGen,
	type InventoryStore,
	type OrderId,
	type RecordedCartMutation,
	type ReservationLifecycle,
	ReservationNotFoundError,
	type UpsertLineInput,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	type CasRetryOptions,
	type CasStep,
	casDone,
	withCasRetry,
} from "./cas-retry.js";
import {
	CART_MUTATION_INDEX_COLLECTION,
	CARTS_COLLECTION,
	type CartDoc,
	type CartLineDoc,
	type CartMutationIndexDoc,
	type CartMutationRecord,
	computeHoldExpiresAt,
	findLineById,
	findLineByReservation,
	newCartDoc,
	normalizeCartDoc,
	pruneMutations,
} from "./cart-documents.js";
import { collectionOf } from "./collection-of.js";
import { isReservationNotReleasableError } from "./errors.js";
import {
	type HoldEntry,
	INVENTORY_COLLECTION,
	type InventoryDoc,
	normalizeInventoryDoc,
	RESERVATION_INDEX_COLLECTION,
	RESERVATION_KEYS_COLLECTION,
	type ReservationIndexDoc,
	type ReservationKeyDoc,
} from "./inventory-documents.js";
import type { HoldDeadlineStamper } from "./hold-deadline-stamper.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

export interface EmdashCartStoreOptions {
	/** The collections the plugin descriptor declared; see `CART_COLLECTIONS`. */
	storage: StorageAccess;
	/**
	 * The inventory authority. Every inventory write this store performs goes
	 * through it — the cart aggregate never touches another aggregate's document
	 * directly.
	 *
	 * The type is NARROWED past the port: the cart needs one capability the port
	 * does not declare, the `held`-scoped deadline stamp that is also its attach
	 * guard (see {@link HoldDeadlineStamper}). Asking for it here is what keeps an
	 * adapter that cannot supply it from being injected by mistake.
	 */
	inventory: InventoryStore & HoldDeadlineStamper;
	/** Cart and line ids come from here, never from `crypto.randomUUID()` directly. */
	idGen: IdGen;
	/** Timestamps come from here, never from `Date.now()` directly. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers must). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
}

/** How many pages `listExpired` will walk before it refuses to loop further. */
const MAX_EXPIRY_PAGES = 1000;

/** The host clamps `limit` at 100; asking for it is asking for the widest page. */
const EXPIRY_PAGE_SIZE = 100;

export class EmdashCartStore implements CartStore {
	readonly #carts: StorageCollection<CartDoc>;
	readonly #mutationIndex: StorageCollection<CartMutationIndexDoc>;
	/** READ-ONLY handles on the inventory aggregate; see the class docblock. */
	readonly #inventoryDocs: StorageCollection<InventoryDoc>;
	readonly #reservationIndex: StorageCollection<ReservationIndexDoc>;
	readonly #reservationKeys: StorageCollection<ReservationKeyDoc>;
	readonly #inventory: InventoryStore & HoldDeadlineStamper;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashCartStoreOptions) {
		this.#carts = collectionOf<CartDoc>(options.storage, CARTS_COLLECTION);
		this.#mutationIndex = collectionOf<CartMutationIndexDoc>(
			options.storage,
			CART_MUTATION_INDEX_COLLECTION,
		);
		this.#inventoryDocs = collectionOf<InventoryDoc>(options.storage, INVENTORY_COLLECTION);
		this.#reservationIndex = collectionOf<ReservationIndexDoc>(
			options.storage,
			RESERVATION_INDEX_COLLECTION,
		);
		this.#reservationKeys = collectionOf<ReservationKeyDoc>(
			options.storage,
			RESERVATION_KEYS_COLLECTION,
		);
		this.#inventory = options.inventory;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	// -- reads -----------------------------------------------------------------

	async create(currency: Currency): Promise<string> {
		const cartId = this.#idGen.newId();
		const now = this.#clock.now().toISOString();
		const written = await this.#carts.compareAndSet(
			cartId,
			null,
			newCartDoc(cartId, currency, now),
		);
		// Create-if-absent: a refusal means the id source handed out a live cart id,
		// which is a programming/id-source failure and must be loud rather than
		// silently returning somebody else's cart.
		if (!written.applied) throw new Error(`cart id ${cartId} is already taken`);
		return cartId;
	}

	async get(cartId: string): Promise<Cart | null> {
		const doc = await this.#carts.get(cartId);
		if (doc === null) return null;
		return this.#toCart(normalizeCartDoc(doc));
	}

	async recordedMutation(key: IdempotencyKey): Promise<RecordedCartMutation | null> {
		// The key alone cannot find an embedded map entry, so the locator resolves
		// the cart and the cart's own ledger answers.
		const locator = await this.#mutationIndex.get(key);
		if (locator === null) return null;
		const doc = await this.#carts.get(locator.cartId);
		if (doc === null) return null;
		const record = normalizeCartDoc(doc).mutations[key];
		return record === undefined ? null : toRecorded(key, locator.cartId, record);
	}

	// -- the mutation ledger ---------------------------------------------------

	async claimMutation(input: ClaimMutationInput): Promise<ClaimMutationResult> {
		const result = await this.#casCart<ClaimMutationResult>("claimMutation", async () => {
			const current = await this.#mustVersioned(input.cartId);
			const doc = normalizeCartDoc(current.value);
			const existing = doc.mutations[input.key];
			if (existing !== undefined) {
				return casDone<ClaimMutationResult>({
					claimed: false,
					recorded: toRecorded(input.key, input.cartId, existing),
				});
			}

			const claimed: CartMutationRecord = {
				kind: input.kind,
				lineId: input.lineId ?? null,
				resultingQty: null,
				completed: false,
				claimedAt: this.#clock.now().toISOString(),
			};
			const next = this.#withMutations(doc, { [input.key]: claimed });
			const written = await this.#carts.compareAndSet(input.cartId, current.revision, next);
			return written.applied ? casDone<ClaimMutationResult>({ claimed: true }) : CAS_RETRY;
		});
		// The locator is written AFTER the record, never before: a locator pointing
		// at a cart with no record would make `recordedMutation` claim a mutation
		// exists when none does. The reverse gap is harmless — `claimMutation` and
		// every mutation method are given the cart id, so they read the record
		// directly, and each of them re-ensures the locator.
		await this.#ensureLocator(input.key, input.cartId);
		return result;
	}

	// -- line mutations --------------------------------------------------------

	async upsertLine(input: UpsertLineInput): Promise<CartLine> {
		const line = await this.#casCart<CartLineDoc>("upsertLine", async () => {
			const current = await this.#mustVersioned(input.cartId);
			const doc = normalizeCartDoc(current.value);

			const recorded = doc.mutations[input.key];
			if (recorded?.completed === true && recorded.lineId !== null) {
				const existing = findLineById(doc, recorded.lineId);
				if (existing !== undefined) return casDone(existing);
				// The recorded line is gone (a later remove, or an expiry): there is
				// nothing to return and nothing may be recreated over a released hold.
				if (input.reservationId !== null) throw new HoldExpiredError(input.reservationId);
				throw new Error(
					`the line recorded for cart mutation ${input.key} no longer exists and cannot be recreated`,
				);
			}
			// The sweep has already reaped this claim's hold and retired the claim: a
			// late replay must not put a line back over returned stock. Re-read on
			// EVERY attempt, so a reaping that lands mid-retry is still seen.
			if (recorded?.abandoned === true && input.reservationId !== null) {
				throw new HoldExpiredError(input.reservationId);
			}
			// Why bounding `abandoned` records (`CART_ABANDONED_LEDGER_SIZE`) is safe:
			// this short-circuit is a fast path, not the guarantee. The guarantee is the
			// guarded stamp below, which refuses a hold that is no longer live — so a
			// replay whose abandoned marker has been evicted is still refused, one round
			// trip later, by the write itself rather than by the marker.

			// THE ATTACH GUARD, and it is a guarded WRITE, not a read: the deadline
			// stamp is scoped to `state='held'`, exactly as the SQL's
			// `UPDATE reservations … WHERE state='held'` was, so a hold the sweep
			// reaped between this attempt's read and its write cannot be attached —
			// the stamp fails and no line is resurrected over dead stock. Idempotent,
			// so a compare-and-set retry re-stamping costs nothing.
			const attach =
				input.reservationId === null
					? null
					: await this.#stampAttach(input.reservationId, input.expiresAt);

			const now = this.#clock.now().toISOString();
			const previous = doc.lines[input.sku];
			const next: CartLineDoc = {
				// The line id survives an upsert exactly as the SQL row id did under
				// `ON CONFLICT (cart_id, sku) DO UPDATE`.
				lineId: previous?.lineId ?? this.#idGen.newId(),
				sku: input.sku,
				productId: input.productId,
				qty: input.qty,
				reservationId: input.reservationId,
				reserveKey: attach?.reserveKey ?? null,
				expiresAt: input.expiresAt,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			};
			const written = await this.#carts.compareAndSet(
				input.cartId,
				current.revision,
				this.#withLine(doc, next, {
					[input.key]: this.#completion(doc.mutations[input.key], "add", next.lineId, input.qty),
				}),
			);
			return written.applied ? casDone(next) : CAS_RETRY;
		});

		await this.#ensureLocator(input.key, input.cartId);
		return this.#toLine(input.cartId, line, await this.#lifecycleOf(line));
	}

	async adjustLine(input: AdjustLineInput): Promise<CartLine> {
		const line = await this.#casCart<CartLineDoc>("adjustLine", async () => {
			const current = await this.#mustVersioned(input.cartId);
			const doc = normalizeCartDoc(current.value);
			const recorded = doc.mutations[input.key];
			const existing = findLineById(doc, input.lineId);
			if (existing === undefined) throw new Error(`cart line ${input.lineId} does not exist`);

			// R5: the stored qty is the HOLD's qty, re-derived from the inventory
			// document rather than taken from the caller, so a racing different-key
			// adjust cannot leave the line and the hold disagreeing. With no hold
			// (a digital line, or one whose hold is already gone) the caller's
			// absolute target is all there is.
			const derived = await this.#holdQty(existing);

			// THE RECONCILE PASS, as a REPAIR rather than a bare retry. The derived
			// qty is read before the write, so a concurrent different-key adjust's
			// inventory movement can land in between. Once this key is completed the
			// mutation itself is done and must never re-apply — but the stored qty
			// still owes the hold agreement, so the divergence is repaired IN PLACE,
			// preserving the completion. A plain retry could not: it would find
			// `completed` and hand back the stale line.
			//
			// Termination and convergence: a call's inventory movement always
			// PRECEDES its cart write, so whichever cart write lands last is followed
			// by a pass that sees the final hold; the loop ends the first time the two
			// agree, and its budget is the usual compare-and-set ceiling.
			if (recorded?.completed === true) {
				if (derived === undefined || derived === existing.qty) return casDone(existing);
				const repaired: CartLineDoc = {
					...existing,
					qty: derived,
					updatedAt: this.#clock.now().toISOString(),
				};
				const patched = await this.#carts.compareAndSet(
					input.cartId,
					current.revision,
					this.#withLine(doc, repaired, {}),
				);
				return patched.applied ? casDone(repaired) : CAS_RETRY;
			}

			// The deadline re-stamp, reservation before line — the SQL's fixed step
			// order. It calls the stamp DIRECTLY and ignores a refusal, deliberately:
			// unlike `upsertLine`, this line ALREADY references the hold, so there is
			// no attach to guard and refusing the cart write would gain nothing. And
			// `HoldExpiredError` is documented as `upsertLine`'s failure — the update
			// use-case calls `adjustLine` outside any catch, so throwing here would
			// escape unmapped on every retry whenever a checkout or the sweep took the
			// hold between `inventoryStore.adjust` returning and this stamp. The SQL's
			// adjust stamp was likewise unguarded. A hold that has gone simply keeps
			// whatever deadline it last had, and the qty derivation above has already
			// fallen back to the caller's absolute target.
			if (existing.reservationId !== null) {
				await this.#inventory.stampHoldDeadline(existing.reservationId, input.expiresAt);
			}

			const next: CartLineDoc = {
				...existing,
				qty: derived ?? input.newQty,
				expiresAt: input.expiresAt,
				updatedAt: this.#clock.now().toISOString(),
			};
			const written = await this.#carts.compareAndSet(
				input.cartId,
				current.revision,
				this.#withLine(doc, next, {
					[input.key]: this.#completion(recorded, "adjust", next.lineId, input.newQty),
				}),
			);
			// Lost the revision: recompute the whole step against the new document.
			if (!written.applied) return CAS_RETRY;
			// Applied: go round once more, into the completed branch above, which
			// either finishes on agreement or repairs the qty in place.
			return CAS_RETRY;
		});

		await this.#ensureLocator(input.key, input.cartId);
		return this.#toLine(input.cartId, line, await this.#lifecycleOf(line));
	}

	async removeLine(cartId: string, lineId: string, key: IdempotencyKey): Promise<void> {
		await this.#casCart<void>("removeLine", async () => {
			const current = await this.#carts.getVersioned(cartId);
			if (current === null) return casDone<void>(undefined); // nothing to remove
			const doc = normalizeCartDoc(current.value);
			const recorded = doc.mutations[key];
			if (recorded?.completed === true) return casDone<void>(undefined); // replay

			// The delete and the ledger completion are ONE write: there is no interval
			// in which the line is gone but the removal is not recorded.
			const line = findLineById(doc, lineId);
			const lines = { ...doc.lines };
			if (line !== undefined) delete lines[line.sku];
			const mutations = {
				...doc.mutations,
				[key]: this.#completion(recorded, "remove", lineId, null),
			};
			const written = await this.#carts.compareAndSet(cartId, current.revision, {
				...doc,
				lines,
				mutations: pruneMutations(mutations),
				holdExpiresAt: computeHoldExpiresAt({ lines, mutations }),
				updatedAt: this.#clock.now().toISOString(),
			});
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});
		await this.#ensureLocator(key, cartId);
	}

	// -- the checkout fence ----------------------------------------------------

	async checkout(cartId: string, orderId: OrderId): Promise<boolean> {
		// ONE compare-and-set sets BOTH fields, so `state` and `orderId` are never
		// observable apart — and the UNCHANGED `state === "active"` predicate IS the
		// CAS that makes the stamp write-once. A replay finds the cart already
		// terminal and returns false (success for the same order). `checked_out` is
		// terminal: nothing here flips a cart back.
		return this.#casCart<boolean>("checkout", async () => {
			const current = await this.#carts.getVersioned(cartId);
			if (current === null) return casDone(false);
			const doc = normalizeCartDoc(current.value);
			if (doc.state !== "active") return casDone(false);
			const written = await this.#carts.compareAndSet(cartId, current.revision, {
				...doc,
				state: "checked_out",
				orderId,
				updatedAt: this.#clock.now().toISOString(),
			});
			return written.applied ? casDone(true) : CAS_RETRY;
		});
	}

	// -- expiry ----------------------------------------------------------------

	async listExpired(now: string, cutoff: string): Promise<ExpiredHold[]> {
		// The declared `holdExpiresAt` index is the CANDIDATE filter: the SQL's OR of
		// a stamped-deadline arm and a crashed-claim arm cannot be expressed, so both
		// fold into one `<= now` and the exact per-arm predicate is re-applied to the
		// fetched document below. `limit` is clamped by the host, so this pages.
		const found = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_EXPIRY_PAGES; page++) {
			const result = await this.#carts.query({
				where: { holdExpiresAt: { lte: now } },
				limit: EXPIRY_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) {
				await this.#collectExpired(normalizeCartDoc(data), now, cutoff, found);
			}
			if (!result.hasMore || result.cursor === undefined) break;
			cursor = result.cursor;
		}
		return [...found].map((reservationId) => ({ reservationId }));
	}

	async expireHold(reservationId: string, now: string, cutoff: string): Promise<boolean> {
		// Only a CART-ORIGINATED hold is the cart sweep's to reap. The reservation's
		// own reserve key is the add's mutation key, so the locator answers "which
		// cart claimed this hold" — and a raw reserve, having no claim, has no
		// locator and is never touched. That is the SQL's ledger-existence test.
		const index = await this.#reservationIndex.get(reservationId);
		if (index === null) return false;
		const locator = await this.#mutationIndex.get(index.idempotencyKey);
		if (locator === null) return false;
		const cartId = locator.cartId;

		const claim = await this.#claimExpiry(cartId, reservationId, index, now, cutoff);
		if (claim === null) return false;

		// The release is idempotent by the reservation's own state machine, so a
		// replayer that arrives here after a crash returns the stock exactly once.
		// A hold that is no longer releasable at all (adopted by an order, already
		// committed) is not an error for a completion that was already claimed —
		// the token says the expiry is owed, and the removal below still owes it.
		//
		// Both tolerated conditions are recognized by TYPE, never by message: the
		// adapter's `ReservationNotReleasableError` and the port's
		// `ReservationNotFoundError`. That is sound precisely because the injected
		// store is narrowed to this package's own adapter (see the options type), so
		// the errors this `release` can raise are known rather than assumed —
		// anything else rethrows.
		try {
			await this.#inventory.release(reservationId);
		} catch (err) {
			if (!isReservationNotReleasableError(err) && !(err instanceof ReservationNotFoundError)) {
				throw err;
			}
		}

		await this.#completeExpiry(cartId, reservationId, index.idempotencyKey);
		// Only the writer that MINTED the token reports the reclaim, so a lazy read
		// racing the sweep counts one expiry between them, never two.
		return claim.minted;
	}

	// -- expiry internals ------------------------------------------------------

	/**
	 * The guarded flip. Either arm mints a once-only token; a token already present
	 * means a crashed peer claimed this expiry and this caller is COMPLETING it,
	 * which is not a win. Returns null when there is nothing to expire — a TTL that
	 * was reset between listing and here, a hold that left `held`, an already
	 * finished expiry.
	 */
	async #claimExpiry(
		cartId: string,
		reservationId: string,
		index: ReservationIndexDoc,
		now: string,
		cutoff: string,
	): Promise<{ minted: boolean } | null> {
		const reserveKey = index.idempotencyKey;
		// The obligation the inventory tier hands every reaping path (see that
		// store's batch-replay note): a hold can still LOOK live in the aggregate
		// after its reservation went terminal, because the terminal record is
		// written before the prune. Returning such a hold's units would be an
		// oversell, so a FRESH token is refused whenever the reservation has already
		// settled. An EXISTING token is a different question — it means an expiry was
		// already claimed here and is owed its completion — so it is not gated.
		const settled = index.terminalState !== undefined;
		return this.#casCart<{ minted: boolean } | null>("expireHold.claim", async () => {
			const current = await this.#carts.getVersioned(cartId);
			if (current === null) return casDone(null);
			const doc = normalizeCartDoc(current.value);
			const line = findLineByReservation(doc, reservationId);

			if (line !== undefined) {
				if (line.expiring !== undefined) return casDone({ minted: false });
				// The deadline is RE-CHECKED here, in the same write that takes the
				// token: a hold whose TTL an active shopper reset between the listing
				// and this statement no longer matches and is not reaped.
				if (settled || line.expiresAt === null || line.expiresAt > now) return casDone(null);
				const hold = await this.#holdOf(line.sku, reserveKey, reservationId);
				if (hold?.state !== "held") return casDone(null);
				const next: CartLineDoc = {
					...line,
					expiring: { token: this.#idGen.newId(), at: now },
				};
				const written = await this.#carts.compareAndSet(
					cartId,
					current.revision,
					this.#withLine(doc, next, {}),
				);
				return written.applied ? casDone({ minted: true }) : CAS_RETRY;
			}

			// The crashed-claim arm: a hold whose cart-line write never landed. Its
			// claim is still outstanding in the ledger, which is what made it
			// listable; the token goes on the RECORD, and the record stays listable
			// until the release has landed, so a crash between the two cannot orphan
			// the stock.
			const record = doc.mutations[reserveKey];
			if (
				record === undefined ||
				record.kind !== "add" ||
				record.completed ||
				record.abandoned === true ||
				record.claimedAt > cutoff
			) {
				return casDone(null);
			}
			if (record.expiring !== undefined) return casDone({ minted: false });
			if (settled) return casDone(null);
			const hold = await this.#holdOf(null, reserveKey, reservationId);
			if (hold !== undefined && hold.state !== "held") return casDone(null);
			const next = this.#withMutations(doc, {
				[reserveKey]: { ...record, expiring: { token: this.#idGen.newId(), at: now } },
			});
			const written = await this.#carts.compareAndSet(cartId, current.revision, next);
			return written.applied ? casDone({ minted: true }) : CAS_RETRY;
		});
	}

	/**
	 * The completion: drop the line, or retire the crashed claim. Idempotent, so
	 * every replayer converges on the same document however many of them run.
	 */
	async #completeExpiry(cartId: string, reservationId: string, reserveKey: string): Promise<void> {
		await this.#casCart<void>("expireHold.complete", async () => {
			const current = await this.#carts.getVersioned(cartId);
			if (current === null) return casDone<void>(undefined);
			const doc = normalizeCartDoc(current.value);
			const line = findLineByReservation(doc, reservationId);
			const record = doc.mutations[reserveKey];

			const lines = { ...doc.lines };
			if (line !== undefined) delete lines[line.sku];
			const mutations = { ...doc.mutations };
			if (record !== undefined && !record.completed && record.abandoned !== true) {
				// Retired, not completed: the mutation never happened. It stays as the
				// audit record of a reaped crash, and it is never prunable.
				mutations[reserveKey] = { ...record, abandoned: true };
			}
			if (line === undefined && mutations[reserveKey] === record) {
				return casDone<void>(undefined); // already finished
			}
			const written = await this.#carts.compareAndSet(cartId, current.revision, {
				...doc,
				lines,
				mutations,
				holdExpiresAt: computeHoldExpiresAt({ lines, mutations }),
				updatedAt: this.#clock.now().toISOString(),
			});
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});
	}

	/** Re-apply the SQL's two arms to one fetched cart document. */
	async #collectExpired(
		doc: CartDoc,
		now: string,
		cutoff: string,
		found: Set<string>,
	): Promise<void> {
		for (const line of Object.values(doc.lines)) {
			if (line.reservationId === null) continue;
			if (line.expiresAt !== null && line.expiresAt <= now) found.add(line.reservationId);
		}
		for (const [key, record] of Object.entries(doc.mutations)) {
			if (record.kind !== "add" || record.completed || record.abandoned === true) continue;
			if (record.claimedAt > cutoff) continue;
			// A claim with no line: the reserve key document says whether it ever
			// minted a reservation. A decided OUT_OF_STOCK never did, so there is
			// nothing to reap and the claim simply costs this one read per sweep.
			const reservationId = reservationIdOf(await this.#reservationKeys.get(key));
			if (reservationId !== null) found.add(reservationId);
		}
	}

	// -- cross-aggregate reads -------------------------------------------------

	/**
	 * The attach guard: stamp the hold's deadline, which only succeeds while the
	 * hold is still `held`. A refusal is {@link HoldExpiredError}, which the add
	 * use-case maps to its typed `HOLD_EXPIRED` failure.
	 *
	 * It is one guarded WRITE rather than a read followed by a cart write, which is
	 * what closes the window the SQL adapter never had: a hold reaped between a
	 * read and the cart write would otherwise still be attached.
	 */
	async #stampAttach(
		reservationId: string,
		expiresAt: string | null,
	): Promise<{
		reserveKey: string;
	}> {
		const index = await this.#reservationIndex.get(reservationId);
		if (index === null) throw new HoldExpiredError(reservationId);
		const stamped = await this.#inventory.stampHoldDeadline(reservationId, expiresAt);
		if (!stamped) throw new HoldExpiredError(reservationId);
		return { reserveKey: index.idempotencyKey };
	}

	/**
	 * The live hold for `reservationId`, filed under `reserveKey`. `sku` may be
	 * null, in which case the reservation index supplies it.
	 */
	async #holdOf(
		sku: string | null,
		reserveKey: string,
		reservationId: string,
	): Promise<HoldEntry | undefined> {
		let owner = sku;
		if (owner === null) {
			const index = await this.#reservationIndex.get(reservationId);
			if (index === null) return undefined;
			owner = index.sku;
		}
		const doc = await this.#inventoryDocs.get(owner);
		if (doc === null) return undefined;
		const hold = normalizeInventoryDoc(doc).holds[reserveKey];
		return hold !== undefined && hold.reservationId === reservationId ? hold : undefined;
	}

	/** The hold's own qty — the inventory authority's truth for `adjustLine`. */
	async #holdQty(line: CartLineDoc): Promise<number | undefined> {
		if (line.reservationId === null || line.reserveKey === null) return undefined;
		const hold = await this.#holdOf(line.sku, line.reserveKey, line.reservationId);
		return hold?.qty;
	}

	/**
	 * A line's reservation lifecycle, as the cart fence reads it: the live hold's
	 * own state while it exists, otherwise the terminal state the reservation index
	 * keeps after the hold was pruned, otherwise `pending` (claimed, never applied).
	 */
	async #lifecycleOf(line: CartLineDoc): Promise<ReservationLifecycle | null> {
		if (line.reservationId === null) return null;
		if (line.reserveKey !== null) {
			const hold = await this.#holdOf(line.sku, line.reserveKey, line.reservationId);
			if (hold !== undefined) return hold.state;
		}
		const index = await this.#reservationIndex.get(line.reservationId);
		return index?.terminalState ?? "pending";
	}

	// -- document helpers ------------------------------------------------------

	async #toCart(doc: CartDoc): Promise<Cart> {
		// Sorted by line id so a cart reads back in one stable order on every
		// dialect, as the SQL's `ORDER BY cart_lines.id` did.
		const lines = Object.values(doc.lines).toSorted((a, b) => (a.lineId < b.lineId ? -1 : 1));
		const resolved: CartLine[] = [];
		for (const line of lines) {
			resolved.push(this.#toLine(doc.cartId, line, await this.#lifecycleOf(line)));
		}
		return {
			cartId: doc.cartId,
			state: doc.state,
			orderId: doc.orderId,
			currency: doc.currency,
			lines: resolved,
		};
	}

	#toLine(
		cartId: string,
		line: CartLineDoc,
		reservationState: ReservationLifecycle | null,
	): CartLine {
		return {
			lineId: line.lineId,
			cartId,
			sku: line.sku,
			productId: line.productId,
			qty: line.qty,
			reservationId: line.reservationId,
			reservationState,
			expiresAt: line.expiresAt,
		};
	}

	/** The cart document with one line written and some ledger entries merged. */
	#withLine(
		doc: CartDoc,
		line: CartLineDoc,
		mutations: Record<string, CartMutationRecord>,
	): CartDoc {
		const lines = { ...doc.lines, [line.sku]: line };
		// ONE pruned object, used for both the stored map and the denormalized
		// deadline: computing the deadline from the unpruned map would be computing
		// it from something the document does not contain.
		const mutationsAfter = pruneMutations({ ...doc.mutations, ...mutations });
		return {
			...doc,
			lines,
			mutations: mutationsAfter,
			holdExpiresAt: computeHoldExpiresAt({ lines, mutations: mutationsAfter }),
			updatedAt: this.#clock.now().toISOString(),
		};
	}

	/** The cart document with some ledger entries merged and nothing else moved. */
	#withMutations(doc: CartDoc, mutations: Record<string, CartMutationRecord>): CartDoc {
		const mutationsAfter = pruneMutations({ ...doc.mutations, ...mutations });
		return {
			...doc,
			mutations: mutationsAfter,
			holdExpiresAt: computeHoldExpiresAt({ lines: doc.lines, mutations: mutationsAfter }),
			updatedAt: this.#clock.now().toISOString(),
		};
	}

	/**
	 * A completed ledger entry. The claim may or may not pre-exist — a caller that
	 * skipped `claimMutation`, or a peer whose claim write was lost — so the
	 * completion is an upsert, exactly as the SQL's was.
	 */
	#completion(
		claim: CartMutationRecord | undefined,
		kind: CartMutationRecord["kind"],
		lineId: string | null,
		resultingQty: number | null,
	): CartMutationRecord {
		const now = this.#clock.now().toISOString();
		// Built field by field, NOT spread from the claim: `expiring` and `abandoned`
		// are markers of an unfinished or reaped mutation, and carrying either onto a
		// completed record would make a finished mutation look like outstanding
		// expiry work (and keep the record unprunable forever).
		return {
			kind: claim?.kind ?? kind,
			lineId,
			resultingQty,
			completed: true,
			claimedAt: claim?.claimedAt ?? now,
			completedAt: now,
		};
	}

	/** Create-if-absent locator write; idempotent, and safe to repeat. */
	async #ensureLocator(key: string, cartId: string): Promise<void> {
		await this.#mutationIndex.compareAndSet(key, null, { cartId });
	}

	async #mustVersioned(cartId: string): Promise<{ value: CartDoc; revision: string }> {
		const current = await this.#carts.getVersioned(cartId);
		if (current === null) throw new Error(`unknown cart: ${cartId}`);
		return current;
	}

	#casCart<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

function toRecorded(
	key: IdempotencyKey,
	cartId: string,
	record: CartMutationRecord,
): RecordedCartMutation {
	return {
		key,
		cartId,
		kind: record.kind,
		lineId: record.lineId,
		resultingQty: record.resultingQty,
		completed: record.completed,
	};
}

/**
 * The reservation id a reserve key document names. A `claimed` document always
 * carries one (it is minted before the claim); a `terminal` one carries `null`
 * exactly when the outcome was decided before any id existed — a refused reserve,
 * which has no hold to reap.
 */
function reservationIdOf(doc: ReservationKeyDoc | null): string | null {
	return doc === null ? null : doc.reservationId;
}
