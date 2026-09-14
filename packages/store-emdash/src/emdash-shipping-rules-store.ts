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
 * ## The method-id claim
 *
 * Six port methods take a method id with no zone (`getMethod`, `updateMethod`,
 * `deleteMethod`, and the three rate methods), so the claim document is the only
 * way to reach the holding zone — and, because no declared index is a physical
 * unique index here, it is also the only thing that keeps one method id from
 * landing in two zones. A claim whose zone no longer holds the method is ORPHANED
 * and is taken over by the next create, so a crash between claiming an id and
 * embedding the method never strands the id.
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
	 * Mint a method: claim its id store-wide, then embed it in its zone.
	 *
	 * The claim comes FIRST, as every claim in this package does: a claim that
	 * outlives the embed is an orphan the next create takes over, whereas an embed
	 * that outlives its claim would be a method no id-taking method could reach.
	 */
	async createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod> {
		const now = this.#clock.now().toISOString();
		await this.#claimMethodId(input.id, input.zoneId, now);
		const method: ShippingMethodDoc = {
			methodId: input.id,
			name: input.name,
			type: input.type,
			rates: {},
		};
		const embedded = await this.#cas<"embedded" | "no_zone">("createShippingMethod", async () => {
			const held = await this.#heldZone(input.zoneId);
			if (held === null) return casDone<"embedded" | "no_zone">("no_zone");
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
	 * Follow the id claim to the zone document that holds the method.
	 *
	 * Returns `null` for an unknown id AND for an ORPHANED claim — a claim whose
	 * zone does not (or no longer) holds the method. That is the same answer the
	 * SQL gave for a row that was never inserted, which is what makes the crash
	 * between the claim and the embed invisible to every reader.
	 */
	async #findMethod(
		methodId: string,
	): Promise<{ zone: HeldZone; method: ShippingMethodDoc } | null> {
		const owner = await this.#methodOwners.get(methodId);
		if (owner === null) return null;
		const zone = await this.#heldZone(owner.zoneId);
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
	 */
	async #claimMethodId(methodId: string, zoneId: string, now: string): Promise<void> {
		const mine: ShippingMethodOwnerDoc = { methodId, zoneId, claimedAt: now };
		return this.#cas<void>("createShippingMethod", async () => {
			const current = await this.#methodOwners.getVersioned(methodId);
			if (current === null) {
				const written = await this.#methodOwners.compareAndSet(methodId, null, mine);
				return written.applied ? casDone(undefined) : CAS_RETRY;
			}
			const held = current.value;
			const holder = await this.#zones.get(held.zoneId);
			if (holder !== null && normalizeZoneDoc(holder).methods[methodId] !== undefined) {
				throw new ShippingMethodIdCollisionError(methodId, held.zoneId);
			}
			// Orphaned. Re-point it at this call's zone (a no-op when it already points
			// there, which is the same-zone replay of an abandoned create).
			const written = await this.#methodOwners.compareAndSet(methodId, current.revision, mine);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * Give a method id back, but only while it is still THIS zone's claim.
	 *
	 * Two things stop a release from taking a LIVE method's id away: the claim must
	 * still name the zone this call worked on, and that zone must not hold the
	 * method — the state a peer that re-created the id in the meantime would be in.
	 * The `compareAndDelete` at the revision just read closes the rest of the
	 * window, and a refusal means a peer re-claimed the id, which is exactly the
	 * state this call wanted to reach.
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
