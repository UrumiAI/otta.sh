/**
 * `ShippingRulesStore` over the EmDash plugin-storage primitives.
 *
 * ## What the SQL guaranteed, and what replaces it
 *
 * Three tables, two foreign keys, two conditioned deletes and one money CAS:
 *
 * | The SQL | Here |
 * |---|---|
 * | `shipping_methods.zone_id` / `shipping_rates.method_id` foreign keys | the child IS part of the parent document, so a child with no parent is unrepresentable; a create naming a missing parent throws where the insert used to be refused |
 * | `DELETE FROM shipping_zones … WHERE NOT EXISTS (methods)` | the same emptiness test, read from the document being deleted, committed with `compareAndDelete` at the revision it was read at — so a concurrent `createMethod` makes the delete refuse and the retry reports `in_use_by_methods` |
 * | `DELETE FROM shipping_methods … WHERE NOT EXISTS (rates)` | the same, one level down, inside the zone document |
 * | `shipping_methods.id` PRIMARY KEY (store-wide) | `shipping_method_owners/{methodId}`, claimed create-if-absent |
 * | `shipping_rates` PRIMARY KEY `(method_id, currency)` | the method's `rates` map key — uniqueness inside one document is structural |
 * | `UPDATE shipping_rates SET … WHERE method_id = ? AND currency = ? AND amount_cents = :expected` | the same expected-value comparison, inside the zone document's compare-and-set |
 * | `ORDER BY id` on the two list reads | sorted in code, because ordering needs a declared index and this store declares none |
 *
 * ## The money CAS, and why a revision loss cannot become a silent clobber
 *
 * `updateRate` is the port's one guarded write, and the guard is a VALUE
 * (`expectedAmountCents`), not a version — the ABA acceptance the port documents.
 * Here the value lives in a document that also holds the zone's name, its other
 * methods and their rates, so two unrelated writes contend for one revision, and a
 * lost revision race must NOT be retried by re-submitting the decision:
 *
 * ```
 *   read the zone document + revision
 *   the method or the rate is gone        ─► not_found
 *   rate.amountCents !== expected         ─► stale, carrying the CURRENT rate
 *   compareAndSet(zone, revision, next)
 *        ├── applied ──────────────────────► ok
 *        └── refused (somebody else committed) ──► RE-READ and RE-COMPARE
 * ```
 *
 * The re-comparison is the whole point: the retried attempt runs the expected-value
 * check again against the value the winner left behind, so a loser of a real edit
 * race is reported `stale` on its second attempt rather than winning over a change
 * it should have seen. A retry that only re-submitted the write would turn the
 * package's contention budget into a lost tax… and a lost shipping fee, which is
 * money (CLAUDE.md). `test/rules-crash-seams.dialects.test.ts` parks a peer write
 * inside that window and asserts the outcome, and
 * `test/rules-cas-race.pg.test.ts` drives it with a real crowd.
 *
 * ## The method-id claim, and its three rules
 *
 * SEVEN port methods here take a method id with no zone (`getMethod`,
 * `updateMethod`, `deleteMethod`, `createRate`, `getRate`, `updateRate`,
 * `deleteRate`; the tax store adds two more of its own), so the claim document is
 * the fast way to reach the holding zone — and, because no declared index is a
 * physical unique index in any tier, it is also what keeps one method id from
 * landing in two zones.
 *
 * 1. **A create RE-ASSERTS the claim immediately before the embed**, at the
 *    revision the claim step returned, and again on every revision-loss retry. The
 *    revision is the owner token: a claim a peer has adopted or a deleter has
 *    released fails the re-assertion, so a method is never embedded under an id
 *    this call no longer holds, and a release already in flight against the older
 *    revision can no longer land.
 * 2. **A delete releases the claim only AFTER the method has left its zone**,
 *    pinned to a revision read after that write, only while the claim still names
 *    the zone it emptied, and only while that zone does not hold the method again.
 * 3. **The claim is not the definition of existence.** `getMethod` and the rate
 *    methods fall back to a bounded scan when the claim does not resolve, and
 *    re-establish it — so a method that is embedded while its claim is missing (the
 *    crash between an embed and its re-assertion, or the narrow same-zone
 *    interleaving rule 1 cannot close) is rediscovered and made editable again
 *    rather than becoming an unreachable priced row. The create path's collision
 *    test goes through that same lookup, which is what stops the residue from
 *    becoming one id in two zones.
 */
import {
	type Cents,
	type CreateShippingMethodInput,
	type CreateShippingRateInput,
	type CreateShippingZoneInput,
	type Clock,
	type Currency,
	type DeleteShippingMethodResult,
	type DeleteShippingRateResult,
	type DeleteShippingZoneResult,
	type ShippingMethod,
	type ShippingRate,
	type ShippingRulesStore,
	type ShippingZone,
	type UpdateShippingMethodInput,
	type UpdateShippingMethodResult,
	type UpdateShippingRateInput,
	type UpdateShippingRateResult,
	type UpdateShippingZoneInput,
	type UpdateShippingZoneResult,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ScanPageLimitError } from "./errors.js";
import {
	methodsOf,
	newShippingRateDoc,
	normalizeZoneDoc,
	SHIPPING_METHOD_OWNERS_COLLECTION,
	SHIPPING_ZONES_COLLECTION,
	toShippingMethod,
	toShippingRate,
	toShippingZone,
	withMethod,
	withRate,
	withoutMethod,
	withoutRate,
	type ShippingMethodDoc,
	type ShippingMethodOwnerDoc,
	type ShippingZoneDoc,
} from "./rules-documents.js";
import {
	ShippingMethodIdCollisionError,
	ShippingMethodNotFoundError,
	ShippingRateExistsError,
	ShippingZoneIdCollisionError,
	ShippingZoneNotFoundError,
} from "./rules-errors.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const LIST_PAGE_SIZE = 100;

/**
 * Page ceiling for the zone scan. Reaching it is a typed
 * {@link ScanPageLimitError}, never a silently short list.
 */
const MAX_LIST_PAGES = 1000;

export interface EmdashShippingRulesStoreOptions {
	/** The collections the descriptor declared (`SHIPPING_RULES_COLLECTIONS`). */
	storage: StorageAccess;
	/** Stamps `claimedAt` on a method-id claim — the only timestamp this store writes. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for the bounded zone scan. Default 1000. */
	maxListPages?: number;
}

/** One zone document as read, with the revision the next write is guarded on. */
interface HeldZone {
	readonly doc: ShippingZoneDoc;
	readonly revision: string;
}

export class EmdashShippingRulesStore implements ShippingRulesStore {
	readonly #zones: StorageCollection<ShippingZoneDoc>;
	readonly #methodOwners: StorageCollection<ShippingMethodOwnerDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxListPages: number;

	constructor(options: EmdashShippingRulesStoreOptions) {
		this.#zones = collectionOf<ShippingZoneDoc>(options.storage, SHIPPING_ZONES_COLLECTION);
		this.#methodOwners = collectionOf<ShippingMethodOwnerDoc>(
			options.storage,
			SHIPPING_METHOD_OWNERS_COLLECTION,
		);
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxListPages = options.maxListPages ?? MAX_LIST_PAGES;
	}

	// -- zones -----------------------------------------------------------------

	async createZone(input: CreateShippingZoneInput): Promise<ShippingZone> {
		const doc: ShippingZoneDoc = {
			zoneId: input.id,
			name: input.name,
			regions: input.regions ?? null,
			methods: {},
		};
		// Create-if-absent: the document id is the primary key the SQL had.
		const written = await this.#zones.compareAndSet(input.id, null, doc);
		if (!written.applied) throw new ShippingZoneIdCollisionError(input.id);
		return toShippingZone(doc);
	}

	/**
	 * Every zone, `ORDER BY id` as the SQL read it — sorted in code, after a
	 * bounded paged scan. The collection declares no index, so no `orderBy` is
	 * askable of the host; the page ceiling is what keeps an unbounded collection
	 * from becoming an unbounded read.
	 */
	async listZones(): Promise<ShippingZone[]> {
		const docs = await this.#scanZones("listZones");
		return docs
			.toSorted((a, b) => (a.zoneId < b.zoneId ? -1 : 1))
			.map((doc) => toShippingZone(doc));
	}

	async getZone(zoneId: string): Promise<ShippingZone | null> {
		const doc = await this.#zones.get(zoneId);
		return doc === null ? null : toShippingZone(normalizeZoneDoc(doc));
	}

	/**
	 * LWW edit of the zone's structural config (port doc: no `stale` outcome), but
	 * written as a read-modify-write compare-and-set rather than a blind put — the
	 * methods and their rates live in the same document, and a blind put would
	 * delete a concurrently created method.
	 */
	async updateZone(
		zoneId: string,
		input: UpdateShippingZoneInput,
	): Promise<UpdateShippingZoneResult> {
		return this.#cas<UpdateShippingZoneResult>("updateShippingZone", async () => {
			const held = await this.#heldZone(zoneId);
			if (held === null) {
				return casDone<UpdateShippingZoneResult>({ ok: false, reason: "not_found" });
			}
			const next: ShippingZoneDoc = {
				...held.doc,
				name: input.name,
				regions: input.regions ?? null,
			};
			const written = await this.#zones.compareAndSet(zoneId, held.revision, next);
			return written.applied
				? casDone<UpdateShippingZoneResult>({ ok: true, zone: toShippingZone(next) })
				: CAS_RETRY;
		});
	}

	/**
	 * Forbid-if-children delete (port doc), kept ATOMIC without the SQL's `NOT
	 * EXISTS`: the emptiness test reads the very document the delete is guarded on,
	 * so a `createMethod` that lands in between changes the revision, the
	 * `compareAndDelete` refuses, and the retried attempt sees the method and
	 * answers `in_use_by_methods`. A method can never be orphaned onto a
	 * just-deleted zone.
	 */
	async deleteZone(zoneId: string): Promise<DeleteShippingZoneResult> {
		return this.#cas<DeleteShippingZoneResult>("deleteShippingZone", async () => {
			const held = await this.#heldZone(zoneId);
			if (held === null) {
				return casDone<DeleteShippingZoneResult>({ ok: false, reason: "not_found" });
			}
			if (Object.keys(held.doc.methods).length > 0) {
				return casDone<DeleteShippingZoneResult>({ ok: false, reason: "in_use_by_methods" });
			}
			const removed = await this.#zones.compareAndDelete(zoneId, held.revision);
			return removed.applied ? casDone<DeleteShippingZoneResult>({ ok: true }) : CAS_RETRY;
		});
	}

	// -- methods ---------------------------------------------------------------

	/**
	 * Mint a method: claim its id store-wide, then embed it in its zone — with the
	 * claim RE-ASSERTED adjacent to the embed.
	 *
	 * The claim comes FIRST, as every claim in this package does: a claim that
	 * outlives the embed is an orphan the next create takes over, whereas an embed
	 * that outlives its claim would be a method no id-taking method could reach by
	 * id. The re-assertion is what makes the second case unreachable in the
	 * interleaving that could otherwise produce it — a peer adopting the orphan
	 * while a deleter is mid-release — because the claim's revision is the owner
	 * token and re-asserting at it both PROVES the id is still ours and invalidates
	 * any release already in flight against the revision it read.
	 */
	async createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod> {
		const now = this.#clock.now().toISOString();
		let claimRevision = await this.#claimMethodId(input.id, input.zoneId, now);
		const method: ShippingMethodDoc = {
			methodId: input.id,
			name: input.name,
			type: input.type,
			rates: {},
		};
		const embedded = await this.#cas<"embedded" | "no_zone">("createShippingMethod", async () => {
			const held = await this.#heldZone(input.zoneId);
			if (held === null) return casDone<"embedded" | "no_zone">("no_zone");
			// Re-asserted on EVERY attempt, with the revision carried forward from this
			// write's own result: a claim a peer has adopted, or a deleter has released,
			// fails here — BEFORE a method could be embedded under an id this call no
			// longer holds.
			const reasserted = await this.#methodOwners.compareAndSet(input.id, claimRevision, {
				methodId: input.id,
				zoneId: input.zoneId,
				claimedAt: now,
			});
			if (!reasserted.applied) {
				const taken = await this.#methodOwners.get(input.id);
				throw new ShippingMethodIdCollisionError(input.id, taken?.zoneId ?? "a concurrent create");
			}
			claimRevision = reasserted.revision;
			const written = await this.#zones.compareAndSet(
				input.zoneId,
				held.revision,
				withMethod(held.doc, method),
			);
			return written.applied ? casDone<"embedded" | "no_zone">("embedded") : CAS_RETRY;
		});
		if (embedded === "no_zone") {
			// The zone the foreign key pointed at is not there. Give the id back before
			// throwing, or a retry with a real zone would collide with this call's own
			// abandoned claim.
			await this.#releaseMethodClaim(input.id, input.zoneId);
			throw new ShippingZoneNotFoundError(input.zoneId);
		}
		return toShippingMethod(input.zoneId, method);
	}

	async listMethods(zoneId: string): Promise<ShippingMethod[]> {
		const doc = await this.#zones.get(zoneId);
		if (doc === null) return [];
		const zone = normalizeZoneDoc(doc);
		return methodsOf(zone).map((method) => toShippingMethod(zone.zoneId, method));
	}

	async getMethod(methodId: string): Promise<ShippingMethod | null> {
		const found = await this.#findMethod(methodId);
		return found === null ? null : toShippingMethod(found.zone.doc.zoneId, found.method);
	}

	/** LWW edit (port doc), as a read-modify-write for `updateZone`'s reason. */
	async updateMethod(
		methodId: string,
		input: UpdateShippingMethodInput,
	): Promise<UpdateShippingMethodResult> {
		return this.#cas<UpdateShippingMethodResult>("updateShippingMethod", async () => {
			const found = await this.#findMethod(methodId);
			if (found === null) {
				return casDone<UpdateShippingMethodResult>({ ok: false, reason: "not_found" });
			}
			const next: ShippingMethodDoc = { ...found.method, name: input.name, type: input.type };
			const written = await this.#zones.compareAndSet(
				found.zone.doc.zoneId,
				found.zone.revision,
				withMethod(found.zone.doc, next),
			);
			return written.applied
				? casDone<UpdateShippingMethodResult>({
						ok: true,
						method: toShippingMethod(found.zone.doc.zoneId, next),
					})
				: CAS_RETRY;
		});
	}

	/**
	 * Forbid-if-children delete (port doc), atomic for `deleteZone`'s reason: the
	 * rates are read from the document the write is guarded on.
	 *
	 * The id claim is released AFTER the method is gone. A crash in between leaves
	 * an orphan claim, which no read is fooled by (`getMethod` follows it to a zone
	 * that no longer holds the method and answers `null`) and which the next create
	 * of that id takes over.
	 */
	async deleteMethod(methodId: string): Promise<DeleteShippingMethodResult> {
		type Removed = { result: DeleteShippingMethodResult; zoneId?: string };
		const outcome = await this.#cas<Removed>("deleteShippingMethod", async () => {
			const found = await this.#findMethod(methodId);
			if (found === null) {
				return casDone<Removed>({ result: { ok: false, reason: "not_found" } });
			}
			if (Object.keys(found.method.rates).length > 0) {
				return casDone<Removed>({ result: { ok: false, reason: "in_use_by_rates" } });
			}
			const zoneId = found.zone.doc.zoneId;
			const written = await this.#zones.compareAndSet(
				zoneId,
				found.zone.revision,
				withoutMethod(found.zone.doc, methodId),
			);
			return written.applied ? casDone<Removed>({ result: { ok: true }, zoneId }) : CAS_RETRY;
		});
		if (outcome.zoneId !== undefined) await this.#releaseMethodClaim(methodId, outcome.zoneId);
		return outcome.result;
	}

	// -- rates -----------------------------------------------------------------

	/**
	 * Create a rate inside its method. `(methodId, currency)` was the SQL's primary
	 * key, so a second create for the same pair is refused rather than silently
	 * overwriting a price somebody is charging.
	 */
	async createRate(input: CreateShippingRateInput): Promise<ShippingRate> {
		const doc = newShippingRateDoc(input);
		await this.#cas<void>("createShippingRate", async () => {
			const found = await this.#findMethod(input.methodId);
			if (found === null) throw new ShippingMethodNotFoundError(input.methodId);
			if (found.method.rates[input.currency] !== undefined) {
				throw new ShippingRateExistsError(input.methodId, input.currency);
			}
			const written = await this.#zones.compareAndSet(
				found.zone.doc.zoneId,
				found.zone.revision,
				withMethod(found.zone.doc, withRate(found.method, doc)),
			);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
		return toShippingRate(input.methodId, doc);
	}

	async getRate(methodId: string, currency: Currency): Promise<ShippingRate | null> {
		const found = await this.#findMethod(methodId);
		const rate = found?.method.rates[currency];
		return rate === undefined ? null : toShippingRate(methodId, rate);
	}

	/**
	 * The money CAS (port doc, and this file's header): `expectedAmountCents` is
	 * compared on EVERY attempt, so a revision loss re-reads and re-decides instead
	 * of re-submitting.
	 */
	async updateRate(
		methodId: string,
		currency: Currency,
		input: UpdateShippingRateInput,
		expectedAmountCents: Cents,
	): Promise<UpdateShippingRateResult> {
		return this.#cas<UpdateShippingRateResult>("updateShippingRate", async () => {
			const found = await this.#findMethod(methodId);
			const current = found?.method.rates[currency];
			if (found === null || current === undefined) {
				return casDone<UpdateShippingRateResult>({ ok: false, reason: "not_found" });
			}
			// The guard, re-evaluated against what this attempt just read. A loser of a
			// real race reaches here on its retry and is told `stale`.
			if (current.amountCents !== expectedAmountCents) {
				return casDone<UpdateShippingRateResult>({
					ok: false,
					reason: "stale",
					current: toShippingRate(methodId, current),
				});
			}
			const next = newShippingRateDoc({
				currency,
				amountCents: input.amountCents,
				minSubtotalCents: input.minSubtotalCents,
			});
			const written = await this.#zones.compareAndSet(
				found.zone.doc.zoneId,
				found.zone.revision,
				withMethod(found.zone.doc, withRate(found.method, next)),
			);
			return written.applied
				? casDone<UpdateShippingRateResult>({ ok: true, rate: toShippingRate(methodId, next) })
				: CAS_RETRY;
		});
	}

	/** Leaf delete (port doc). Unknown `(methodId, currency)` ⇒ `not_found` no-op. */
	async deleteRate(methodId: string, currency: Currency): Promise<DeleteShippingRateResult> {
		return this.#cas<DeleteShippingRateResult>("deleteShippingRate", async () => {
			const found = await this.#findMethod(methodId);
			if (found === null || found.method.rates[currency] === undefined) {
				return casDone<DeleteShippingRateResult>({ ok: false, reason: "not_found" });
			}
			const written = await this.#zones.compareAndSet(
				found.zone.doc.zoneId,
				found.zone.revision,
				withMethod(found.zone.doc, withoutRate(found.method, currency)),
			);
			return written.applied ? casDone<DeleteShippingRateResult>({ ok: true }) : CAS_RETRY;
		});
	}

	// -- internals -------------------------------------------------------------

	#cas<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}

	async #heldZone(zoneId: string): Promise<HeldZone | null> {
		const current = await this.#zones.getVersioned(zoneId);
		return current === null
			? null
			: { doc: normalizeZoneDoc(current.value), revision: current.revision };
	}

	/**
	 * Follow the id claim to the zone document that holds the method — and, when the
	 * claim does not resolve, FIND the method by a bounded scan and re-establish it.
	 *
	 * The claim is the fast path and the uniqueness device; it is deliberately NOT
	 * the definition of existence. A method that is embedded while its claim is
	 * missing or points at the wrong zone would otherwise be a method the lists
	 * return but no id-taking method can reach — an unreachable priced row, and the
	 * one residue this design could leave behind (a crash between an embed and its
	 * claim re-assertion, or a release that raced an adoption). Rediscovering it here
	 * makes that state self-healing instead of operator work: the scan is over a
	 * collection whose size is the merchant's zone count, it runs only on the path
	 * where the claim did not resolve, and the claim it writes back is create-if-absent
	 * (or a re-point at the zone that really holds the method), so two concurrent
	 * healers cannot disagree.
	 *
	 * An id with no method anywhere still answers `null`, which is the answer the SQL
	 * gave for a row that was never inserted.
	 */
	async #findMethod(
		methodId: string,
	): Promise<{ zone: HeldZone; method: ShippingMethodDoc } | null> {
		const owner = await this.#methodOwners.get(methodId);
		if (owner !== null) {
			const zone = await this.#heldZone(owner.zoneId);
			const method = zone?.doc.methods[methodId];
			if (zone !== null && method !== undefined) return { zone, method };
		}
		return this.#healMethodClaim(methodId);
	}

	/**
	 * The healing half of {@link #findMethod}: scan for the method, and re-establish
	 * its claim when one is found holding it.
	 */
	async #healMethodClaim(
		methodId: string,
	): Promise<{ zone: HeldZone; method: ShippingMethodDoc } | null> {
		const zones = await this.#scanZones("findMethod");
		const holder = zones.find((zone) => zone.methods[methodId] !== undefined);
		if (holder === undefined) return null;
		const current = await this.#methodOwners.getVersioned(methodId);
		const mine: ShippingMethodOwnerDoc = {
			methodId,
			zoneId: holder.zoneId,
			claimedAt: this.#clock.now().toISOString(),
		};
		// A refusal is somebody else having written the claim in the meantime, which is
		// the state this wanted to reach; the read below is what the caller gets either
		// way.
		if (current === null) await this.#methodOwners.compareAndSet(methodId, null, mine);
		else if (current.value.zoneId !== holder.zoneId) {
			await this.#methodOwners.compareAndSet(methodId, current.revision, mine);
		}
		const zone = await this.#heldZone(holder.zoneId);
		const method = zone?.doc.methods[methodId];
		if (zone === null || method === undefined) return null;
		return { zone, method };
	}

	/**
	 * Claim a method id store-wide, taking over an ORPHANED claim.
	 *
	 * A claim is orphaned when the zone it names does not hold the method — the
	 * crash-between-claim-and-embed state, and the state a `deleteMethod` that died
	 * before releasing leaves. Taking one over is what keeps an id from being
	 * stranded forever; a claim whose method really is embedded is a collision, and
	 * is the primary key the SQL enforced.
	 *
	 * Returns the claim's REVISION — the owner token `createMethod` re-asserts at.
	 * It reports its attempt depth under its own operation name, so the claim step's
	 * contention and the embed step's are two budgets rather than one number.
	 */
	async #claimMethodId(methodId: string, zoneId: string, now: string): Promise<string> {
		const mine: ShippingMethodOwnerDoc = { methodId, zoneId, claimedAt: now };
		return this.#cas<string>("createShippingMethod.claim", async () => {
			// The collision test goes through the HEALING lookup, not through the claim
			// alone: a method that is embedded while its claim is missing must refuse this
			// create, or the same id would end up embedded in two zones — the one way an
			// id claim could be worse than no claim at all.
			const live = await this.#findMethod(methodId);
			if (live !== null) throw new ShippingMethodIdCollisionError(methodId, live.zone.doc.zoneId);
			const current = await this.#methodOwners.getVersioned(methodId);
			if (current === null) {
				const written = await this.#methodOwners.compareAndSet(methodId, null, mine);
				return written.applied ? casDone(written.revision) : CAS_RETRY;
			}
			// Orphaned (the lookup above proved no method holds it). Re-point it at this
			// call's zone — a no-op when it already points there, which is the same-zone
			// replay of an abandoned create.
			const written = await this.#methodOwners.compareAndSet(methodId, current.revision, mine);
			return written.applied ? casDone(written.revision) : CAS_RETRY;
		});
	}

	/**
	 * Give a method id back — never a LIVE method's, and only ever after the method
	 * has already left its zone.
	 *
	 * The ORDER is the guarantee, and it is exactly the reverse of the create's:
	 *
	 * 1. the caller has already committed the un-embed (or never embedded at all),
	 * 2. the claim is read HERE, after that write, so the revision this release is
	 *    pinned to is one observed after the method was gone,
	 * 3. the claim must still name the zone this call worked on — a peer that adopted
	 *    it for another zone keeps it,
	 * 4. that zone must not hold the method again — a peer that re-created the same id
	 *    keeps its claim,
	 * 5. `compareAndDelete` at the revision from step 2 — so an adoption or a
	 *    re-assertion that happened after that read makes this release refuse rather
	 *    than take a live claim away.
	 *
	 * Step 5 is what pairs with `createMethod`'s re-assertion: a peer that adopts the
	 * orphan bumps the revision immediately before its embed, so this release can no
	 * longer land, and the interleaving that would leave a method embedded with no
	 * claim is closed. A refusal means a peer re-claimed the id, which is the state
	 * this call wanted to reach anyway.
	 */
	async #releaseMethodClaim(methodId: string, expectedZoneId: string): Promise<void> {
		const current = await this.#methodOwners.getVersioned(methodId);
		if (current === null || current.value.zoneId !== expectedZoneId) return;
		const holder = await this.#zones.get(current.value.zoneId);
		if (holder !== null && normalizeZoneDoc(holder).methods[methodId] !== undefined) return;
		await this.#methodOwners.compareAndDelete(methodId, current.revision);
	}

	/** Every zone document, paged, with the page ceiling as a typed failure. */
	async #scanZones(operation: string): Promise<ShippingZoneDoc[]> {
		const collected: ShippingZoneDoc[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#zones.query({ limit: LIST_PAGE_SIZE, cursor });
			for (const { data } of result.items) collected.push(normalizeZoneDoc(data));
			if (!result.hasMore || result.cursor === undefined) return collected;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxListPages, collected.length, "maxListPages");
	}
}
