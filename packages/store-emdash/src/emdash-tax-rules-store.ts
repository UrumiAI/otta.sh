/**
 * `TaxRulesStore` over the EmDash plugin-storage primitives.
 *
 * ## What the SQL guaranteed, and what replaces it
 *
 * | The SQL | Here |
 * |---|---|
 * | `DELETE FROM tax_classes … WHERE NOT EXISTS (tax_rates)` | the same emptiness test, read from the document being deleted and committed with `compareAndDelete` at that revision — so a `createRate` landing in between makes the delete refuse and the retry answer `in_use_by_rates` |
 * | `tax_rates.id` PRIMARY KEY | `tax_rate_owners/{rateId}`, claimed create-if-absent |
 * | `SELECT count(*) … WHERE tax_class_id = ?` | the size of the class document's own `rates` map |
 * | `UPDATE tax_rates SET … WHERE id = ? AND rate_bps = :expected` | the same expected-value comparison inside the class document's compare-and-set |
 * | `ORDER BY id` on `listRatesForZone` / `listClasses` | sorted in code — ordering needs a declared index, and this store declares none |
 *
 * ## A rate may exist without its class, and that is the SQL's own shape
 *
 * `tax_rates` had NO foreign key to `tax_classes`: the contract creates rates for
 * classes that were never declared, `countRatesByClass` counts them, and
 * `getRate`/`listRatesForZone` return them. So `tax_classes/{classId}` here is the
 * document that holds a class's RATES, and its `name` is what says whether a class
 * was ever declared. `name: null` is the undeclared case — `listClasses` skips it,
 * `updateClass` and `deleteClass` answer `not_found` for it (which is exactly what
 * the SQL's missing row produced), and `createClass` fills it in rather than
 * colliding.
 *
 * ## The money CAS
 *
 * `updateRate`'s guard is `expectedRateBps`, a VALUE rather than a version (the
 * port's documented ABA acceptance). Because the value lives in a document shared
 * with the class's other rates, a lost revision race is retried by RE-READING and
 * RE-COMPARING, never by re-submitting the decision: a caller that lost a real edit
 * race is told `stale` on its next attempt instead of overwriting the change it
 * should have seen. `test/rules-cas-race.pg.test.ts` drives exactly one winner out
 * of a crowd; `test/rules-crash-seams.dialects.test.ts` pins the retry-then-
 * re-verify rule deterministically by parking a peer write inside the window.
 *
 * ## The rate-id claim
 *
 * `updateRate` and `deleteRate` take a rate id with no class, so the claim document
 * is the only way to reach the class that holds it — and, with no physical unique
 * index in any tier, it is also what keeps one rate id from landing in two classes.
 * A claim whose class no longer holds the rate is ORPHANED and taken over by the
 * next create of that id.
 */
import {
	type Clock,
	type CreateTaxClassInput,
	type CreateTaxRateInput,
	type DeleteTaxClassStoreResult,
	type DeleteTaxRateResult,
	type TaxClass,
	type TaxClassId,
	type TaxRate,
	type TaxRulesStore,
	type UpdateTaxClassInput,
	type UpdateTaxClassResult,
	type UpdateTaxRateInput,
	type UpdateTaxRateResult,
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
	normalizeTaxClassDoc,
	ratesOf,
	TAX_CLASSES_COLLECTION,
	TAX_RATE_OWNERS_COLLECTION,
	toTaxClass,
	toTaxRate,
	withTaxRate,
	withoutTaxRate,
	type TaxClassDoc,
	type TaxRateDoc,
	type TaxRateOwnerDoc,
} from "./rules-documents.js";
import { TaxClassIdCollisionError, TaxRateIdCollisionError } from "./rules-errors.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const LIST_PAGE_SIZE = 100;

/** Page ceiling for the bounded class scans. Reaching it is a typed failure. */
const MAX_LIST_PAGES = 1000;

export interface EmdashTaxRulesStoreOptions {
	/** The collections the descriptor declared (`TAX_RULES_COLLECTIONS`). */
	storage: StorageAccess;
	/** Stamps `claimedAt` on a rate-id claim — the only timestamp this store writes. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for the bounded class scans. Default 1000. */
	maxListPages?: number;
}

/** One class document as read, with the revision the next write is guarded on. */
interface HeldClass {
	readonly doc: TaxClassDoc;
	readonly revision: string;
}

export class EmdashTaxRulesStore implements TaxRulesStore {
	readonly #classes: StorageCollection<TaxClassDoc>;
	readonly #rateOwners: StorageCollection<TaxRateOwnerDoc>;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxListPages: number;

	constructor(options: EmdashTaxRulesStoreOptions) {
		this.#classes = collectionOf<TaxClassDoc>(options.storage, TAX_CLASSES_COLLECTION);
		this.#rateOwners = collectionOf<TaxRateOwnerDoc>(
			options.storage,
			TAX_RATE_OWNERS_COLLECTION,
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

	// -- classes ---------------------------------------------------------------

	/**
	 * Declare a class. When rates already put a document there, this fills its
	 * `name` in rather than colliding — the document was never the class, it was
	 * the class's rates, and the SQL would have inserted the row happily.
	 */
	async createClass(input: CreateTaxClassInput): Promise<TaxClass> {
		await this.#cas<void>("createTaxClass", async () => {
			const held = await this.#heldClass(input.id);
			if (held === null) {
				const written = await this.#classes.compareAndSet(input.id, null, {
					taxClassId: input.id,
					name: input.name,
					rates: {},
				});
				return written.applied ? casDone(undefined) : CAS_RETRY;
			}
			if (held.doc.name !== null) throw new TaxClassIdCollisionError(input.id);
			const written = await this.#classes.compareAndSet(input.id, held.revision, {
				...held.doc,
				name: input.name,
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
		return { id: input.id, name: input.name };
	}

	/** Every DECLARED class, `ORDER BY id` as the SQL read it, sorted in code. */
	async listClasses(): Promise<TaxClass[]> {
		const docs = await this.#scanClasses("listClasses");
		return docs
			.toSorted((a, b) => (a.taxClassId < b.taxClassId ? -1 : 1))
			.map((doc) => toTaxClass(doc))
			.filter((entry): entry is TaxClass => entry !== null);
	}

	/**
	 * Own-grain delete-in-use guard (port doc), atomic without the SQL's `NOT
	 * EXISTS`: the rates are read from the document the delete is guarded on, so a
	 * concurrent `createRate` makes the `compareAndDelete` refuse and the retried
	 * attempt answers `in_use_by_rates`. A rate can never be orphaned onto a
	 * just-deleted class.
	 */
	async deleteClass(id: TaxClassId): Promise<DeleteTaxClassStoreResult> {
		return this.#cas<DeleteTaxClassStoreResult>("deleteTaxClass", async () => {
			const held = await this.#heldClass(id);
			if (held === null || held.doc.name === null) {
				return casDone<DeleteTaxClassStoreResult>({ ok: false, reason: "not_found" });
			}
			if (Object.keys(held.doc.rates).length > 0) {
				return casDone<DeleteTaxClassStoreResult>({ ok: false, reason: "in_use_by_rates" });
			}
			const removed = await this.#classes.compareAndDelete(id, held.revision);
			return removed.applied ? casDone<DeleteTaxClassStoreResult>({ ok: true }) : CAS_RETRY;
		});
	}

	/**
	 * LWW rename (port doc), as a read-modify-write: the class's rates share the
	 * document, so a blind put would drop a concurrently created rate. An
	 * undeclared class is `not_found` — a rename is not a create.
	 */
	async updateClass(id: TaxClassId, input: UpdateTaxClassInput): Promise<UpdateTaxClassResult> {
		return this.#cas<UpdateTaxClassResult>("updateTaxClass", async () => {
			const held = await this.#heldClass(id);
			if (held === null || held.doc.name === null) {
				return casDone<UpdateTaxClassResult>({ ok: false, reason: "not_found" });
			}
			const next: TaxClassDoc = { ...held.doc, name: input.name };
			const written = await this.#classes.compareAndSet(id, held.revision, next);
			return written.applied
				? casDone<UpdateTaxClassResult>({ ok: true, class: { id, name: input.name } })
				: CAS_RETRY;
		});
	}

	/** The in-use-by-rates refusal's honest count — the rates map's size. */
	async countRatesByClass(id: TaxClassId): Promise<number> {
		const doc = await this.#classes.get(id);
		return doc === null ? 0 : Object.keys(normalizeTaxClassDoc(doc).rates).length;
	}

	// -- rates -----------------------------------------------------------------

	/**
	 * Mint a rate: claim its id store-wide, then embed it in its class document —
	 * creating that document when the class was never declared, which is what the
	 * missing foreign key allowed.
	 */
	async createRate(input: CreateTaxRateInput): Promise<TaxRate> {
		const now = this.#clock.now().toISOString();
		await this.#claimRateId(input.id, input.taxClassId, now);
		const rate: TaxRateDoc = {
			rateId: input.id,
			zoneId: input.zoneId,
			rateBps: input.rateBps,
			appliesToShipping: input.appliesToShipping,
		};
		await this.#cas<void>("createTaxRate", async () => {
			const held = await this.#heldClass(input.taxClassId);
			if (held === null) {
				const written = await this.#classes.compareAndSet(input.taxClassId, null, {
					taxClassId: input.taxClassId,
					// No class was declared: the document exists to hold the rate, and
					// `listClasses` will not report it.
					name: null,
					rates: { [rate.rateId]: rate },
				});
				return written.applied ? casDone(undefined) : CAS_RETRY;
			}
			const written = await this.#classes.compareAndSet(
				input.taxClassId,
				held.revision,
				withTaxRate(held.doc, rate),
			);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
		return toTaxRate(input.taxClassId, rate);
	}

	/**
	 * The `(class, zone)` read. The SQL had no unique index on that pair, so more
	 * than one rate can match; the lowest rate id wins, which makes the answer
	 * deterministic where `SELECT … LIMIT 1` was not.
	 */
	async getRate(taxClassId: TaxClassId, zoneId: string): Promise<TaxRate | null> {
		const doc = await this.#classes.get(taxClassId);
		if (doc === null) return null;
		const match = ratesOf(normalizeTaxClassDoc(doc)).find((rate) => rate.zoneId === zoneId);
		return match === undefined ? null : toTaxRate(taxClassId, match);
	}

	/**
	 * The checkout read: every class's rate in one zone, `ORDER BY id` as the SQL
	 * read it. A bounded paged scan of the class documents, filtered and ordered in
	 * code — the collection declares no index, and a zone index would have to be
	 * maintained on an embedded child.
	 */
	async listRatesForZone(zoneId: string): Promise<TaxRate[]> {
		const docs = await this.#scanClasses("listRatesForZone");
		const found: TaxRate[] = [];
		for (const doc of docs) {
			for (const rate of ratesOf(doc)) {
				if (rate.zoneId === zoneId) found.push(toTaxRate(doc.taxClassId, rate));
			}
		}
		return found.toSorted((a, b) => (a.id < b.id ? -1 : 1));
	}

	/**
	 * The money CAS (port doc, and this file's header): `expectedRateBps` is
	 * compared on EVERY attempt, so a lost revision re-reads and re-decides rather
	 * than re-submitting a decision taken against a value that has moved.
	 */
	async updateRate(
		id: string,
		input: UpdateTaxRateInput,
		expectedRateBps: number,
	): Promise<UpdateTaxRateResult> {
		return this.#cas<UpdateTaxRateResult>("updateTaxRate", async () => {
			const found = await this.#findRate(id);
			if (found === null) {
				return casDone<UpdateTaxRateResult>({ ok: false, reason: "not_found" });
			}
			// The guard, re-evaluated against what this attempt just read.
			if (found.rate.rateBps !== expectedRateBps) {
				return casDone<UpdateTaxRateResult>({
					ok: false,
					reason: "stale",
					current: toTaxRate(found.held.doc.taxClassId, found.rate),
				});
			}
			const next: TaxRateDoc = {
				...found.rate,
				rateBps: input.rateBps,
				appliesToShipping: input.appliesToShipping,
			};
			const written = await this.#classes.compareAndSet(
				found.held.doc.taxClassId,
				found.held.revision,
				withTaxRate(found.held.doc, next),
			);
			return written.applied
				? casDone<UpdateTaxRateResult>({
						ok: true,
						rate: toTaxRate(found.held.doc.taxClassId, next),
					})
				: CAS_RETRY;
		});
	}

	/**
	 * Leaf delete (port doc). The rate leaves its class document FIRST and the id
	 * claim is released after: the other order would leave a rate that `getRate`
	 * still returns but no id-taking method could reach.
	 */
	async deleteRate(id: string): Promise<DeleteTaxRateResult> {
		type Removed = { result: DeleteTaxRateResult; taxClassId?: string };
		const outcome = await this.#cas<Removed>("deleteTaxRate", async () => {
			const found = await this.#findRate(id);
			if (found === null) return casDone<Removed>({ result: { ok: false, reason: "not_found" } });
			const taxClassId = found.held.doc.taxClassId;
			const next = withoutTaxRate(found.held.doc, id);
			// An undeclared class whose last rate is going is litter, not data: it goes
			// with the rate, in the same guarded write.
			const written =
				next.name === null && Object.keys(next.rates).length === 0
					? await this.#classes.compareAndDelete(taxClassId, found.held.revision)
					: await this.#classes.compareAndSet(taxClassId, found.held.revision, next);
			return written.applied ? casDone<Removed>({ result: { ok: true }, taxClassId }) : CAS_RETRY;
		});
		if (outcome.taxClassId !== undefined) await this.#releaseRateClaim(id, outcome.taxClassId);
		return outcome.result;
	}

	// -- internals -------------------------------------------------------------

	#cas<T>(operation: string, step: (attempt: number) => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}

	async #heldClass(taxClassId: string): Promise<HeldClass | null> {
		const current = await this.#classes.getVersioned(taxClassId);
		return current === null
			? null
			: { doc: normalizeTaxClassDoc(current.value), revision: current.revision };
	}

	/**
	 * Follow the id claim to the class document that holds the rate. An unknown id
	 * and an ORPHANED claim both answer `null` — the same answer the SQL gave for a
	 * row that was never inserted.
	 */
	async #findRate(rateId: string): Promise<{ held: HeldClass; rate: TaxRateDoc } | null> {
		const owner = await this.#rateOwners.get(rateId);
		if (owner === null) return null;
		const held = await this.#heldClass(owner.taxClassId);
		const rate = held?.doc.rates[rateId];
		if (held === null || rate === undefined) return null;
		return { held, rate };
	}

	/** Claim a rate id store-wide, taking over an ORPHANED claim (see the header). */
	async #claimRateId(rateId: string, taxClassId: string, now: string): Promise<void> {
		const mine: TaxRateOwnerDoc = { rateId, taxClassId, claimedAt: now };
		return this.#cas<void>("createTaxRate", async () => {
			const current = await this.#rateOwners.getVersioned(rateId);
			if (current === null) {
				const written = await this.#rateOwners.compareAndSet(rateId, null, mine);
				return written.applied ? casDone(undefined) : CAS_RETRY;
			}
			const held = current.value;
			const holder = await this.#classes.get(held.taxClassId);
			if (holder !== null && normalizeTaxClassDoc(holder).rates[rateId] !== undefined) {
				throw new TaxRateIdCollisionError(rateId, held.taxClassId);
			}
			const written = await this.#rateOwners.compareAndSet(rateId, current.revision, mine);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * Give a rate id back, but only while the claim still names the class this call
	 * emptied and that class does not hold the id again — the guards that keep a
	 * release from taking a peer's freshly created rate out of reach.
	 */
	async #releaseRateClaim(rateId: string, expectedClassId: string): Promise<void> {
		const current = await this.#rateOwners.getVersioned(rateId);
		if (current === null || current.value.taxClassId !== expectedClassId) return;
		const holder = await this.#classes.get(current.value.taxClassId);
		if (holder !== null && normalizeTaxClassDoc(holder).rates[rateId] !== undefined) return;
		await this.#rateOwners.compareAndDelete(rateId, current.revision);
	}

	/** Every class document, paged, with the page ceiling as a typed failure. */
	async #scanClasses(operation: string): Promise<TaxClassDoc[]> {
		const collected: TaxClassDoc[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxListPages; page++) {
			const result = await this.#classes.query({ limit: LIST_PAGE_SIZE, cursor });
			for (const { data } of result.items) collected.push(normalizeTaxClassDoc(data));
			if (!result.hasMore || result.cursor === undefined) return collected;
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(operation, this.#maxListPages, collected.length, "maxListPages");
	}
}
