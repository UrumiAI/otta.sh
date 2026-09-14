/**
 * `CustomerStore` and `AddressStore` over the plugin-storage primitives.
 *
 * One document holds both, because the address book is the customer aggregate's
 * own list and every port method that touches an address is already given its
 * owning customer id. That collapses the SQL's two tables into one, and with them
 * the two guards that mattered:
 *
 * - **`customers.email` UNIQUE** becomes `customer_emails/{emailLower}`, a
 *   create-if-absent claim naming the customer that holds the address. It is taken
 *   BEFORE any customer document is written, so a loser leaves no half-registered
 *   account behind; it is RE-ASSERTED immediately before the write it guards
 *   (ADR-0019's cross-cutting rule (a)) so a claim a peer has taken over cannot be
 *   written under; and it carries an ABANDON WINDOW (rule (d)), because a holder a
 *   moment from writing its account and a holder that crashed are the same document
 *   and only a lease tells them apart.
 * - **`WHERE id = :addressId AND customer_id = :customerId`** becomes an explicit
 *   ownership check inside the caller's own document (ADR-0019 §7.17). The
 *   document id of an address carries no owner — nothing does, once the addresses
 *   are embedded — so cross-customer isolation has to be written as a check rather
 *   than inherited from a key shape. It is checked on the read that feeds every
 *   write, in the same compare-and-set attempt as the write itself.
 *
 * **The claim is the fast path, not the definition of existence** (rule (b)). A
 * crash between claiming an address and writing the customer leaves an orphan
 * claim, and a crash the other way round — which the ordering above makes
 * unreachable for this store, but which a lost release could still produce — would
 * leave an account whose address nothing could look up. So `getByEmail` falls back
 * to a bounded query on the indexed `emailLower` and re-establishes the claim,
 * which makes that state self-healing rather than operator work. The cost is
 * asymmetric on purpose: a claim that resolves costs one extra document read, and
 * only a lookup that does NOT resolve pays for the query.
 */
import {
	DuplicateCustomerEmailError,
	type Address,
	type AddressStore,
	type Clock,
	type CreateAddressInput,
	type CreateCustomerInput,
	type Customer,
	type CustomerId,
	type CustomerStore,
	type Email,
	type IdGen,
	type UpdateAddressInput,
	type UpdateCustomerInput,
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
import { CustomerIdCollisionError } from "./identity-errors.js";
import {
	CUSTOMER_EMAILS_COLLECTION,
	CUSTOMERS_COLLECTION,
	findAddress,
	foldEmail,
	hasCustomerRow,
	newAddressOnlyDoc,
	normalizeCustomerDoc,
	toAddress,
	toCustomer,
	withAddress,
	withoutAddress,
	withUpdatedAddress,
	type AddressDoc,
	type CustomerDoc,
	type CustomerEmailDoc,
} from "./identity-documents.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const LOOKUP_PAGE_SIZE = 100;

/**
 * Page ceiling for the email lookup's fallback query. Reaching it is a typed
 * {@link ScanPageLimitError}, never a silently short answer — and it takes a
 * hundred accounts sharing one folded address to get near it, which is a state the
 * claim exists to make impossible.
 */
const MAX_LOOKUP_PAGES = 100;

/**
 * How long an email claim that no account holds is left alone before another
 * registration may take it over.
 *
 * It is the `sku_owners` abandon window, for the identical reason and justified
 * against the same retry budget: a write that retries at most `CAS_MAX_ATTEMPTS`
 * times with each sleep capped at 50 ms cannot legitimately hold a step for more
 * than about a second, so 60 seconds is two orders of magnitude of headroom over the
 * slowest honest holder — long enough that a registration in flight is never
 * mistaken for a dead one, short enough that a crashed one's address is usable again
 * without an operator. Overridable because a test needs to open the window
 * deterministically and an operator on a slower host may need to widen it.
 */
export const CLAIM_ABANDON_AFTER_MS = 60_000;

export interface EmdashCustomerStoreOptions {
	/** The collections the descriptor declared (`IDENTITY_COLLECTIONS`). */
	storage: StorageAccess;
	/** Mints customer ids. */
	idGen: IdGen;
	/** Stamps `createdAt` and the claim's `claimedAt`. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for the email lookup's fallback query. Default 100. */
	maxLookupPages?: number;
	/** Abandon window for an email claim. Defaults to {@link CLAIM_ABANDON_AFTER_MS}. */
	claimAbandonAfterMs?: number;
}

/** One customer document as read, with the revision the next write is guarded on. */
interface HeldCustomer {
	readonly doc: CustomerDoc;
	readonly revision: string;
}

/** The shared document access both identity stores are built on. */
class CustomerDocuments {
	readonly customers: StorageCollection<CustomerDoc>;
	readonly emails: StorageCollection<CustomerEmailDoc>;
	readonly clock: Clock;
	readonly retry: CasRetryOptions;
	readonly maxLookupPages: number;

	constructor(options: EmdashCustomerStoreOptions) {
		this.customers = collectionOf<CustomerDoc>(options.storage, CUSTOMERS_COLLECTION);
		this.emails = collectionOf<CustomerEmailDoc>(options.storage, CUSTOMER_EMAILS_COLLECTION);
		this.clock = options.clock;
		this.retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.maxLookupPages = options.maxLookupPages ?? MAX_LOOKUP_PAGES;
	}

	cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.retry);
	}

	/** The document with the revision every write on it is guarded on. */
	async held(customerId: string): Promise<HeldCustomer | null> {
		const current = await this.customers.getVersioned(customerId);
		return current === null
			? null
			: { doc: normalizeCustomerDoc(current.value), revision: current.revision };
	}

	/**
	 * Follow the email claim to the account that holds it — and, when the claim
	 * does not resolve, FIND the account by a bounded indexed query and
	 * re-establish it.
	 *
	 * An address that no document holds still answers `null`, which is the answer
	 * the SQL gave for a row that was never inserted.
	 */
	async findByEmail(emailLower: string): Promise<CustomerDoc | null> {
		const claim = await this.emails.get(emailLower);
		if (claim !== null) {
			const doc = await this.customers.get(claim.customerId);
			if (doc !== null) {
				const normalized = normalizeCustomerDoc(doc);
				if (hasCustomerRow(normalized) && normalized.emailLower === emailLower) return normalized;
			}
		}
		return this.healEmailClaim(emailLower);
	}

	/**
	 * The healing half of {@link findByEmail}: query the indexed fold for an
	 * account holding this address, and re-establish its claim when one is found.
	 *
	 * The query is what rule (b) requires and what the `emailLower` index is
	 * declared for. Its result is made deterministic by lowest customer id, so two
	 * concurrent healers that somehow see two accounts under one address agree on
	 * which one holds it rather than fighting over the claim.
	 */
	async healEmailClaim(emailLower: string): Promise<CustomerDoc | null> {
		const holders: CustomerDoc[] = [];
		let cursor: string | undefined;
		let exhausted = false;
		for (let page = 0; page < this.maxLookupPages; page++) {
			const result = await this.customers.query({
				where: { emailLower },
				limit: LOOKUP_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) {
				const doc = normalizeCustomerDoc(data);
				if (hasCustomerRow(doc)) holders.push(doc);
			}
			if (!result.hasMore || result.cursor === undefined) {
				exhausted = true;
				break;
			}
			cursor = result.cursor;
		}
		if (!exhausted) {
			throw new ScanPageLimitError(
				"getCustomerByEmail",
				this.maxLookupPages,
				holders.length,
				"maxLookupPages",
			);
		}
		const holder = holders.toSorted((a, b) => a.customerId.localeCompare(b.customerId))[0];
		if (holder === undefined) return null;
		const current = await this.emails.getVersioned(emailLower);
		const mine: CustomerEmailDoc = {
			emailLower,
			customerId: holder.customerId,
			claimedAt: this.clock.now().toISOString(),
		};
		// A refusal is somebody else having written the claim in the meantime, which is
		// the state this wanted to reach; the document returned below is the answer
		// either way.
		if (current === null) await this.emails.compareAndSet(emailLower, null, mine);
		else if (current.value.customerId !== holder.customerId) {
			await this.emails.compareAndSet(emailLower, current.revision, mine);
		}
		return holder;
	}
}

/**
 * `CustomerStore` over one document per customer, with the email claim as the
 * uniqueness device the UNIQUE constraint used to be.
 */
export class EmdashCustomerStore implements CustomerStore {
	readonly #docs: CustomerDocuments;
	readonly #idGen: IdGen;
	readonly #abandonAfterMs: number;

	constructor(options: EmdashCustomerStoreOptions) {
		this.#docs = new CustomerDocuments(options);
		this.#idGen = options.idGen;
		this.#abandonAfterMs = options.claimAbandonAfterMs ?? CLAIM_ABANDON_AFTER_MS;
	}

	/**
	 * Register an account: claim the address, then write the document — with the
	 * claim re-asserted adjacent to that write.
	 *
	 * The ORDER is the guarantee. A claim that outlives the document write is an
	 * orphan the next create takes over and the lookup heals; a document written
	 * before its claim would be an account whose address a peer could still claim,
	 * which is the one interleaving that would breach the uniqueness the SQL
	 * constraint gave for free. So of N concurrent registrations of one address
	 * exactly one reaches a customer write at all, and the losers throw
	 * `DuplicateCustomerEmailError` having written nothing.
	 */
	async create(input: CreateCustomerInput): Promise<Customer> {
		const now = this.#docs.clock.now().toISOString();
		const emailLower = foldEmail(input.email);
		const customerId = this.#idGen.newId();
		let claimRevision = await this.#claimEmail(input.email, emailLower, customerId, now);
		const mine: CustomerEmailDoc = { emailLower, customerId, claimedAt: now };
		let ownsClaim = true;
		try {
			return await this.#docs.cas<Customer>("createCustomer", async () => {
				// Re-asserted on EVERY attempt, with the revision carried forward from this
				// write's own result: a claim a peer has taken over fails HERE, before an
				// account could be written under an address this call no longer holds.
				const reasserted = await this.#docs.emails.compareAndSet(emailLower, claimRevision, mine);
				if (!reasserted.applied) {
					ownsClaim = false;
					throw new DuplicateCustomerEmailError(input.email);
				}
				claimRevision = reasserted.revision;
				const held = await this.#docs.held(customerId);
				// An existing document is the address-only shape the address book writes for
				// an id nobody registered (the missing foreign key). Adopt it — its
				// addresses are this customer's — rather than replacing it.
				if (held !== null && hasCustomerRow(held.doc)) {
					throw new CustomerIdCollisionError(customerId);
				}
				const doc: CustomerDoc = {
					customerId,
					email: input.email,
					emailLower,
					displayName: input.displayName ?? null,
					emailVerifiedAt: null,
					createdAt: now,
					addresses: held?.doc.addresses ?? [],
				};
				const written = await this.#docs.customers.compareAndSet(
					customerId,
					held?.revision ?? null,
					doc,
				);
				return written.applied ? casDone(toCustomer(doc)) : CAS_RETRY;
			});
		} catch (err) {
			// The account was not written, so the address must not stay claimed — a retry
			// with the same address would otherwise collide with this call's own
			// abandoned claim. Never released when a peer already owns it.
			if (ownsClaim) await this.#releaseEmailClaim(emailLower, customerId);
			throw err;
		}
	}

	async get(id: CustomerId): Promise<Customer | null> {
		const doc = await this.#docs.customers.get(id);
		if (doc === null) return null;
		const normalized = normalizeCustomerDoc(doc);
		// An address-only document is not an account: the SQL had no `customers` row
		// for it at all, and `get` answered `null`.
		return hasCustomerRow(normalized) ? toCustomer(normalized) : null;
	}

	/**
	 * PORT-FACING CONSEQUENCE of rule (b): this read MAY WRITE, and it may throw
	 * where the SQL adapter could only return `null`. When the claim does not
	 * resolve it queries the indexed fold and, on finding the account,
	 * re-establishes the claim — one claim write on a path the SQL never wrote on.
	 * And because that query is bounded, an address held by more accounts than the
	 * page ceiling allows raises {@link ScanPageLimitError} instead of answering.
	 * Both are the price of never leaving a registered account unreachable by its
	 * own address.
	 */
	async getByEmail(email: Email): Promise<Customer | null> {
		const doc = await this.#docs.findByEmail(foldEmail(email));
		return doc === null ? null : toCustomer(doc);
	}

	/**
	 * Patch the mutable identity fields. The address is NOT among them — the port
	 * has no email change — so this write never touches the claim.
	 */
	async update(id: CustomerId, patch: UpdateCustomerInput): Promise<Customer | null> {
		return this.#docs.cas<Customer | null>("updateCustomer", async () => {
			const held = await this.#docs.held(id);
			if (held === null || !hasCustomerRow(held.doc)) return casDone<Customer | null>(null);
			const next: CustomerDoc = {
				...held.doc,
				displayName: patch.displayName === undefined ? held.doc.displayName : patch.displayName,
				emailVerifiedAt:
					patch.emailVerifiedAt === undefined ? held.doc.emailVerifiedAt : patch.emailVerifiedAt,
			};
			const written = await this.#docs.customers.compareAndSet(id, held.revision, next);
			return written.applied ? casDone<Customer | null>(toCustomer(next)) : CAS_RETRY;
		});
	}

	/**
	 * Claim an address store-wide, taking over an ABANDONED claim.
	 *
	 * Three states, and the middle one is the whole reason this claim carries a
	 * timestamp:
	 *
	 * 1. **No claim, or this call's own claim.** Take it (the second case is this
	 *    step's own retry finding its own write).
	 * 2. **A claim no account holds, taken recently.** A registration is IN FLIGHT.
	 *    Refuse as a duplicate — which is what it is about to become — and write
	 *    nothing. This is the case that must NOT be treated as orphaned: "the holder
	 *    is a moment from writing its account" and "the holder is gone" are the same
	 *    document, and taking the claim from the first of those produces two accounts
	 *    on one address. Re-asserting the revision before the account write closes
	 *    the window down to two adjacent statements, but only the abandon window
	 *    keeps a live holder from being overtaken at all (ADR-0019's rules (a) and
	 *    (d): the owner's revision is the owner token, and the lease constant is an
	 *    operating parameter).
	 * 3. **A claim no account holds, older than {@link CLAIM_ABANDON_AFTER_MS}.** The
	 *    crash-between-claim-and-write state. Take it over, or the address would be
	 *    stranded forever.
	 *
	 * A claim whose account really exists is the UNIQUE violation, and is reported as
	 * the domain's own duplicate error so the login use-case's re-read still works
	 * unchanged. The existence test goes through the HEALING lookup rather than
	 * through the claim alone: an account that exists while its claim is missing must
	 * still refuse this create, or one address would end up on two accounts — the one
	 * way a claim could be worse than no claim at all.
	 *
	 * The refusal in case 2 is the accepted residual, and it points the safe way: an
	 * address is refused for at most one abandon window after a crash, rather than
	 * ever being registered twice.
	 */
	async #claimEmail(
		email: Email,
		emailLower: string,
		customerId: string,
		now: string,
	): Promise<string> {
		const mine: CustomerEmailDoc = { emailLower, customerId, claimedAt: now };
		return this.#docs.cas<string>("createCustomer.claim", async () => {
			const live = await this.#docs.findByEmail(emailLower);
			if (live !== null) throw new DuplicateCustomerEmailError(email);
			const current = await this.#docs.emails.getVersioned(emailLower);
			if (current !== null && current.value.customerId !== customerId) {
				const claimedAt = Date.parse(current.value.claimedAt);
				const age = this.#docs.clock.now().getTime() - claimedAt;
				// An unparseable timestamp counts as abandoned: no path in this store writes
				// one, and refusing forever would strand the address with no way back.
				if (!Number.isNaN(claimedAt) && age < this.#abandonAfterMs) {
					throw new DuplicateCustomerEmailError(email);
				}
			}
			const written = await this.#docs.emails.compareAndSet(
				emailLower,
				current?.revision ?? null,
				mine,
			);
			return written.applied ? casDone(written.revision) : CAS_RETRY;
		});
	}

	/**
	 * Give an address back — never a LIVE account's, and only ever after the
	 * account write has already failed to land.
	 *
	 * The ORDER is the guarantee, and it is exactly the reverse of the create's:
	 *
	 * 1. the caller has already established that no account was written,
	 * 2. the claim is read HERE, after that, so the revision this release is pinned
	 *    to is one observed after the failure,
	 * 3. the claim must still name this call's customer — a peer that took it over
	 *    keeps it,
	 * 4. no account may hold the address — a peer that registered it keeps its claim,
	 * 5. `compareAndDelete` at the revision from step 2, so a takeover that happened
	 *    after that read makes this release refuse rather than take a live claim away.
	 *
	 * Step 5 is what pairs with `create`'s re-assertion: a peer that adopts the
	 * orphan bumps the revision immediately before its own write, so this release can
	 * no longer land, and the interleaving that would leave an account with no claim
	 * is closed.
	 */
	async #releaseEmailClaim(emailLower: string, expectedCustomerId: string): Promise<void> {
		const current = await this.#docs.emails.getVersioned(emailLower);
		if (current === null || current.value.customerId !== expectedCustomerId) return;
		const holder = await this.#docs.customers.get(current.value.customerId);
		if (holder !== null) {
			const doc = normalizeCustomerDoc(holder);
			if (hasCustomerRow(doc) && doc.emailLower === emailLower) return;
		}
		await this.#docs.emails.compareAndDelete(emailLower, current.revision);
	}
}

/**
 * `AddressStore` over the addresses embedded in their owner's document.
 *
 * Every method is given the owning customer id and reaches the addresses through
 * it, so there is no collection an address can be read out of without its owner —
 * the isolation the port documents is structural here, and the ownership check the
 * SQL's `WHERE … AND customer_id` performed is written out explicitly on the two
 * writes it guarded.
 *
 * An address may be written for a customer id nobody registered, because
 * `addresses` had no foreign key and the port's own suite relies on it. Such a
 * document carries addresses and no account (`email: null`), is invisible to every
 * `CustomerStore` read, is ADOPTED by a later `create` for that id, and is deleted
 * along with its last address so it leaves no litter.
 */
export class EmdashAddressStore implements AddressStore {
	readonly #docs: CustomerDocuments;
	readonly #idGen: IdGen;

	constructor(options: EmdashCustomerStoreOptions) {
		this.#docs = new CustomerDocuments(options);
		this.#idGen = options.idGen;
	}

	/** `ORDER BY created_at, id` as the SQL read it, applied in code. */
	async list(customerId: CustomerId): Promise<Address[]> {
		const doc = await this.#docs.customers.get(customerId);
		if (doc === null) return [];
		const normalized = normalizeCustomerDoc(doc);
		return normalized.addresses.map((address) => toAddress(customerId, address));
	}

	async create(customerId: CustomerId, input: CreateAddressInput): Promise<Address> {
		const address: AddressDoc = {
			addressId: this.#idGen.newId(),
			kind: input.kind,
			name: input.name,
			line1: input.line1,
			line2: input.line2 ?? null,
			city: input.city,
			region: input.region ?? null,
			postalCode: input.postalCode,
			country: input.country,
			isDefault: input.isDefault === true,
			createdAt: this.#docs.clock.now().toISOString(),
		};
		return this.#docs.cas<Address>("createAddress", async () => {
			const held = await this.#docs.held(customerId);
			// No document yet: the address-only shape, created-if-absent so two
			// concurrent first addresses cannot each write an empty book over the other.
			const next =
				held === null
					? withAddress(newAddressOnlyDoc(customerId), address)
					: withAddress(held.doc, address);
			const written = await this.#docs.customers.compareAndSet(
				customerId,
				held?.revision ?? null,
				next,
			);
			return written.applied ? casDone(toAddress(customerId, address)) : CAS_RETRY;
		});
	}

	/**
	 * Patch one address — after proving it is in the CALLER's own document.
	 *
	 * That proof is the security invariant the SQL wrote as `WHERE id = :addressId
	 * AND customer_id = :customerId`, and it is taken on the read the write is
	 * guarded on, inside the same attempt, so a concurrent peer cannot move the
	 * address between the check and the write. A foreign or unknown address id is
	 * `null` — a miss, exactly as the port documents, never another customer's row.
	 */
	async update(
		customerId: CustomerId,
		addressId: string,
		patch: UpdateAddressInput,
	): Promise<Address | null> {
		return this.#docs.cas<Address | null>("updateAddress", async () => {
			const held = await this.#docs.held(customerId);
			if (held === null) return casDone<Address | null>(null);
			const existing = findAddress(held.doc, addressId);
			if (existing === undefined) return casDone<Address | null>(null);
			const next: AddressDoc = {
				...existing,
				kind: patch.kind ?? existing.kind,
				name: patch.name ?? existing.name,
				line1: patch.line1 ?? existing.line1,
				line2: patch.line2 === undefined ? existing.line2 : patch.line2,
				city: patch.city ?? existing.city,
				region: patch.region === undefined ? existing.region : patch.region,
				postalCode: patch.postalCode ?? existing.postalCode,
				country: patch.country ?? existing.country,
				isDefault: patch.isDefault ?? existing.isDefault,
			};
			const written = await this.#docs.customers.compareAndSet(
				customerId,
				held.revision,
				withUpdatedAddress(held.doc, next),
			);
			return written.applied ? casDone<Address | null>(toAddress(customerId, next)) : CAS_RETRY;
		});
	}

	/**
	 * Remove one address — after the same ownership proof as `update`. A foreign or
	 * unknown address id is `false`, never another customer's row removed.
	 *
	 * An address-only document that loses its last address is DELETED rather than
	 * left empty, so a customer id that was only ever an address book leaves no
	 * litter behind. A registered customer's document always stays.
	 */
	async delete(customerId: CustomerId, addressId: string): Promise<boolean> {
		return this.#docs.cas<boolean>("deleteAddress", async () => {
			const held = await this.#docs.held(customerId);
			if (held === null) return casDone(false);
			if (findAddress(held.doc, addressId) === undefined) return casDone(false);
			const next = withoutAddress(held.doc, addressId);
			if (next.addresses.length === 0 && !hasCustomerRow(next)) {
				const removed = await this.#docs.customers.compareAndDelete(customerId, held.revision);
				return removed.applied ? casDone(true) : CAS_RETRY;
			}
			const written = await this.#docs.customers.compareAndSet(customerId, held.revision, next);
			return written.applied ? casDone(true) : CAS_RETRY;
		});
	}
}
