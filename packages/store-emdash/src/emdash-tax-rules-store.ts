/**
 * `TaxRulesStore` over the EmDash plugin-storage primitives.
 *
 * ## What the SQL guaranteed, and what replaces it
 *
 * | The SQL | Here |
 * |---|---|
 * | `DELETE FROM tax_classes … WHERE NOT EXISTS (tax_rates)` | the same emptiness test, read from the document being deleted and committed with `compareAndDelete` at that revision — so a `createRate` landing in between makes the delete refuse and the retry answer `in_use_by_rates` |
 * | `tax_rates.id` PRIMARY KEY | `tax_rate_owners/{rateId}`, claimed create-if-absent |
 * | (no SQL equivalent — the SQL never had it) one rate per `(tax_class_id, zone_id)` | checked against the class document the embed is guarded on, so two racing creates for one slot cannot both land |
 * | `SELECT count(*) … WHERE tax_class_id = ?` | the size of the class document's own `rates` map |
 * | `UPDATE tax_rates SET … WHERE id = ? AND rate_bps = :expected` | the same expected-value comparison inside the class document's compare-and-set — on the EXACT rate (`ratePpm` when finer than a basis point, #425) |
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
 * `updateRate`'s guard is `expected` (rate and flag), VALUES rather than a version (the
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
 * next create of that id — but "does not hold it" is only proof of an orphan once
 * the create that wrote the claim is done (#462). A claim is written `pending` and
 * set `live` after its embed lands; an unbacked `pending` claim may be a create one
 * round trip from its embed, so another CLASS adopts it only once it is older than
 * {@link RATE_CLAIM_ABANDON_AFTER_MS} (the product store's sku-claim lease, same
 * reasoning). The SAME class may adopt it at once: both embeds then guard on that
 * one class document, so at most one lands. A claim with no `state` predates the
 * field and is read as live — so during a rolling deploy, an older build's claims
 * still allow the pre-#462 race for as long as that build serves writes.
 *
 * The 60 s lease is this file's own constant, not the customer store's exported
 * `CLAIM_ABANDON_AFTER_MS`: that one is the email claim's public option default,
 * and the product store keeps its own private copy the same way.
 */
import {
	appliedTaxRate,
	normalizeTaxRateValue,
	ratePpmOf,
	TaxRateDuplicateError,
	type Clock,
	type CreateTaxClassInput,
	type CreateTaxRateInput,
	type DeleteTaxClassStoreResult,
	type DeleteTaxRateResult,
	type TaxClass,
	type TaxClassId,
	type TaxRate,
	type TaxRateExpectation,
	type TaxRulesStore,
	type UpdateTaxClassInput,
	type UpdateTaxClassResult,
	type UpdateTaxRateInput,
	type UpdateTaxRateResult,
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

/**
 * How old an unbacked `pending` rate-id claim must be before a create in another
 * class may take it over — the same 60 s as the product store's
 * `CLAIM_ABANDON_AFTER_MS`, and for the same reason: the whole CAS retry budget is
 * well under two seconds, and the claim's `claimedAt` is re-stamped on every attempt.
 */
const RATE_CLAIM_ABANDON_AFTER_MS = 60_000;

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
	/** Override the pending rate-id claim lease (ms). Default {@link RATE_CLAIM_ABANDON_AFTER_MS}. */
	claimAbandonAfterMs?: number;
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
	readonly #claimAbandonAfterMs: number;

	constructor(options: EmdashTaxRulesStoreOptions) {
		this.#classes = collectionOf<TaxClassDoc>(options.storage, TAX_CLASSES_COLLECTION);
		this.#rateOwners = collectionOf<TaxRateOwnerDoc>(options.storage, TAX_RATE_OWNERS_COLLECTION);
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxListPages = options.maxListPages ?? MAX_LIST_PAGES;
		this.#claimAbandonAfterMs = options.claimAbandonAfterMs ?? RATE_CLAIM_ABANDON_AFTER_MS;
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
	 * missing foreign key allowed — with the claim RE-ASSERTED adjacent to the embed.
	 *
	 * The claim's revision is the owner token (the shipping store's header states the
	 * device in full): re-asserting at it immediately before the embed both proves
	 * the id is still ours and invalidates any release already in flight against the
	 * revision it read, which is what closes the interleaving that would otherwise
	 * leave a money-bearing rate embedded with no claim — a rate no admin could edit
	 * or delete.
	 *
	 * ONE RATE PER (class, zone). Every rate of a class lives in that class's one
	 * document, so the slot check reads the same document — at the same revision —
	 * that the embed is compare-and-set against. Two racing creates for one slot
	 * both read revision R; one embed lands, the other's compare-and-set at R
	 * refuses, its retry re-reads the document, finds the winner in the slot and
	 * throws {@link TaxRateDuplicateError}. A refused create gives its `pending` claim
	 * back with a compare-and-delete at the revision IT last wrote, so a same-id create
	 * that adopted the claim since (which moved the revision) keeps it.
	 *
	 * Once the embed lands the claim is set `live` (#462) — see {@link #settleClaim}.
	 */
	async createRate(input: CreateTaxRateInput): Promise<TaxRate> {
		// A rateBps that disagrees with ratePpm throws BEFORE the id is claimed (#425).
		const value = normalizeTaxRateValue(input);
		const claim = (state: "pending" | "live"): TaxRateOwnerDoc => ({
			rateId: input.id,
			taxClassId: input.taxClassId,
			claimedAt: this.#clock.now().toISOString(),
			state,
		});
		let claimRevision = await this.#claimRateId(input.id, input.taxClassId, claim("pending"));
		const rate: TaxRateDoc = {
			rateId: input.id,
			zoneId: input.zoneId,
			...value,
			appliesToShipping: input.appliesToShipping,
		};
		await this.#cas<void>("createTaxRate", async () => {
			// Re-asserted on EVERY attempt, with the revision carried forward from this
			// write's own result — which also re-stamps the lease.
			const reasserted = await this.#rateOwners.compareAndSet(
				input.id,
				claimRevision,
				claim("pending"),
			);
			if (!reasserted.applied) {
				const taken = await this.#rateOwners.get(input.id);
				throw new TaxRateIdCollisionError(input.id, taken?.taxClassId ?? "a concurrent create");
			}
			claimRevision = reasserted.revision;
			const held = await this.#heldClass(input.taxClassId);
			// A concurrent create of the SAME id landed here after this one claimed: the
			// id is live, so this is an id collision — never an embed over that rate (the
			// rates map is keyed by id).
			if (held?.doc.rates[input.id] !== undefined) {
				throw new TaxRateIdCollisionError(input.id, input.taxClassId);
			}
			const occupant =
				held === null
					? null
					: appliedTaxRate(
							ratesOf(held.doc).map((r) => toTaxRate(input.taxClassId, r)),
							input.taxClassId,
							input.zoneId,
						);
			if (occupant !== null) throw new TaxRateDuplicateError(occupant);
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
		}).catch(async (err: unknown) => {
			// No embed of this create landed — a duplicate refusal, or every embed
			// compare-and-set refused until the retries ran out — so its claim goes back.
			// Never on a crash or an unknown error: the embed may have landed.
			if (err instanceof TaxRateDuplicateError || err instanceof StorageContentionError) {
				try {
					await this.#rateOwners.compareAndDelete(input.id, claimRevision);
				} catch {
					// The refusal is the caller's answer; a pending claim left here is a
					// lease orphan like a crash's.
				}
			}
			throw err;
		});
		await this.#settleClaim(input.taxClassId, rate, claimRevision, () => claim("live"));
		return toTaxRate(input.taxClassId, rate);
	}

	/**
	 * The `(class, zone)` read. `createRate` now refuses a second rate for a slot,
	 * but duplicates written before that can survive; the one returned is the one
	 * that APPLIES (`appliedTaxRate`, the greatest id) — the rate the checkout
	 * charges, where this used to answer the lowest id.
	 */
	async getRate(taxClassId: TaxClassId, zoneId: string): Promise<TaxRate | null> {
		const doc = await this.#classes.get(taxClassId);
		if (doc === null) return null;
		const rates = ratesOf(normalizeTaxClassDoc(doc)).map((rate) => toTaxRate(taxClassId, rate));
		return appliedTaxRate(rates, taxClassId, zoneId);
	}

	/** Whether any class document holds a rate — the tax settings' upgrade rule. */
	async hasAnyRate(): Promise<boolean> {
		const docs = await this.#scanClasses("hasAnyRate");
		return docs.some((doc) => ratesOf(doc).length > 0);
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
	 * The money CAS (port doc, and this file's header): `expected` is
	 * compared on EVERY attempt, so a lost revision re-reads and re-decides rather
	 * than re-submitting a decision taken against a value that has moved.
	 */
	async updateRate(
		id: string,
		input: UpdateTaxRateInput,
		expected: TaxRateExpectation,
	): Promise<UpdateTaxRateResult> {
		const value = normalizeTaxRateValue(input);
		return this.#cas<UpdateTaxRateResult>("updateTaxRate", async () => {
			const found = await this.#findRate(id);
			if (found === null) {
				return casDone<UpdateTaxRateResult>({ ok: false, reason: "not_found" });
			}
			// The guard, re-evaluated against what this attempt just read.
			// Already exactly what was asked: an idempotent replay, nothing to write.
			// The rate is compared EXACTLY (`ratePpmOf`, #425): 8.875% is not 8.88%.
			const current = ratePpmOf(found.rate);
			if (
				current === ratePpmOf(value) &&
				found.rate.appliesToShipping === input.appliesToShipping
			) {
				return casDone<UpdateTaxRateResult>({
					ok: true,
					rate: toTaxRate(found.held.doc.taxClassId, found.rate),
				});
			}
			if (
				current !== ratePpmOf(expected) ||
				found.rate.appliesToShipping !== expected.appliesToShipping
			) {
				return casDone<UpdateTaxRateResult>({
					ok: false,
					reason: "stale",
					current: toTaxRate(found.held.doc.taxClassId, found.rate),
				});
			}
			// A stored `ratePpm` goes unless the new value carries one (canonical, #425).
			const { ratePpm: _old, ...kept } = found.rate;
			const next: TaxRateDoc = {
				...kept,
				...value,
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
	 * Follow the id claim to the class document that holds the rate — and, when the
	 * claim does not resolve, FIND the rate by a bounded scan and re-establish it.
	 *
	 * The claim is the fast path and the uniqueness device, deliberately not the
	 * definition of existence: a rate embedded while its claim is missing or points at
	 * the wrong class would otherwise be a live, money-bearing rate that the checkout
	 * reads and the admin can neither edit nor delete. Rediscovering it here makes
	 * that state self-healing rather than operator work — the scan is over a
	 * collection whose size is the merchant's tax-class count, it runs only where the
	 * claim did not resolve, and the claim written back is create-if-absent (or a
	 * re-point at the class that really holds the rate), so two concurrent healers
	 * cannot disagree.
	 *
	 * An id with no rate anywhere still answers `null`, as the missing row did.
	 *
	 * PORT-FACING CONSEQUENCE: every caller of this — `updateRate` and `deleteRate` —
	 * MAY WRITE (the claim, created or re-pointed) on what the SQL adapter served with
	 * a pure read, and MAY THROW {@link ScanPageLimitError} for an id that does not
	 * exist, where the SQL adapter answered `not_found` from one statement. The
	 * `(class, zone)` reads — `getRate`, `listRatesForZone`, `countRatesByClass` —
	 * never come through here and are unaffected, which is what keeps the checkout
	 * read free of it.
	 */
	async #findRate(rateId: string): Promise<{ held: HeldClass; rate: TaxRateDoc } | null> {
		const owner = await this.#rateOwners.get(rateId);
		if (owner !== null) {
			const held = await this.#heldClass(owner.taxClassId);
			const rate = held?.doc.rates[rateId];
			if (held !== null && rate !== undefined) return { held, rate };
		}
		return this.#healRateClaim(rateId);
	}

	/**
	 * The healing half of {@link #findRate}: scan for the rate, and re-establish its
	 * claim when a class is found holding it.
	 */
	async #healRateClaim(rateId: string): Promise<{ held: HeldClass; rate: TaxRateDoc } | null> {
		const docs = await this.#scanClasses("findRate");
		const holder = docs.find((doc) => doc.rates[rateId] !== undefined);
		if (holder === undefined) return null;
		const current = await this.#rateOwners.getVersioned(rateId);
		const mine: TaxRateOwnerDoc = {
			rateId,
			taxClassId: holder.taxClassId,
			claimedAt: this.#clock.now().toISOString(),
			state: "live",
		};
		// A refusal is somebody else having written the claim in the meantime, which is
		// the state this wanted to reach.
		if (current === null) await this.#rateOwners.compareAndSet(rateId, null, mine);
		else if (current.value.taxClassId !== holder.taxClassId) {
			await this.#rateOwners.compareAndSet(rateId, current.revision, mine);
		}
		const held = await this.#heldClass(holder.taxClassId);
		const rate = held?.doc.rates[rateId];
		if (held === null || rate === undefined) return null;
		return { held, rate };
	}

	/**
	 * Claim a rate id store-wide, taking over an ORPHANED claim (see the header): an
	 * unbacked live one, an unbacked pending one of this same class, or an unbacked
	 * pending one of another class once its lease has run out.
	 *
	 * Returns the claim's REVISION — the owner token `createRate` re-asserts at — and
	 * reports its attempt depth under its own operation name, so the claim step's
	 * contention and the embed step's stay two budgets rather than one number.
	 */
	async #claimRateId(rateId: string, taxClassId: string, mine: TaxRateOwnerDoc): Promise<string> {
		return this.#cas<string>("createTaxRate.claim", async () => {
			// Through the HEALING lookup, not the claim alone: a rate embedded while its
			// claim is missing must refuse this create, or one rate id would end up in two
			// class documents.
			const live = await this.#findRate(rateId);
			if (live !== null) throw new TaxRateIdCollisionError(rateId, live.held.doc.taxClassId);
			const current = await this.#rateOwners.getVersioned(rateId);
			if (current === null) {
				const written = await this.#rateOwners.compareAndSet(rateId, null, mine);
				return written.applied ? casDone(written.revision) : CAS_RETRY;
			}
			// Unbacked. A `pending` claim in ANOTHER class may be a create one round trip
			// from its embed, whose compare-and-set this create could not see (#462).
			if (
				current.value.state === "pending" &&
				current.value.taxClassId !== taxClassId &&
				!this.#leaseExpired(current.value)
			) {
				throw new TaxRateIdCollisionError(rateId, current.value.taxClassId);
			}
			// The lookup above ran BEFORE this read: a peer's embed and its live claim can
			// both land in between (#489), so "unbacked" is re-proved against the class
			// this claim names. Any later embed of the id re-asserts the claim first, which
			// moves the revision and refuses the compare-and-set below.
			const backer = await this.#heldClass(current.value.taxClassId);
			if (backer?.doc.rates[rateId] !== undefined) {
				throw new TaxRateIdCollisionError(rateId, current.value.taxClassId);
			}
			const written = await this.#rateOwners.compareAndSet(rateId, current.revision, mine);
			return written.applied ? casDone(written.revision) : CAS_RETRY;
		});
	}

	/**
	 * Set a create's claim `live` once its embed has landed (#462).
	 *
	 * The write is at the create's own revision. A refusal means someone wrote the
	 * claim since, and the re-read decides:
	 *  - it names THIS class: a same-class create adopted it (its embed then refuses
	 *    on ours), so the rate here is the one it backs — set it live at the current
	 *    revision, or a pending claim would outlive the rate and block other classes;
	 *  - it names ANOTHER class: this create paused past the whole lease between its
	 *    re-assertion and its embed, and a create in that class took the id over. The
	 *    rate just embedded here is taken back out and this create is refused, so the
	 *    id is never live in two classes;
	 *  - it is gone, or already live in this class: nothing to do (`#findRate` heals a
	 *    missing one).
	 *
	 * A STORAGE failure setting the claim live does not fail the create — the rate has
	 * landed, and a pending claim that names its class is followed by `#findRate` like
	 * a live one.
	 *
	 * STUCK PENDING: when that storage failure happens, the claim stays `pending`, and
	 * nothing sets it live later (`#findRate` heals only a missing or mis-pointed
	 * claim). While the rate exists nothing changes: a create in another class is
	 * refused this id by `#findRate`, which follows a pending claim like a live one.
	 * Once the rate is deleted, `#releaseRateClaim` keeps the pending claim (it reads
	 * as a create in flight), so a create of this id in ANOTHER class is refused
	 * (`TAX_RATE_ID_COLLISION`) until 60 s after its `claimedAt`, while a create in
	 * THIS class adopts it at once.
	 *
	 * The rollback re-reads the claim on EVERY attempt and stops, removing nothing, once
	 * it names this class again: either this create's rate was deleted and the id
	 * re-created here by someone else (that rate is not this create's to remove), or a
	 * later id lookup healed the claim back onto this create's own rate. This create is
	 * still refused in both cases; in the second its rate stays live and reachable, so a
	 * caller's retry is refused as a collision with it — nothing is lost and the id is
	 * never in two classes. It also removes `rates[id]` only while it is still exactly
	 * the document this create embedded.
	 *
	 * RESIDUAL: if the rollback itself fails (a storage error, or its retries run out),
	 * the caller gets that error and both rates may remain. That needs a pause past the
	 * whole lease AND a failing rollback; the next id-keyed edit or delete reaches only
	 * the class the claim names. A second RESIDUAL: a
	 * create paused past the lease, then crashing after its embed but before settle,
	 * can leave two classes holding the id.
	 */
	async #settleClaim(
		taxClassId: string,
		rate: TaxRateDoc,
		ownRevision: string,
		live: () => TaxRateOwnerDoc,
	): Promise<void> {
		const rateId = rate.rateId;
		let revision = ownRevision;
		let takenBy: string | null;
		try {
			takenBy = await this.#cas<string | null>("createTaxRate.live", async () => {
				const written = await this.#rateOwners.compareAndSet(rateId, revision, live());
				if (written.applied) return casDone<string | null>(null);
				const current = await this.#rateOwners.getVersioned(rateId);
				if (current === null) return casDone<string | null>(null);
				if (current.value.taxClassId !== taxClassId) {
					return casDone<string | null>(current.value.taxClassId);
				}
				if (current.value.state !== "pending") return casDone<string | null>(null);
				revision = current.revision;
				return CAS_RETRY;
			});
		} catch (err) {
			// No ids or values: the error's name is enough to find this line.
			console.warn(
				`[otta] tax rules: a created rate's id claim was not set live ` +
					`(${err instanceof Error ? err.name : "unknown error"}); the rate is stored and reachable`,
			);
			return;
		}
		if (takenBy === null) return;
		await this.#cas<void>("createTaxRate.rollback", async () => {
			const held = await this.#heldClass(taxClassId);
			const owner = await this.#rateOwners.get(rateId);
			if (owner?.taxClassId === taxClassId) return casDone(undefined);
			const embedded = held?.doc.rates[rateId];
			if (held === null || embedded === undefined || !sameRateDoc(embedded, rate)) {
				return casDone(undefined);
			}
			const next = withoutTaxRate(held.doc, rateId);
			const written =
				next.name === null && Object.keys(next.rates).length === 0
					? await this.#classes.compareAndDelete(taxClassId, held.revision)
					: await this.#classes.compareAndSet(taxClassId, held.revision, next);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
		throw new TaxRateIdCollisionError(rateId, takenBy);
	}

	/** Whether a pending claim is older than the lease, by this store's clock. */
	#leaseExpired(claim: TaxRateOwnerDoc): boolean {
		const age = this.#clock.now().getTime() - new Date(claim.claimedAt).getTime();
		return age >= this.#claimAbandonAfterMs;
	}

	/**
	 * Give a rate id back — never a LIVE rate's, and only ever after the rate has
	 * already left its class document.
	 *
	 * The ORDER is the guarantee, and it is the reverse of the create's: the un-embed
	 * is already committed, the claim is READ HERE (so the revision this release pins
	 * itself to was observed after the rate was gone), the claim must still name the
	 * class this call emptied, that class must not hold the rate again, and the
	 * `compareAndDelete` is at the revision from that read. The last condition is what
	 * pairs with `createRate`'s re-assertion: a peer that adopts the orphan bumps the
	 * revision immediately before its embed, so this release refuses instead of taking
	 * a live claim away.
	 */
	async #releaseRateClaim(rateId: string, expectedClassId: string): Promise<void> {
		const current = await this.#rateOwners.getVersioned(rateId);
		if (current === null || current.value.taxClassId !== expectedClassId) return;
		// A pending claim is a peer's create in flight (it adopted the id after the rate
		// left), not the claim of the rate this delete removed.
		if (current.value.state === "pending") return;
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

/** Whether two rate documents carry the same fields — key order aside. */
function sameRateDoc(a: TaxRateDoc, b: TaxRateDoc): boolean {
	return (
		a.rateId === b.rateId &&
		a.zoneId === b.zoneId &&
		a.rateBps === b.rateBps &&
		a.ratePpm === b.ratePpm &&
		a.appliesToShipping === b.appliesToShipping
	);
}
