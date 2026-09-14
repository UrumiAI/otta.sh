/**
 * The sku-rename stock carry: moving one sku's units onto another across two
 * documents, with no transaction to hold them together.
 *
 * The rule it implements belongs to the `sku` COLUMN rather than to any one
 * caller (see `ProductCommerceStore`'s port doc, THE SKU-RENAME RULE), so all
 * three writers of that column — `upsert`, `updateCommerceFields` and
 * `updateVariantFields` — come through here:
 *
 *  0. **REFUSE while the source has a live (`held`/`adopted`) reservation.** A
 *     hold's units are already out of `onHand` and the hold cannot follow the
 *     rename, so there is nothing honest to move. This is now a read of the very
 *     document the carry is about to write, which makes the guard STRUCTURAL: a
 *     reservation landing a moment later loses the source's revision and the
 *     refusal re-fires on the retry, where the SQL adapter needed the source row
 *     locked first to get the same outcome.
 *  1. **CLAIM the target**, create-if-absent. The insert IS the occupancy test,
 *     which is what makes it safe under concurrency: two writers reaching for one
 *     free target cannot both see it free, because the second's
 *     `compareAndSet(id, null, …)` is an `INSERT … ON CONFLICT DO NOTHING` that
 *     reports `applied: false`. Occupied is occupied — a target holding `0` is
 *     still a row, and refuses exactly like a stocked one.
 *  2. **MOVE**, as an intent-claim (ADR-0019 §3, decision D2): ONE
 *     `compareAndSet` on the source sets `onHand → 0` *and* stamps
 *     `transferOut: { token, toSku, qty }`; the target then adds `qty` iff its
 *     `appliedTransfers` ring lacks the token; then the source clears the stamp.
 *  3. **RETAIN the source, zeroed.** A stock document is never deleted and never
 *     re-keyed: reservations name the bare sku, so the rows a sold sku leaves
 *     behind are load-bearing history.
 *
 * **Why the token is derived, not minted.** It is `commandKey` plus the two skus,
 * so a replay of the same rename computes the same token: the stamp is recognised
 * as its own, the target's ring already holds it, and nothing is added twice. A
 * freshly minted token would make every retry a second transfer.
 *
 * **Every step is completable by anybody.** A crash leaves exactly one of three
 * states, and each is finishable from the source document alone: stamped but not
 * applied (the target adds the units), applied but not cleared (the source drops
 * the stamp), or neither. {@link SkuStockTransfer.completePending} is that
 * completion, and it is what the caller's own retry, a later rename of the same
 * sku, and the sweeper all run. Units are conserved at every seam, because while
 * a stamp is present its `qty` is recorded in the source document rather than
 * lost between the two.
 *
 * **What is retired by construction.** The SQL adapter acquired BOTH inventory
 * rows, in sorted sku order, precisely so two crossing renames could not
 * deadlock — and recorded that the avoidance was incomplete, since the
 * product-side writers took a unique-index lock ahead of the inventory locks and
 * a lock-order deadlock was never mapped to a typed error. There is no lock here
 * at all, so there is no order to get wrong: crossing renames each refuse or
 * apply on their own documents' revisions, and the residual goes with the
 * mechanism.
 */
import { SkuHeldStockError, SkuStockConflictError, type Clock } from "@otta-sh/domain";
import { CAS_RETRY, casDone, withCasRetry, type CasRetryOptions } from "./cas-retry.js";
import {
	hasAppliedTransfer,
	liveHoldCount,
	newInventoryDoc,
	normalizeInventoryDoc,
	pushAppliedTransfer,
	type InventoryDoc,
} from "./inventory-documents.js";
import type { StorageCollection } from "./storage-access.js";

/** Which end of a carry a ledger entry records. Mirrors the SQL adapter's wording. */
export type SkuRenameDirection = "rename_out" | "rename_in";

/**
 * One end of a carry, in `inventory_movements` — the audit trail a rename leaves.
 *
 * Every other `onHand` mutation an operator can trigger already lands in that
 * collection; without these two entries a rename would be the one way to move
 * forty units and leave nothing behind explaining where they went.
 *
 * It shares the collection with the movement claims `EmdashInventoryStore` writes
 * but never their ID SPACE: these ids are prefixed `rename:`, and that store's
 * replay lookups only ever address `stock:`/`adjust:` ids, so neither can read the
 * other's documents. That is also why this is a type of its own rather than a
 * third member of `MovementClaimDoc` — a rename is not a replayable movement, and
 * widening that union would put it within reach of the per-key replay paths.
 *
 * WRITE-ONLY today: nothing reads these entries yet. The trail exists so the
 * history is already there when a stock-movements view surfaces it.
 */
export interface SkuRenameLedgerDoc {
	kind: "rename";
	sku: string;
	direction: SkuRenameDirection;
	/** Units that moved. Only ever written when units actually moved. */
	qty: number;
	outcome: "ok";
	/** What the sku held once this end of the move was applied. */
	resultOnHand: number;
	/** The carry this entry belongs to — the pair's only shared handle. */
	token: string;
	createdAt: string;
}

/**
 * The carry's once-only token: the product write's own idempotency key plus both
 * skus. Derived rather than minted, so a replay recomputes it (see the module doc).
 */
export function skuTransferToken(commandKey: string, fromSku: string, toSku: string): string {
	return `sku-rename:${commandKey}:${fromSku}->${toSku}`;
}

/**
 * The ledger entry's document id.
 *
 * Derived from the CLIENT's idempotency key, so a caller can occupy one — by
 * reusing a key across two renames of the same sku, or by crafting a movement key
 * that lands on the same string. A collision therefore costs the AUDIT ENTRY and
 * never the merchant's rename: the write is create-if-absent and a lost claim is
 * swallowed. Failing a correct rename on a key the operator never chose would be
 * the worse outcome by far.
 */
export function skuRenameLedgerId(
	commandKey: string,
	direction: SkuRenameDirection,
	sku: string,
): string {
	return `rename:${direction}:${commandKey}:${sku}`;
}

export interface SkuStockTransferOptions {
	inventory: StorageCollection<InventoryDoc>;
	/** The shared movement collection, viewed as the rename ledger it also holds. */
	ledger: StorageCollection<SkuRenameLedgerDoc>;
	clock: Clock;
	retry?: CasRetryOptions;
}

export class SkuStockTransfer {
	readonly #inventory: StorageCollection<InventoryDoc>;
	readonly #ledger: StorageCollection<SkuRenameLedgerDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;

	constructor(options: SkuStockTransferOptions) {
		this.#inventory = options.inventory;
		this.#ledger = options.ledger;
		this.#clock = options.clock;
		this.#retry = options.retry ?? {};
	}

	/**
	 * Carry `fromSku`'s units onto `toSku`, or refuse — the whole of THE SKU-RENAME
	 * RULE, called only by a write that is actually applying.
	 *
	 * Throws `SkuHeldStockError` (the source still has a live hold) or
	 * `SkuStockConflictError` (the target already has an inventory document). A
	 * refusal on either writes NOTHING the caller can observe: the hold refusal
	 * fires before the target is claimed, and a lost claim is a write that never
	 * happened.
	 *
	 * `targetIsOurs` says the caller ALREADY held the target sku's live claim before
	 * this call — it did not take it just now. That is the one case in which an
	 * existing target document is NOT a conflict, and the distinction cannot be made
	 * from the inventory documents alone:
	 *
	 * - a genuine conflict is a target the caller has just claimed the SKU for and
	 *   whose inventory document nonetheless exists, i.e. units that belong to
	 *   nobody living, which is precisely what must never be merged;
	 * - `targetIsOurs` means the sku is already this owner's, so an existing document
	 *   under it is this owner's too — a pristine claim from an earlier attempt of
	 *   this very rename, `seedOnHand`'s always-attempt row, or the finished result
	 *   of a peer attempt. There is no second party's count to reconcile, so the
	 *   carry proceeds and the intent-claim's own idempotence decides how much (in
	 *   the peer-finished case, nothing: the source is already empty and unstamped).
	 *
	 * Without it, two concurrent writes renaming ONE product onto the SAME sku would
	 * have the second refuse a conflict the operator never created — which the SQL
	 * adapter avoided by making the second block on the product row's lock and then
	 * read `from === to`.
	 */
	async carry(
		fromSku: string,
		toSku: string,
		commandKey: string,
		targetIsOurs = false,
	): Promise<void> {
		if (fromSku === toSku) return;
		const token = skuTransferToken(commandKey, fromSku, toSku);

		// Step 0, as a plain read FIRST: the target must not be claimed by a write
		// the holds are about to refuse. The same check runs again inside the source
		// compare-and-set below, which is the one that is actually atomic — this one
		// exists so the refusal leaves no trace in the ordinary, uncontended case the
		// contract pins ("the target sku was never even claimed").
		await this.#refuseOnLiveHolds(fromSku);

		// Step 1. The claim IS the occupancy test; a conflict means the target already
		// has a document, whatever it holds.
		const claimed = await this.#inventory.compareAndSet(toSku, null, newInventoryDoc(toSku, 0));
		if (!claimed.applied && !targetIsOurs) throw new SkuStockConflictError(fromSku, toSku);

		// Step 2. Stamp the intent and zero the source in ONE write. The quantity is
		// decided INSIDE that write, never from an earlier read: a restock landing
		// under the old label between the two would otherwise be carried as a count
		// that no longer holds, or dropped.
		let qty: number;
		try {
			qty = await this.#stampSource(fromSku, toSku, token);
		} catch (err) {
			// A hold that arrived after the pre-read: the refusal is correct and the
			// claim we just made is a pristine, never-stocked document nothing can
			// reference yet, so it is withdrawn rather than left as litter.
			await this.#withdrawPristineClaim(toSku);
			throw err;
		}
		if (qty === 0) return;

		const resultOnHand = await this.#applyToTarget(toSku, token, qty);
		await this.#clearSource(fromSku, token);
		await this.#record(commandKey, token, fromSku, toSku, qty, resultOnHand);
	}

	/**
	 * Finish whatever carry `inventory/{sku}` has stamped, if any — the replayer and
	 * the sweeper's single entry point.
	 *
	 * Returns true when a stamp was found and completed. Idempotent: the target
	 * add is guarded by its own `appliedTransfers` ring and the clear is guarded by
	 * the token, so running this twice (or racing two runs) moves the units once.
	 *
	 * It deliberately writes NO ledger entry. The entries are derived from the
	 * command key, which a completion does not have; the audit trail may therefore
	 * be missing a pair for a rename that crashed mid-flight, and that is the
	 * honest outcome — an entry invented by a sweeper would claim a movement it
	 * cannot attribute.
	 */
	async completePending(sku: string): Promise<boolean> {
		const current = await this.#inventory.get(sku);
		const stamped = current === null ? undefined : current.transferOut;
		if (stamped === undefined) return false;
		await this.#applyToTarget(stamped.toSku, stamped.token, stamped.qty);
		await this.#clearSource(sku, stamped.token);
		return true;
	}

	/** Step 0 as a read: refuse while any live hold still names the source. */
	async #refuseOnLiveHolds(fromSku: string): Promise<void> {
		const doc = await this.#inventory.get(fromSku);
		if (doc === null) return;
		const live = liveHoldCount(normalizeInventoryDoc(doc));
		if (live > 0) throw new SkuHeldStockError(fromSku, live);
	}

	/**
	 * The one atomic write of the carry: `onHand → 0` plus the intent, guarded on
	 * the source document's revision, with the live-hold refusal read from the same
	 * document. Returns the quantity in flight (`0` when there is nothing to move).
	 *
	 * A stamp already carrying THIS token is this same carry, retried or replayed:
	 * its quantity is returned and nothing is written. A stamp carrying ANOTHER
	 * token is an earlier carry that never finished — it is completed first, because
	 * two intents cannot share one document, and then this attempt is re-run.
	 */
	#stampSource(fromSku: string, toSku: string, token: string): Promise<number> {
		return withCasRetry(
			"skuTransferOut",
			async () => {
				const current = await this.#inventory.getVersioned(fromSku);
				// No document ⇒ nothing to carry. The target keeps the empty document the
				// claim just created, which is the row an always-attempt `seedOnHand`
				// would have created a moment later anyway.
				if (current === null) return casDone(0);
				const doc = normalizeInventoryDoc(current.value);

				const stamped = doc.transferOut;
				if (stamped?.token === token) return casDone(stamped.qty);
				if (stamped !== undefined) {
					await this.completePending(fromSku);
					return CAS_RETRY;
				}

				const live = liveHoldCount(doc);
				if (live > 0) throw new SkuHeldStockError(fromSku, live);
				if (doc.onHand === 0) return casDone(0);

				const written = await this.#inventory.compareAndSet(fromSku, current.revision, {
					...doc,
					onHand: 0,
					transferOut: { token, toSku, qty: doc.onHand },
				});
				return written.applied ? casDone(doc.onHand) : CAS_RETRY;
			},
			this.#retry,
		);
	}

	/** Add the carried units to the target, exactly once. Returns its new count. */
	#applyToTarget(toSku: string, token: string, qty: number): Promise<number> {
		return withCasRetry(
			"skuTransferIn",
			async () => {
				const current = await this.#inventory.getVersioned(toSku);
				// The target is claimed before any stamp exists, so an absent document here
				// can only mean it was removed out from under the carry. Create it holding
				// the units rather than dropping them on the floor.
				if (current === null) {
					const created = await this.#inventory.compareAndSet(toSku, null, {
						...newInventoryDoc(toSku, qty),
						appliedTransfers: [token],
					});
					return created.applied ? casDone(qty) : CAS_RETRY;
				}
				const doc = normalizeInventoryDoc(current.value);
				if (hasAppliedTransfer(doc.appliedTransfers, token)) return casDone(doc.onHand);
				const onHand = doc.onHand + qty;
				const written = await this.#inventory.compareAndSet(toSku, current.revision, {
					...doc,
					onHand,
					appliedTransfers: pushAppliedTransfer(doc.appliedTransfers, token),
				});
				return written.applied ? casDone(onHand) : CAS_RETRY;
			},
			this.#retry,
		);
	}

	/** Drop the source's stamp once its units have landed. Guarded by the token. */
	async #clearSource(fromSku: string, token: string): Promise<void> {
		await withCasRetry(
			"skuTransferClear",
			async () => {
				const current = await this.#inventory.getVersioned(fromSku);
				if (current === null) return casDone(undefined);
				const doc = normalizeInventoryDoc(current.value);
				if (doc.transferOut?.token !== token) return casDone(undefined);
				const { transferOut: _done, ...rest } = doc;
				const written = await this.#inventory.compareAndSet(fromSku, current.revision, rest);
				return written.applied ? casDone(undefined) : CAS_RETRY;
			},
			this.#retry,
		);
	}

	/**
	 * Withdraw a target claim this call made and then refused to use.
	 *
	 * The ONLY document this ever removes is one it created moments ago that has
	 * never held a unit, never carried a hold, and can therefore be referenced by
	 * nothing — so "a stock document is never deleted" is intact: what is withdrawn
	 * is a claim, not a stock row. Anything else (units, holds, a ring, a stamp)
	 * means somebody else has taken the document over, and it is left alone.
	 * Best-effort: a failure here costs an empty document, never a wrong answer.
	 */
	async #withdrawPristineClaim(toSku: string): Promise<void> {
		try {
			const current = await this.#inventory.getVersioned(toSku);
			if (current === null) return;
			const doc = normalizeInventoryDoc(current.value);
			if (doc.onHand !== 0) return;
			if (Object.keys(doc.holds).length > 0) return;
			if (doc.appliedTransfers !== undefined || doc.appliedMovements !== undefined) return;
			if (doc.transferOut !== undefined) return;
			await this.#inventory.compareAndDelete(toSku, current.revision);
		} catch {
			// Deliberately swallowed: the refusal the caller is about to see is the
			// answer that matters, and an empty inventory document is not a wrong one.
		}
	}

	/**
	 * The carry's audit trail: one entry out of the source and one into the target.
	 *
	 * Each half is written independently and create-if-absent, so a squatted key
	 * costs that half of the trail and nothing else — never the rename, and never
	 * the other half.
	 */
	async #record(
		commandKey: string,
		token: string,
		fromSku: string,
		toSku: string,
		qty: number,
		resultOnHand: number,
	): Promise<void> {
		const createdAt = this.#clock.now().toISOString();
		await this.#recordOne(commandKey, "rename_out", fromSku, {
			kind: "rename",
			sku: fromSku,
			direction: "rename_out",
			qty,
			outcome: "ok",
			// The source is left empty, so its resulting count is 0.
			resultOnHand: 0,
			token,
			createdAt,
		});
		await this.#recordOne(commandKey, "rename_in", toSku, {
			kind: "rename",
			sku: toSku,
			direction: "rename_in",
			qty,
			outcome: "ok",
			resultOnHand,
			token,
			createdAt,
		});
	}

	async #recordOne(
		commandKey: string,
		direction: SkuRenameDirection,
		sku: string,
		entry: SkuRenameLedgerDoc,
	): Promise<void> {
		try {
			await this.#ledger.compareAndSet(skuRenameLedgerId(commandKey, direction, sku), null, entry);
		} catch {
			// See the docblock: the audit entry is the only thing a collision may cost.
		}
	}
}
