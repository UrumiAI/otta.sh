/**
 * `EntitlementStore` over one document per grant, with a pointer document per
 * authorization scope.
 *
 * The SQL was two statements: an `INSERT … ON CONFLICT (grant_idempotency_key)
 * DO NOTHING` followed by a read of that key, and a `SELECT` whose predicate is
 * `state = 'active' AND sku = ? AND (order_id = ?)? AND (lower(buyer_ref) = ?)?`
 * served by two composite indices. Here the key IS the document id, so grant-once
 * is the storage table's primary key; and the predicate becomes a conjunction over
 * four declared fields, with a keyed pointer in front of it on the single-scope
 * shapes the storefront actually takes.
 *
 * **Grant is two writes, and the order is the guarantee.** The grant document is
 * recorded first, because it carries the whole intent; the scope pointers are
 * written after it and are derived from it. A crash in between therefore leaves a
 * grant with no pointer, which under-serves nothing: the pointer is a cache, and
 * `check` falls through to the indexed query (ADR-0019's cross-cutting rule (b)),
 * answers correctly, and writes the pointer back. The reverse order would leave a
 * pointer naming a grant that does not exist — a dangling authorization a later
 * read would have to disbelieve.
 *
 * **Two scopes, so two pointers.** A grant carries both an order id and a buyer
 * reference, and `check` may arrive on either axis, so a grant points both
 * `order:{orderId}:{sku}` and `buyer:{foldedBuyerRef}:{sku}` at itself. Each is
 * create-if-absent: of N grants for one scope with DIFFERENT keys, the pointer
 * names whichever grant committed its pointer first, and that choice is not
 * load-bearing — a pointer whose grant is not active is ignored and re-pointed from
 * the query, so authorization is decided by the SET of grants rather than by which
 * one the cache happens to name.
 *
 * **The both-scopes shape skips the cache.** The port's third shape ANDs an order
 * id and a buyer reference (the operator-authenticated read), and that conjunction
 * is not a scope with a pointer of its own — a third key space for a read no hot
 * path takes. It goes straight to the indexed query, which is one read either way.
 *
 * **Revocation needs no pointer maintenance**, which is why there is no revoke
 * method here to keep in step: flipping a grant's `state` is enough, because every
 * pointer is re-validated against the grant it names on the read that uses it.
 */
import type {
	Clock,
	Entitlement,
	EntitlementQuery,
	EntitlementStore,
	GrantEntitlementInput,
	IdGen,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import {
	ENTITLEMENT_LOOKUPS_COLLECTION,
	ENTITLEMENTS_COLLECTION,
	entitlementLookupId,
	isActiveGrant,
	normalizeEntitlementDoc,
	toEntitlement,
	type EntitlementDoc,
	type EntitlementLookupDoc,
	type EntitlementScopeKind,
	type StoredEntitlementDoc,
} from "./entitlement-documents.js";
import { EntitlementScopeRequiredError } from "./entitlement-errors.js";
import { foldBuyerRef } from "./order-documents.js";
import type { StorageAccess, StorageCollection, WhereClause } from "./storage-access.js";

export interface EmdashEntitlementStoreOptions {
	/** The collections the descriptor declared (`ENTITLEMENT_COLLECTIONS`). */
	storage: StorageAccess;
	/** Mints the entitlement's own id. The document id is the grant key. */
	idGen: IdGen;
	/** Stamps `grantedAt` and the pointer's `pointedAt`. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
}

/** One authorization scope: which pointer it is, and how to filter for it. */
interface Scope {
	readonly kind: EntitlementScopeKind;
	/** The scope's key — an order id, or a folded buyer reference. */
	readonly key: string;
	/** The declared field that key is stored under. */
	readonly field: "orderId" | "buyerRefLower";
}

export class EmdashEntitlementStore implements EntitlementStore {
	readonly #grants: StorageCollection<StoredEntitlementDoc>;
	readonly #lookups: StorageCollection<EntitlementLookupDoc>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;

	constructor(options: EmdashEntitlementStoreOptions) {
		this.#grants = collectionOf<StoredEntitlementDoc>(options.storage, ENTITLEMENTS_COLLECTION);
		this.#lookups = collectionOf<EntitlementLookupDoc>(
			options.storage,
			ENTITLEMENT_LOOKUPS_COLLECTION,
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

	/**
	 * Grant-once under the grant-idempotency key, then point both scopes at it.
	 *
	 * A replay returns the RECORDED grant — the same entitlement id, and the fields
	 * as they were first written, even if this call's input differs — which is the
	 * SQL's behaviour too: its `ON CONFLICT DO NOTHING` was followed by a read of
	 * the key, not of the values it tried to insert. The pointer writes run on the
	 * replay as well, so a replay is also what completes a grant whose pointers were
	 * lost to a crash.
	 */
	async grant(input: GrantEntitlementInput): Promise<Entitlement> {
		const grantKey = input.grantIdempotencyKey;
		const doc = await this.#cas<EntitlementDoc>("grantEntitlement", async () => {
			const current = await this.#grants.getVersioned(grantKey);
			if (current !== null) return casDone(normalizeEntitlementDoc(current.value));
			const candidate: EntitlementDoc = {
				entitlementId: this.#idGen.newId(),
				orderId: input.orderId,
				productId: input.productId,
				sku: input.sku,
				buyerRef: input.buyerRef,
				buyerRefLower: foldBuyerRef(input.buyerRef),
				state: "active",
				source: input.source,
				grantedAt: this.#clock.now().toISOString(),
			};
			const written = await this.#grants.compareAndSet(grantKey, null, candidate);
			// A refused create-if-absent means a peer with the same key committed first.
			// Re-reading is the point: both callers must return the ONE recorded grant.
			return written.applied ? casDone(candidate) : CAS_RETRY;
		});

		for (const scope of scopesOf(doc)) {
			await this.#claimLookup(entitlementLookupId(scope.kind, scope.key, doc.sku), grantKey);
		}
		return toEntitlement(doc);
	}

	/**
	 * The delivery gate: true iff an `active` grant matches the scope and the sku.
	 *
	 * A scopeless query is refused with a typed error rather than answered `false` —
	 * see {@link EntitlementScopeRequiredError} for why the guard the SQL expressed
	 * as a short-circuit is loud here.
	 */
	async check(query: EntitlementQuery): Promise<boolean> {
		const scopes: Scope[] = [];
		if (query.orderId !== undefined) {
			scopes.push({ kind: "order", key: query.orderId, field: "orderId" });
		}
		if (query.buyerRef !== undefined) {
			scopes.push({ kind: "buyer", key: foldBuyerRef(query.buyerRef), field: "buyerRefLower" });
		}
		const [scope] = scopes;
		if (scope === undefined) throw new EntitlementScopeRequiredError(query.sku);

		const where: WhereClause = { sku: query.sku, state: "active" };
		for (const each of scopes) where[each.field] = each.key;

		// The operator-authenticated shape ANDs both scopes; it has no pointer of its
		// own (see the class docblock) and goes straight to the indexed query.
		if (scopes.length > 1) return (await this.#firstMatch(where)) !== undefined;

		const lookupId = entitlementLookupId(scope.kind, scope.key, query.sku);
		const pointer = await this.#lookups.get(lookupId);
		if (pointer !== null) {
			const named = await this.#grants.get(pointer.grantKey);
			if (named !== null) {
				const doc = normalizeEntitlementDoc(named);
				// The pointer is re-validated against the grant it names — a pointer that
				// disagrees about the scope or the sku authorizes nothing.
				if (isActiveGrant(doc) && doc.sku === query.sku && scopeKeyOf(doc, scope) === scope.key) {
					return true;
				}
			}
		}

		// No usable pointer: the declared index answers, and the answer is written back
		// so the next read is keyed again. This is the read that heals both a crash
		// between the grant and its pointers and a pointer left on a revoked grant.
		const found = await this.#firstMatch(where);
		if (found === undefined) return false;
		await this.#repointLookup(lookupId, found.id);
		return true;
	}

	/** The first grant matching `where`, as `{ id, data }` — `id` is its grant key. */
	async #firstMatch(
		where: WhereClause,
	): Promise<{ id: string; data: StoredEntitlementDoc } | undefined> {
		const page = await this.#grants.query({ where, limit: 1 });
		return page.items[0];
	}

	/**
	 * Point a scope at a grant, create-if-absent: an existing pointer is left alone,
	 * whatever it names.
	 *
	 * That is what makes the pointer for one scope deterministic under N grants with
	 * different keys — the first committer keeps it — and it is safe precisely
	 * because a pointer is not authority: `check` re-validates it and re-points it
	 * when it has gone stale.
	 */
	#claimLookup(lookupId: string, grantKey: string): Promise<void> {
		return this.#cas<void>("pointEntitlementScope", async () => {
			const current = await this.#lookups.getVersioned(lookupId);
			if (current !== null) return casDone(undefined);
			const written = await this.#lookups.compareAndSet(lookupId, null, {
				grantKey,
				pointedAt: this.#clock.now().toISOString(),
			});
			// A refusal means a peer pointed this scope first, which is the state this
			// call wanted to reach; re-reading on the next attempt settles it.
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/** Move a scope's pointer onto `grantKey`, replacing a stale one. */
	#repointLookup(lookupId: string, grantKey: string): Promise<void> {
		return this.#cas<void>("repointEntitlementScope", async () => {
			const current = await this.#lookups.getVersioned(lookupId);
			if (current !== null && current.value.grantKey === grantKey) return casDone(undefined);
			await this.#lookups.compareAndSet(lookupId, current?.revision ?? null, {
				grantKey,
				pointedAt: this.#clock.now().toISOString(),
			});
			// Applied or refused, this step is DONE: a refusal means a peer re-pointed the
			// same scope from the same query result, and the cache is correct either way.
			// Retrying would only re-run a decision that has already been made.
			return casDone(undefined);
		});
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}

/** The two scopes a grant satisfies. */
function scopesOf(doc: EntitlementDoc): readonly Scope[] {
	return [
		{ kind: "order", key: doc.orderId, field: "orderId" },
		{ kind: "buyer", key: doc.buyerRefLower, field: "buyerRefLower" },
	];
}

/** The grant's own value on a scope's axis. */
function scopeKeyOf(doc: EntitlementDoc, scope: Scope): string {
	return scope.field === "orderId" ? doc.orderId : doc.buyerRefLower;
}
