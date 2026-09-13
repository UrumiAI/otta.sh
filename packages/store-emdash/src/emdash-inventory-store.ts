/**
 * `InventoryStore` over EmDash's plugin-storage primitives, on the embedded-holds
 * aggregate: one `inventory/{sku}` document carrying `onHand` **and** the live
 * holds that decremented it.
 *
 * ## Why the model is shaped this way
 *
 * There are no transactions here and no `SELECT … FOR UPDATE`. The only
 * atomicity primitives are single-document ones, so the rule is: *an invariant
 * that spans two facts lives in ONE document.* The decisive fact is that an
 * inventory decrement is not idempotent unless the row records who applied it —
 * which puts the holds map inside the inventory document, and makes the decrement
 * a single `compareAndSet` in which the guard (`onHand >= qty`, computed in JS),
 * the new count and the hold record all commit together. No oversell and
 * once-only are the same atom.
 *
 * ## Reserve is a two-step with ONE crash window
 *
 * `reserve` is: claim `reservation_keys/{key}` (create-if-absent, carrying the
 * sku, the qty and the minted reservation id) → the inventory `compareAndSet` →
 * update the key document to its terminal `ReserveResult`. The single crash window
 * is **claim written, `compareAndSet` not yet run**. It is healed, not merely
 * tolerated: any replayer of the key finds the `claimed` document and completes it
 * deterministically, reusing the RECORDED reservation id rather than minting a
 * second one, so the decrement happens exactly once and the caller gets one
 * answer. A sweeper reaps claims nothing ever replays (INC-C4).
 *
 * What the embedded aggregate removes is the SQL adapter's *second* window — a
 * `pending` reservation flipped to `held` separately from the decrement. The claim
 * window cannot be removed by any single-document primitive, because the claim and
 * the units necessarily live in different documents.
 *
 * ## The outcome-before-prune ordering
 *
 * A hold is pruned on commit/release, so the terminal `ReserveResult` is written
 * to the key document **before** the prune, and a replay reads that document
 * first. Prune-first-then-crash would let a replay conclude the key was fresh and
 * decrement a second time. The prune is the second, idempotent step.
 *
 * That *ordering* is only observable under fault injection, which is INC-A3's
 * tier, not this file's: the suites here pin the consequence (a replay after a
 * prune still answers from the key document) rather than the order of the two
 * writes.
 *
 * ## What is NOT atomic
 *
 * `adopt` / `adoptMany` / `commitMany` / `releaseAdopted` take reservation ids
 * with no sku, and one order's holds can span N SKUs — i.e. N documents. **These
 * methods are N per-SKU writes and are not atomic across SKUs.** Every write is
 * idempotent by reservation id (a hold already in the target state is a no-op
 * success), so a partially applied set is safe for any replayer to re-run to
 * completion; the order-side intent record that says *which* set was meant, and
 * the sweeper that completes it, are separate increments (INC-B2 / INC-C4). The
 * implementation therefore classifies every id first (index lookups), then
 * applies the work grouped by SKU — one `compareAndSet` per SKU, not per id.
 *
 * ## Contention
 *
 * Read-modify-write on a hot SKU retries. The budget is bounded and the
 * exhaustion failure is `StorageContentionError` — typed, retryable, and
 * deliberately NOT `OUT_OF_STOCK`. See `cas-retry.ts`.
 */
import type { Clock, IdGen, IdempotencyKey } from "@otta-sh/domain";
import {
	AdjustReservationMismatchError,
	ReservationCommitLostError,
	ReservationNotFoundError,
	ReservationNotHeldError,
	StockMovementMismatchError,
	type AdoptInput,
	type AdoptManyInput,
	type AdoptManyResult,
	type AdoptResult,
	type CommitManyResult,
	type InventoryStore,
	type ReserveResult,
	type RestockResult,
	type StockRemovalResult,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	StorageContentionError,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ReservationIdCollisionError } from "./errors.js";
import {
	adjustClaimId,
	findAppliedMovement,
	INVENTORY_COLLECTION,
	INVENTORY_MOVEMENTS_COLLECTION,
	newInventoryDoc,
	normalizeInventoryDoc,
	pushAppliedMovement,
	RESERVATION_INDEX_COLLECTION,
	RESERVATION_KEYS_COLLECTION,
	stockClaimId,
	type AdjustClaim,
	type HoldEntry,
	type InventoryDoc,
	type MovementClaimDoc,
	type ReservationIndexDoc,
	type ReservationKeyDoc,
	type StockDirection,
	type StockMovementClaim,
	type TerminalReservationState,
} from "./inventory-documents.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

export interface EmdashInventoryStoreOptions {
	/** The collections the plugin descriptor declared; see `INVENTORY_COLLECTIONS`. */
	storage: StorageAccess;
	/** Reservation ids come from here, never from `crypto.randomUUID()` directly. */
	idGen: IdGen;
	/** Timestamps come from here, never from `Date.now()` directly. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/**
	 * Override the retry backoff sleep. Reaches the retry loop, so a suite running
	 * on fake timers (or one that simply must not wait) can supply its own — with
	 * the default `setTimeout`, fake timers would hang the loop.
	 */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
}

/** One hold to remove from an aggregate, and why. */
interface PruneEntry {
	reserveKey: string;
	reservationId: string;
	terminal: TerminalReservationState;
}

/** The port's wording for a recorded stock movement, used in mismatch messages. */
function describeMovement(direction: StockDirection, qty: number, sku: string): string {
	return `${direction} ${String(qty)}×${sku}`;
}

/** How a movement claim of the other kind is described in a mismatch message. */
function describeOtherKind(claim: MovementClaimDoc): string {
	return claim.kind === "stock"
		? describeMovement(claim.direction, claim.qty, claim.sku)
		: `an adjust of reservation ${claim.reservationId}`;
}

function assertPositiveInt(value: number, method: string, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${method}() requires a positive integer ${field}, got ${String(value)}`);
	}
}

const OUT_OF_STOCK: ReserveResult = { ok: false, reason: "OUT_OF_STOCK" };

/** Rounds `reserve` spends resolving its key document; see the loop's comment. */
const ROUNDS = 2;

export class EmdashInventoryStore implements InventoryStore {
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #index: StorageCollection<ReservationIndexDoc>;
	readonly #keys: StorageCollection<ReservationKeyDoc>;
	readonly #movements: StorageCollection<MovementClaimDoc>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashInventoryStoreOptions) {
		this.#inventory = collectionOf<InventoryDoc>(options.storage, INVENTORY_COLLECTION);
		this.#index = collectionOf<ReservationIndexDoc>(options.storage, RESERVATION_INDEX_COLLECTION);
		this.#keys = collectionOf<ReservationKeyDoc>(options.storage, RESERVATION_KEYS_COLLECTION);
		this.#movements = collectionOf<MovementClaimDoc>(
			options.storage,
			INVENTORY_MOVEMENTS_COLLECTION,
		);
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
	}

	// -- reserve ---------------------------------------------------------------

	/**
	 * Claim the key, then ONE `compareAndSet` on `inventory/{sku}` in which the
	 * `onHand >= qty` guard, the decrement and the hold record commit together,
	 * then record the terminal outcome on the key document.
	 *
	 * The key document is the durable once-only guard and outlives every prune, so
	 * a replay is answered from it: a terminal document returns the recorded
	 * result, and a `claimed` document is COMPLETED with the recorded reservation id
	 * (never a fresh one). An unknown sku is a pre-claim rejection that does not
	 * consume the key; a genuine `OUT_OF_STOCK` on a known sku does.
	 */
	async reserve(sku: string, qty: number, key: IdempotencyKey): Promise<ReserveResult> {
		assertPositiveInt(qty, "reserve", "qty");

		// Two rounds are sufficient: a create-if-absent claim can only fail because
		// a document now exists, and the next round reads it.
		for (let round = 0; round < ROUNDS; round++) {
			const claim = await this.#keys.get(key);
			if (claim !== null) {
				if (claim.state === "terminal") return { ...claim.result };
				return this.#completeReserveClaim(key, claim, { alreadyGuarded: false });
			}

			const doc = await this.#inventory.get(sku);
			// No inventory document ⇒ outside the idempotency scope: nothing is
			// claimed and the key stays usable once the sku exists (mirroring the SQL
			// adapter, whose `reservations.sku` foreign key aborts the claim).
			if (doc === null) return { ...OUT_OF_STOCK };

			if (doc.onHand < qty) {
				// Decided before any id is minted: an `OUT_OF_STOCK` reserve leaves no
				// reservation id and no index document behind, only the terminal key
				// document that makes the replay stable.
				const written = await this.#keys.compareAndSet(key, null, {
					state: "terminal",
					result: { ...OUT_OF_STOCK },
					reservationId: null,
					recordedAt: this.#clock.now().toISOString(),
				});
				if (written.applied) return { ...OUT_OF_STOCK };
				continue; // a same-key peer claimed first: follow its claim
			}

			const claimed: ReservationKeyDoc = {
				state: "claimed",
				sku,
				qty,
				reservationId: this.#idGen.newId(),
				claimedAt: this.#clock.now().toISOString(),
			};
			const written = await this.#keys.compareAndSet(key, null, claimed);
			if (!written.applied) continue; // a same-key peer claimed first
			return this.#completeReserveClaim(key, claimed, { alreadyGuarded: true });
		}
		// Unreachable by construction: a create-if-absent claim can only fail because
		// a document now exists, and the next round reads it. If it ever happens the
		// key is contended beyond what this loop can resolve, which is the same
		// condition as an exhausted retry budget — typed and retryable, never a bare
		// failure the route boundary cannot classify.
		throw new StorageContentionError("reserve (claim resolution)", ROUNDS, {
			cause: new Error(`the claim for idempotency key ${key} could not be read back`),
		});
	}

	/**
	 * Finish a claimed reserve: the reverse-lookup document, then the inventory
	 * `compareAndSet`, then the terminal outcome on the key document. Safe to run
	 * any number of times, from any caller — this IS the crash-window heal path.
	 *
	 * `alreadyGuarded` says the caller just read `onHand >= qty` for this claim, so
	 * the extra pre-read that would spare an `OUT_OF_STOCK` completion its index
	 * document is skipped on the hot path and taken on the (exceptional) heal path.
	 */
	async #completeReserveClaim(
		key: string,
		claim: Extract<ReservationKeyDoc, { state: "claimed" }>,
		options: { alreadyGuarded: boolean },
	): Promise<ReserveResult> {
		if (!options.alreadyGuarded) {
			const doc = await this.#inventory.get(claim.sku);
			const holds = doc === null ? {} : normalizeInventoryDoc(doc).holds;
			if (holds[key] === undefined && (doc === null || doc.onHand < claim.qty)) {
				// The completion cannot succeed and never wrote a hold, so it needs no
				// reverse-lookup document either.
				await this.#markKeyTerminal(key, { ...OUT_OF_STOCK }, claim.reservationId);
				await this.#setTerminalState(claim.reservationId, "failed");
				return { ...OUT_OF_STOCK };
			}
		}

		// The reverse lookup, BEFORE the hold: an id absent from `reservation_index`
		// is provably unknown, which is what `commit`'s 404 and `commitMany`'s throw
		// rest on. A collision must never be silently adopted.
		const indexed = await this.#index.compareAndSet(claim.reservationId, null, {
			sku: claim.sku,
			idempotencyKey: key,
		});
		if (!indexed.applied) {
			const existing = await this.#index.get(claim.reservationId);
			if (existing !== null && existing.idempotencyKey !== key) {
				throw new ReservationIdCollisionError(claim.reservationId, key, existing.idempotencyKey);
			}
		}

		const result = await this.#cas<ReserveResult>("reserve", async () => {
			const current = await this.#inventory.getVersioned(claim.sku);
			if (current === null) return casDone<ReserveResult>({ ...OUT_OF_STOCK });
			const doc = normalizeInventoryDoc(current.value);

			// This claim's hold is already in place: the decrement happened, and this
			// caller is a replay (or a same-key peer that lost the race to apply it).
			const existing = doc.holds[key];
			if (existing !== undefined) {
				return casDone<ReserveResult>({ ok: true, reservationId: existing.reservationId });
			}

			// No hold — but that is not proof the decrement never happened. A peer
			// completing THIS claim may have created the hold, committed it and PRUNED
			// it while this caller was between its own claim read and this attempt, and
			// a committed prune leaves `onHand` low with nothing to show for it. Writing
			// a second hold here would decrement a second time, and `#prune` would never
			// return those units: permanent, silent stock loss. The key document is the
			// durable record, so it is re-read on every attempt that finds no hold.
			const settled = await this.#keys.get(key);
			if (settled !== null && settled.state === "terminal") {
				return casDone<ReserveResult>({ ...settled.result });
			}

			if (doc.onHand < claim.qty) return casDone<ReserveResult>({ ...OUT_OF_STOCK });

			const hold: HoldEntry = {
				reservationId: claim.reservationId,
				qty: claim.qty,
				state: "held",
				expiresAt: null,
				orderId: null,
				createdAt: this.#clock.now().toISOString(),
			};
			const written = await this.#inventory.compareAndSet(claim.sku, current.revision, {
				...doc,
				onHand: doc.onHand - claim.qty,
				holds: { ...doc.holds, [key]: hold },
			});
			if (!written.applied) return CAS_RETRY;
			return casDone<ReserveResult>({ ok: true, reservationId: claim.reservationId });
		});

		await this.#markKeyTerminal(key, result, claim.reservationId);
		if (!result.ok) await this.#setTerminalState(claim.reservationId, "failed");
		return result;
	}

	// -- commit / release ------------------------------------------------------

	/**
	 * The `held|adopted → committed` settle. Deliberately order-unscoped, exactly
	 * like the SQL adapter's. A double commit is a benign no-op; a reservation that
	 * lost its hold (released/failed) is the loud `ReservationCommitLostError`
	 * anomaly, never a silent success.
	 */
	async commit(reservationId: string): Promise<void> {
		const index = await this.#mustIndex(reservationId);
		if (index.terminalState !== undefined) {
			// A terminal state, once written, is the truth — even if the prune it
			// precedes has not run yet. Finish that prune, then answer from it.
			await this.#prune(index.sku, this.#pruneEntries(index, reservationId), "commit");
			if (index.terminalState === "committed") return; // benign double-commit
			throw new ReservationCommitLostError(reservationId, index.terminalState);
		}
		const hold = await this.#liveHold(index, reservationId);
		// No hold and no terminal state: the reserve claim was abandoned before its
		// inventory write. The SQL adapter sees a `pending` row here and raises the
		// same loud anomaly.
		if (hold === undefined) throw new ReservationCommitLostError(reservationId, "pending");
		await this.#settle(index, reservationId, "committed");
	}

	/** The `held|adopted → released` flip plus the stock return. */
	async release(reservationId: string): Promise<void> {
		const index = await this.#mustIndex(reservationId);
		if (index.terminalState !== undefined) {
			await this.#prune(index.sku, this.#pruneEntries(index, reservationId), "release");
			if (index.terminalState === "released") return; // benign double-release
			throw new Error(
				`cannot release reservation ${reservationId} in state ${index.terminalState}`,
			);
		}
		const hold = await this.#liveHold(index, reservationId);
		if (hold === undefined) {
			throw new Error(`cannot release reservation ${reservationId} in state pending`);
		}
		await this.#settle(index, reservationId, "released");
	}

	/**
	 * The ORDER-SCOPED release: an order may only release a hold IT adopted.
	 * Anything else — unknown id, already terminal, another order's hold, a hold
	 * still cart-`held` — is a silent no-op, never a throw: an unscoped release
	 * here is how a stale order could free a live checkout's hold, or crash the
	 * expiry sweep forever on a committed one.
	 */
	async releaseAdopted(reservationId: string, orderId: string): Promise<void> {
		const index = await this.#index.get(reservationId);
		if (index === null) return;
		if (index.terminalState !== undefined) {
			await this.#prune(index.sku, this.#pruneEntries(index, reservationId), "releaseAdopted");
			return;
		}
		const hold = await this.#liveHold(index, reservationId);
		if (hold === undefined || hold.state !== "adopted" || hold.orderId !== orderId) return;
		await this.#settle(index, reservationId, "released");
	}

	/**
	 * Batched settle. Every id is classified first (an unknown one PROPAGATES as
	 * `ReservationNotFoundError`, matching singular `commit` — unlike `adoptMany`,
	 * which folds an unknown id into `lost`), then the surviving work is applied
	 * one `compareAndSet` per SKU. Not atomic across SKUs; each per-SKU write is
	 * idempotent, so a partial application is safe to re-run.
	 *
	 * Duplicate input ids are collapsed: membership sets must not report an id
	 * twice because a caller listed it twice.
	 */
	async commitMany(reservationIds: string[]): Promise<CommitManyResult> {
		const ids = [...new Set(reservationIds)];
		if (ids.length === 0) return { lost: [] };
		const indexes = await this.#resolveMany(ids);

		const lost: string[] = [];
		const bySku = new Map<string, Array<{ id: string; index: ReservationIndexDoc }>>();
		for (const id of ids) {
			const index = indexes.get(id);
			// Truly unknown: never folded into `lost`.
			if (index === undefined) throw new ReservationNotFoundError(id);
			if (index.terminalState === "committed") continue; // benign replay
			if (index.terminalState !== undefined) {
				lost.push(id); // released / failed ⇒ the COMMIT_LOST anomaly at settle
				continue;
			}
			const group = bySku.get(index.sku) ?? [];
			group.push({ id, index });
			bySku.set(index.sku, group);
		}

		for (const [sku, group] of bySku) {
			const doc = await this.#inventory.get(sku);
			const holds = doc === null ? {} : normalizeInventoryDoc(doc).holds;
			const prunable: PruneEntry[] = [];
			for (const { id, index } of group) {
				const hold = holds[index.idempotencyKey];
				if (hold === undefined || hold.reservationId !== id) {
					lost.push(id); // claim abandoned before its hold ⇒ `pending` at the SQL adapter
					continue;
				}
				prunable.push({
					reserveKey: index.idempotencyKey,
					reservationId: id,
					terminal: "committed",
				});
			}
			if (prunable.length === 0) continue;
			// The terminal records for EVERY id first, then one prune per SKU.
			await Promise.all(
				prunable.map((entry) =>
					this.#recordTerminal(entry.reserveKey, entry.reservationId, "committed"),
				),
			);
			await this.#prune(sku, prunable, "commitMany");
		}
		return { lost };
	}

	// -- adopt ----------------------------------------------------------------

	/**
	 * The guarded `held → adopted` flip. Scoped to a hold that is `held` and whose
	 * deadline is still in the future, so it can never adopt a hold the expiry
	 * sweep is about to reap. An already-`adopted` hold for THIS order resolves to
	 * `ok` without re-checking the deadline (the idempotent replay of order
	 * creation); anything else is `RESERVATION_LOST`.
	 *
	 * A hold with NO stamped deadline is NOT adoptable, per the port's own
	 * statement of the guard (`WHERE state='held' AND expires_at > :now`, where a
	 * SQL `NULL` never satisfies the comparison). The in-memory fake treats an
	 * unstamped hold as adoptable and is the outlier; reconciling the two is a
	 * follow-up on the fake, outside this increment. In practice the cart stamps
	 * the deadline before checkout, so this is the "never stamped ⇒ not a checkout
	 * hold" case, not a live one.
	 */
	async adopt(input: AdoptInput): Promise<AdoptResult> {
		const index = await this.#mustIndex(input.reservationId);
		const result = await this.#adoptGrouped(
			index.sku,
			[{ id: input.reservationId, index }],
			{
				orderId: input.orderId,
				holdExpiresAt: input.holdExpiresAt,
				now: input.now,
			},
			"adopt",
		);
		return result.adopted.length === 1 ? { ok: true } : { ok: false, reason: "RESERVATION_LOST" };
	}

	/**
	 * Batched `adopt`: one order's holds across N SKUs. An unknown id is folded
	 * into `lost` and never throws — the asymmetry with `commitMany` is deliberate
	 * and is the port's. Applied one `compareAndSet` per SKU; not atomic across
	 * SKUs, and every flip is idempotent by reservation id. Duplicate input ids are
	 * collapsed.
	 */
	async adoptMany(input: AdoptManyInput): Promise<AdoptManyResult> {
		const ids = [...new Set(input.reservationIds)];
		if (ids.length === 0) return { adopted: [], lost: [] };
		const indexes = await this.#resolveMany(ids);

		const adopted: string[] = [];
		const lost: string[] = [];
		const bySku = new Map<string, Array<{ id: string; index: ReservationIndexDoc }>>();
		for (const id of ids) {
			const index = indexes.get(id);
			if (index === undefined || index.terminalState !== undefined) {
				lost.push(id); // unknown, committed, released or failed ⇒ lost, never a throw
				continue;
			}
			const group = bySku.get(index.sku) ?? [];
			group.push({ id, index });
			bySku.set(index.sku, group);
		}

		for (const [sku, group] of bySku) {
			const outcome = await this.#adoptGrouped(sku, group, input, "adoptMany");
			adopted.push(...outcome.adopted);
			lost.push(...outcome.lost);
		}
		return { adopted, lost };
	}

	/** Every adopt for ONE sku in a single `compareAndSet`. */
	async #adoptGrouped(
		sku: string,
		group: ReadonlyArray<{ id: string; index: ReservationIndexDoc }>,
		input: { orderId: string; holdExpiresAt: string; now: string },
		operation: string,
	): Promise<AdoptManyResult> {
		return this.#cas<AdoptManyResult>(operation, async () => {
			const current = await this.#inventory.getVersioned(sku);
			if (current === null) {
				return casDone<AdoptManyResult>({ adopted: [], lost: group.map((e) => e.id) });
			}
			const doc = normalizeInventoryDoc(current.value);
			const holds = { ...doc.holds };
			const adopted: string[] = [];
			const lost: string[] = [];
			let changed = false;

			for (const { id, index } of group) {
				const hold = holds[index.idempotencyKey];
				if (hold === undefined || hold.reservationId !== id) {
					lost.push(id);
					continue;
				}
				if (hold.state === "adopted") {
					// Idempotent replay for THIS order — no deadline re-check, so a hold
					// adopted for this order past its deadline is still success.
					if (hold.orderId === input.orderId) adopted.push(id);
					else lost.push(id);
					continue;
				}
				if (hold.expiresAt === null || hold.expiresAt <= input.now) {
					lost.push(id); // never stamped, or about to be swept
					continue;
				}
				holds[index.idempotencyKey] = {
					...hold,
					state: "adopted",
					orderId: input.orderId,
					expiresAt: input.holdExpiresAt,
				};
				adopted.push(id);
				changed = true;
			}

			if (!changed) return casDone<AdoptManyResult>({ adopted, lost });
			const written = await this.#inventory.compareAndSet(sku, current.revision, { ...doc, holds });
			if (!written.applied) return CAS_RETRY;
			return casDone<AdoptManyResult>({ adopted, lost });
		});
	}

	// -- adjust ----------------------------------------------------------------

	/**
	 * Move a live `held` hold to `newQty`, coupling the qty change with its
	 * inventory movement in ONE `compareAndSet` — the qty never moves without the
	 * stock. An increase is the oversell-critical guarded decrement of the delta
	 * (`OUT_OF_STOCK` when the units are genuinely not there, hold unchanged); a
	 * decrease is an unconditional return of units.
	 *
	 * **Exactly-once by per-key claim document.**
	 * `inventory_movements/adjust:{key}` carries the intent and is updated to
	 * `applied` with the recorded result once the units moved. A replay reads it
	 * first: `applied` ⇒ the recorded result, moving nothing, even for a stale replay
	 * arriving after later same-reservation adjusts. Guards run BEFORE the claim, so
	 * an unknown or non-`held` reservation never consumes the key.
	 *
	 * **A claimed-but-unapplied intent is RE-DERIVED, not refused.** `adjust` takes
	 * an absolute target, and the SQL reference re-derives the previous qty on every
	 * retry (its lost qty CAS rolls the claim back with the transaction), so it
	 * always applies. This adapter matches that: a completion reads the hold's
	 * CURRENT qty and applies the absolute `toQty` against it. The claim's `fromQty`
	 * is the qty observed when the intent was recorded — audit, not a guard.
	 *
	 * **Every caller's answer comes from the durable record only**, never from a
	 * locally computed value a same-key peer could disagree with: after the write
	 * phase, the answer is read back from the claim document, or from the aggregate's
	 * own witness (the applied-movement ring, or the hold's `lastMovementKey`) which
	 * is then recorded on the claim. First writer wins, and both callers return it.
	 *
	 * **Documented residual.** If the hold is gone AND the key is neither in the
	 * aggregate's ring nor on a hold, there is no durable witness left that this key
	 * ever applied, and the call throws `ReservationNotHeldError` rather than invent
	 * a recorded answer. Reaching that state takes a crash between the aggregate
	 * write and the claim update, followed by the hold being pruned and the key being
	 * evicted from a ring of {@link APPLIED_MOVEMENT_RING_SIZE} entries. Closing it
	 * would need a second atomic document, which these primitives do not offer; the
	 * sweeper contract that bounds it is in this package's README.
	 */
	async adjust(reservationId: string, newQty: number, key: IdempotencyKey): Promise<ReserveResult> {
		assertPositiveInt(newQty, "adjust", "newQty");

		const claimId = adjustClaimId(key);
		const existing = await this.#movements.get(claimId);
		if (existing !== null) {
			const claim = this.#asAdjustClaim(key, existing, reservationId);
			if (claim.applied !== undefined) return { ...claim.applied.result };
			// The crash window: the intent is durable but the units never moved.
			return this.#applyAdjustClaim(key, claimId, claim);
		}

		const index = await this.#mustIndex(reservationId);
		const hold = await this.#liveHold(index, reservationId);
		if (hold === undefined) {
			throw new ReservationNotHeldError(reservationId, index.terminalState ?? "pending");
		}
		if (hold.state !== "held") throw new ReservationNotHeldError(reservationId, hold.state);

		const intent: AdjustClaim = {
			kind: "adjust",
			sku: index.sku,
			reservationId,
			reserveKey: index.idempotencyKey,
			fromQty: hold.qty,
			toQty: newQty,
			createdAt: this.#clock.now().toISOString(),
		};
		const written = await this.#movements.compareAndSet(claimId, null, intent);
		if (!written.applied) {
			// A same-key peer claimed first; its intent is the one that counts.
			const peer = await this.#movements.get(claimId);
			if (peer !== null) {
				const claim = this.#asAdjustClaim(key, peer, reservationId);
				if (claim.applied !== undefined) return { ...claim.applied.result };
				return this.#applyAdjustClaim(key, claimId, claim);
			}
		}
		return this.#applyAdjustClaim(key, claimId, intent);
	}

	/** Narrow a movement claim to an adjust of THIS reservation, or reject it. */
	#asAdjustClaim(key: string, claim: MovementClaimDoc, reservationId: string): AdjustClaim {
		if (claim.kind !== "adjust") {
			throw new AdjustReservationMismatchError(key, describeOtherKind(claim), reservationId);
		}
		if (claim.reservationId !== reservationId) {
			throw new AdjustReservationMismatchError(key, claim.reservationId, reservationId);
		}
		return claim;
	}

	/**
	 * Apply a claimed adjust to the aggregate, then read the answer back out of the
	 * durable record. The two phases are separate on purpose: the write phase is
	 * once-only by the aggregate's own witness, and the answer phase is shared by
	 * every same-key caller, so a winner and a loser cannot disagree.
	 */
	async #applyAdjustClaim(
		key: string,
		claimId: string,
		claim: AdjustClaim,
	): Promise<ReserveResult> {
		await this.#cas<void>("adjust", async () => {
			const current = await this.#inventory.getVersioned(claim.sku);
			if (current === null) return casDone<void>(undefined); // answered below
			const doc = normalizeInventoryDoc(current.value);

			// Already applied, as remembered by the aggregate.
			if (findAppliedMovement(doc.appliedMovements, key) !== undefined) {
				return casDone<void>(undefined);
			}

			const hold = doc.holds[claim.reserveKey];
			if (hold === undefined || hold.reservationId !== claim.reservationId) {
				return casDone<void>(undefined); // no hold to move; answered below
			}
			// The hold's own witness, which outlives eviction from the ring.
			if (hold.lastMovementKey === key) return casDone<void>(undefined);
			if (hold.state !== "held") {
				throw new ReservationNotHeldError(claim.reservationId, hold.state);
			}

			// Re-derived against the hold AS STORED — exactly what a rolled-back and
			// retried SQL adjust does. The absolute target is what the caller asked
			// for; the delta is whatever gets the hold there from where it is now.
			const delta = claim.toQty - hold.qty;
			if (delta > 0 && doc.onHand < delta) {
				// Genuinely insufficient stock: the port's own outcome for an increase
				// that cannot be backed by units. Recorded so it replays deterministically.
				const failed: ReserveResult = { ...OUT_OF_STOCK };
				const written = await this.#inventory.compareAndSet(claim.sku, current.revision, {
					...doc,
					appliedMovements: pushAppliedMovement(doc.appliedMovements, {
						key,
						kind: "adjust",
						result: failed,
					}),
				});
				return written.applied ? casDone<void>(undefined) : CAS_RETRY;
			}

			const written = await this.#inventory.compareAndSet(claim.sku, current.revision, {
				...doc,
				onHand: doc.onHand - delta,
				holds: {
					...doc.holds,
					[claim.reserveKey]: { ...hold, qty: claim.toQty, lastMovementKey: key },
				},
				appliedMovements: pushAppliedMovement(doc.appliedMovements, {
					key,
					kind: "adjust",
					result: { ok: true, reservationId: claim.reservationId },
				}),
			});
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});

		return this.#resolveAdjustAnswer(key, claimId, claim);
	}

	/**
	 * The answer phase: the durable record, or the aggregate's witness promoted onto
	 * the claim document. Never a locally computed value.
	 */
	async #resolveAdjustAnswer(
		key: string,
		claimId: string,
		claim: AdjustClaim,
	): Promise<ReserveResult> {
		const stored = await this.#movements.get(claimId);
		if (stored !== null && stored.kind === "adjust" && stored.applied !== undefined) {
			return { ...stored.applied.result };
		}

		const doc = await this.#inventory.get(claim.sku);
		const aggregate = doc === null ? undefined : normalizeInventoryDoc(doc);
		const remembered = findAppliedMovement(aggregate?.appliedMovements, key);
		let witnessed: ReserveResult | undefined;
		if (remembered?.kind === "adjust") {
			witnessed = remembered.result;
		} else {
			const hold = aggregate?.holds[claim.reserveKey];
			if (hold?.reservationId === claim.reservationId && hold?.lastMovementKey === key) {
				witnessed = { ok: true, reservationId: claim.reservationId };
			}
		}
		if (witnessed === undefined) {
			// No durable witness: nothing moved and the hold is no longer this
			// reservation's to move — or the documented residual above.
			throw new ReservationNotHeldError(claim.reservationId, "pending");
		}

		await this.#markMovementApplied(claimId, (doc2) =>
			doc2.kind === "adjust"
				? { ...doc2, applied: { result: witnessed, appliedAt: this.#clock.now().toISOString() } }
				: undefined,
		);
		// Re-read: whoever marked first owns the answer, and both callers return it.
		const settled = await this.#movements.get(claimId);
		if (settled !== null && settled.kind === "adjust" && settled.applied !== undefined) {
			return { ...settled.applied.result };
		}
		return witnessed;
	}

	// -- raw stock reads and writes -------------------------------------------

	/**
	 * Create-if-absent initial stock. The document id IS the idempotency, so this
	 * is one `compareAndSet(sku, null, …)`: seeding a new sku creates it, and
	 * re-seeding an existing one — including one a `reserve` has already
	 * decremented — is a no-op that never clobbers the live count.
	 */
	async seedOnHand(sku: string, qty: number): Promise<void> {
		if (!Number.isSafeInteger(qty) || qty < 0) {
			throw new RangeError(`seedOnHand() requires a non-negative integer, got ${String(qty)}`);
		}
		await this.#inventory.compareAndSet(sku, null, newInventoryDoc(sku, qty));
	}

	/** A sku with no document reads `0` — mirrors the SQL adapter's LEFT JOIN miss. */
	async getOnHand(sku: string): Promise<number> {
		const doc = await this.#inventory.get(sku);
		return doc?.onHand ?? 0;
	}

	/** The same read with row presence preserved: `null` means "no document". */
	async findOnHand(sku: string): Promise<number | null> {
		const doc = await this.#inventory.get(sku);
		return doc === null ? null : doc.onHand;
	}

	/**
	 * Merchant restock: an unconditional, oversell-safe increment. Adding units can
	 * never invalidate a concurrent reservation, so there is no guard to fail —
	 * only the claim discipline that makes a double-clicked restock add once.
	 */
	async restock(sku: string, qty: number, key: IdempotencyKey): Promise<RestockResult> {
		assertPositiveInt(qty, "restock", "qty");
		const result = await this.#moveStock(sku, qty, key, "restock");
		return result.ok ? result : { ok: false, reason: "UNKNOWN_SKU" };
	}

	/**
	 * Merchant stock removal: the oversell-critical guarded decrement, the same
	 * `onHand >= qty` guard `reserve` uses and competing for the same units. It can
	 * never drive the count below zero.
	 */
	async removeStock(sku: string, qty: number, key: IdempotencyKey): Promise<StockRemovalResult> {
		assertPositiveInt(qty, "removeStock", "qty");
		return this.#moveStock(sku, qty, key, "removal");
	}

	/**
	 * The shared `restock`/`removeStock` body. Exactly-once by per-key claim
	 * document: `inventory_movements/stock:{key}` carries the intent (sku,
	 * direction, qty) — which is what makes a key reused for a DIFFERENT movement a
	 * typed rejection rather than an `ok` echoing the wrong one — and is updated to
	 * `applied` with the recorded result once the units moved. An `UNKNOWN_SKU`
	 * rejection precedes the claim, so it does not consume the key; an
	 * `INSUFFICIENT_STOCK` on a known sku is a terminal outcome that does.
	 */
	async #moveStock(
		sku: string,
		qty: number,
		key: string,
		direction: StockDirection,
	): Promise<StockRemovalResult> {
		const claimId = stockClaimId(key);
		const existing = await this.#movements.get(claimId);
		if (existing !== null) {
			const claim = this.#asStockClaim(key, existing, sku, direction, qty);
			if (claim.applied !== undefined) return { ...claim.applied.result };
			return this.#applyStockClaim(key, claimId, claim);
		}

		// Unknown sku: `seedOnHand` is the sole create path, so a typo'd sku can
		// never conjure phantom inventory — and the key stays unconsumed.
		if ((await this.#inventory.get(sku)) === null) return { ok: false, reason: "UNKNOWN_SKU" };

		const intent: StockMovementClaim = {
			kind: "stock",
			sku,
			direction,
			qty,
			createdAt: this.#clock.now().toISOString(),
		};
		const written = await this.#movements.compareAndSet(claimId, null, intent);
		if (!written.applied) {
			const peer = await this.#movements.get(claimId);
			if (peer !== null) {
				const claim = this.#asStockClaim(key, peer, sku, direction, qty);
				if (claim.applied !== undefined) return { ...claim.applied.result };
				return this.#applyStockClaim(key, claimId, claim);
			}
		}
		return this.#applyStockClaim(key, claimId, intent);
	}

	/** Narrow a movement claim to THIS stock movement, or reject the reuse. */
	#asStockClaim(
		key: string,
		claim: MovementClaimDoc,
		sku: string,
		direction: StockDirection,
		qty: number,
	): StockMovementClaim {
		if (
			claim.kind !== "stock" ||
			claim.sku !== sku ||
			claim.direction !== direction ||
			claim.qty !== qty
		) {
			throw new StockMovementMismatchError(
				key,
				describeOtherKind(claim),
				describeMovement(direction, qty, sku),
			);
		}
		return claim;
	}

	/** Apply a claimed stock movement to the aggregate, then mark it applied. */
	async #applyStockClaim(
		key: string,
		claimId: string,
		claim: StockMovementClaim,
	): Promise<StockRemovalResult> {
		const result = await this.#cas<StockRemovalResult>(
			claim.direction === "restock" ? "restock" : "removeStock",
			async () => {
				const current = await this.#inventory.getVersioned(claim.sku);
				if (current === null) {
					return casDone<StockRemovalResult>({ ok: false, reason: "UNKNOWN_SKU" });
				}
				const doc = normalizeInventoryDoc(current.value);
				const remembered = findAppliedMovement(doc.appliedMovements, key);
				if (remembered?.kind === "stock") {
					return casDone<StockRemovalResult>({ ...remembered.result });
				}

				let moved: StockRemovalResult;
				let onHand = doc.onHand;
				if (claim.direction === "restock") {
					onHand = doc.onHand + claim.qty;
					moved = { ok: true, onHand };
				} else if (doc.onHand < claim.qty) {
					moved = { ok: false, reason: "INSUFFICIENT_STOCK", onHand: doc.onHand };
				} else {
					onHand = doc.onHand - claim.qty;
					moved = { ok: true, onHand };
				}

				const written = await this.#inventory.compareAndSet(claim.sku, current.revision, {
					...doc,
					onHand,
					appliedMovements: pushAppliedMovement(doc.appliedMovements, {
						key,
						kind: "stock",
						result: moved,
					}),
				});
				if (!written.applied) return CAS_RETRY;
				return casDone<StockRemovalResult>(moved);
			},
		);

		await this.#markMovementApplied(claimId, (stored) =>
			stored.kind === "stock"
				? { ...stored, applied: { result, appliedAt: this.#clock.now().toISOString() } }
				: undefined,
		);
		// Read the answer back out of the durable record, so a same-key pair cannot
		// disagree: whoever marked the claim first owns the recorded result.
		const settled = await this.#movements.get(claimId);
		if (settled !== null && settled.kind === "stock" && settled.applied !== undefined) {
			return { ...settled.applied.result };
		}
		return result;
	}

	/** Record a movement claim's terminal answer. First writer wins; idempotent. */
	async #markMovementApplied(
		claimId: string,
		build: (stored: MovementClaimDoc) => MovementClaimDoc | undefined,
	): Promise<void> {
		await this.#cas<void>("movementApplied", async () => {
			const current = await this.#movements.getVersioned(claimId);
			if (current === null || current.value.applied !== undefined) return casDone<void>(undefined);
			const next = build(current.value);
			if (next === undefined) return casDone<void>(undefined);
			const written = await this.#movements.compareAndSet(claimId, current.revision, next);
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});
	}

	// -- shared internals ------------------------------------------------------

	#cas<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}

	/** An id absent from `reservation_index` is provably unknown. */
	async #mustIndex(reservationId: string): Promise<ReservationIndexDoc> {
		const index = await this.#index.get(reservationId);
		if (index === null) throw new ReservationNotFoundError(reservationId);
		return index;
	}

	async #resolveMany(reservationIds: readonly string[]): Promise<Map<string, ReservationIndexDoc>> {
		const rows = await Promise.all(reservationIds.map((id) => this.#index.get(id)));
		const byId = new Map<string, ReservationIndexDoc>();
		for (const [i, id] of reservationIds.entries()) {
			const row = rows[i];
			if (row !== null && row !== undefined) byId.set(id, row);
		}
		return byId;
	}

	/** The hold this reservation owns, if it is still live in the aggregate. */
	async #liveHold(
		index: ReservationIndexDoc,
		reservationId: string,
	): Promise<HoldEntry | undefined> {
		const doc = await this.#inventory.get(index.sku);
		if (doc === null) return undefined;
		const hold = normalizeInventoryDoc(doc).holds[index.idempotencyKey];
		// A hold filed under this key but owned by a DIFFERENT id cannot be this
		// reservation's — a completion always reuses the claimed id, so this is only
		// reachable if an id source collided.
		return hold !== undefined && hold.reservationId === reservationId ? hold : undefined;
	}

	#pruneEntries(index: ReservationIndexDoc, reservationId: string): PruneEntry[] {
		if (index.terminalState === undefined || index.terminalState === "failed") return [];
		return [{ reserveKey: index.idempotencyKey, reservationId, terminal: index.terminalState }];
	}

	/**
	 * The ordered settle: **terminal outcome, then terminal state, then the prune**.
	 * Writing the outcome before the prune is what keeps a reserve replay from
	 * looking fresh after the hold is gone. Every step is idempotent, so any
	 * replayer can finish an interrupted settle.
	 */
	async #settle(
		index: ReservationIndexDoc,
		reservationId: string,
		terminal: TerminalReservationState,
	): Promise<void> {
		await this.#recordTerminal(index.idempotencyKey, reservationId, terminal);
		await this.#prune(
			index.sku,
			[{ reserveKey: index.idempotencyKey, reservationId, terminal }],
			terminal === "committed" ? "commit" : "release",
		);
	}

	/** Steps 1 and 2 of the settle: the reserve key's answer, then the terminal state. */
	async #recordTerminal(
		reserveKey: string,
		reservationId: string,
		terminal: TerminalReservationState,
	): Promise<void> {
		// A hold exists, so the reserve succeeded: that is the answer the key
		// document must carry once the hold is gone.
		await this.#markKeyTerminal(reserveKey, { ok: true, reservationId }, reservationId);
		await this.#setTerminalState(reservationId, terminal);
	}

	/** Move a reservation key document to its terminal outcome. First writer wins. */
	async #markKeyTerminal(
		key: string,
		result: ReserveResult,
		reservationId: string | null,
	): Promise<void> {
		await this.#cas<void>("reserveKeyTerminal", async () => {
			const terminal: ReservationKeyDoc = {
				state: "terminal",
				result,
				reservationId,
				recordedAt: this.#clock.now().toISOString(),
			};
			const current = await this.#keys.getVersioned(key);
			if (current === null) {
				const created = await this.#keys.compareAndSet(key, null, terminal);
				return created.applied ? casDone<void>(undefined) : CAS_RETRY;
			}
			if (current.value.state === "terminal") return casDone<void>(undefined);
			const written = await this.#keys.compareAndSet(key, current.revision, terminal);
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});
	}

	/** First terminal state wins; a later one is a no-op. */
	async #setTerminalState(
		reservationId: string,
		terminal: TerminalReservationState,
	): Promise<void> {
		await this.#cas<void>("reservationTerminalState", async () => {
			const current = await this.#index.getVersioned(reservationId);
			if (current === null || current.value.terminalState !== undefined) {
				return casDone<void>(undefined);
			}
			const written = await this.#index.compareAndSet(reservationId, current.revision, {
				...current.value,
				terminalState: terminal,
			});
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});
	}

	/**
	 * Step 3 of the settle: remove the holds from the aggregate, returning units for
	 * the released ones. ONE `compareAndSet` for every entry on this sku. Idempotent
	 * — an already-pruned hold is simply absent — which is what makes an
	 * interrupted settle safe to re-run, and a partially applied batch safe to
	 * complete.
	 */
	async #prune(sku: string, entries: readonly PruneEntry[], operation: string): Promise<void> {
		if (entries.length === 0) return;
		await this.#cas<void>(operation, async () => {
			const current = await this.#inventory.getVersioned(sku);
			if (current === null) return casDone<void>(undefined);
			const doc = normalizeInventoryDoc(current.value);
			const holds = { ...doc.holds };
			let onHand = doc.onHand;
			let changed = false;
			for (const entry of entries) {
				const hold = holds[entry.reserveKey];
				if (hold === undefined || hold.reservationId !== entry.reservationId) continue;
				delete holds[entry.reserveKey];
				if (entry.terminal === "released") onHand += hold.qty;
				changed = true;
			}
			if (!changed) return casDone<void>(undefined);
			const written = await this.#inventory.compareAndSet(sku, current.revision, {
				...doc,
				onHand,
				holds,
			});
			return written.applied ? casDone<void>(undefined) : CAS_RETRY;
		});
	}
}
