/**
 * The identity documents: the customer aggregate with its address book embedded,
 * the email-uniqueness claim, the hash-keyed session, the magic-link challenge
 * and the per-address throttle claim that replaces a count-then-insert race.
 *
 * The SQL adapter held this in four tables and no transaction at all: a
 * `customers.email` UNIQUE constraint, an `addresses` table with no foreign key
 * whose isolation was `WHERE id = ? AND customer_id = ?` on every write, a
 * `customer_sessions` table keyed by a UNIQUE `token_hash`, and a
 * `login_challenges` table with **no** constraint bounding rows per address. The
 * same guarantees are reassembled out of five documents:
 *
 * | Document | What it is |
 * |---|---|
 * | `customers/{customerId}` | the aggregate: identity fields plus the embedded `addresses` |
 * | `customer_emails/{emailLower}` | the email-uniqueness claim, and the fast path from an address to its account |
 * | `sessions/{tokenHash}` | one session, keyed by the hash of a token that is never stored |
 * | `login_challenges/{challengeId}` | one magic-link challenge; single-use via `consumedAt` |
 * | `login_challenge_claims/{emailLower}` | the per-address active-challenge slots — the throttle, as a claim |
 *
 * Three of those shapes carry the whole story, so they are worth stating plainly.
 *
 * **A customer document can exist without a customer.** `addresses` had no foreign
 * key, and the contract relies on it: an address book is written for a customer id
 * nobody registered. So `email` is what says whether an account was ever created —
 * `null` is the undeclared case, which `get`, `getByEmail` and `update` answer for
 * exactly as the missing row did, which a later `create` **adopts** rather than
 * collides with, and which is deleted along with its last address so an
 * address-only document leaves no litter. It is the device
 * `emdash-tax-rules-store.ts` uses for a rate whose class nobody declared, and for
 * the same reason: the port's own suite produces the shape.
 *
 * **The addresses are embedded, so the old `WHERE id AND customer_id` backstop
 * becomes an explicit ownership check.** A document id alone carries no owner, and
 * the two writes it guarded — `update` and `delete` — are a **security** invariant
 * rather than a convenience (ADR-0019 §7.17). Every address write therefore looks
 * the address up **inside the caller's own document** and answers `null`/`false`
 * when it is not there, so a foreign address id is a miss and can never be another
 * customer's row. There is no address collection to leak from.
 *
 * **The throttle stores SLOTS, not a count.** The SQL counted active challenges
 * and then inserted, in two statements, with nothing at the database level bounding
 * the result — a genuine race that let the per-address cap be exceeded. A count
 * here would inherit it. The set of `(challengeId, expiresAt)` pairs currently
 * holding a slot answers both questions from one document that every admission
 * compare-and-sets: the count is the length after expired slots are dropped, and
 * releasing is removing a key that may already be gone. So N concurrent requests
 * admit at most the cap — exactly, not approximately — and a release is idempotent
 * by construction.
 */
import type {
	Address,
	AddressKind,
	Customer,
	CustomerId,
	Email,
	SessionSummary,
} from "@otta-sh/domain";

/** Collection name: the customer aggregate, one document per customer id. */
export const CUSTOMERS_COLLECTION = "customers";
/** Collection name: the email-uniqueness claim, one document per folded email. */
export const CUSTOMER_EMAILS_COLLECTION = "customer_emails";
/** Collection name: one session per token HASH. The token itself is never stored. */
export const SESSIONS_COLLECTION = "sessions";
/** Collection name: one magic-link challenge per challenge id. */
export const LOGIN_CHALLENGES_COLLECTION = "login_challenges";
/** Collection name: the per-address active-challenge slots — the throttle claim. */
export const LOGIN_CHALLENGE_CLAIMS_COLLECTION = "login_challenge_claims";

/** One collection as the plugin descriptor declares it. */
export interface IdentityCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The five collections the identity stores own, with the indexes each must
 * declare. A declared index is a **read contract**, not a performance knob: a
 * `where`/`orderBy` on an undeclared field is a runtime `StorageQueryError`, so
 * this list and the descriptor's must not drift.
 *
 * - `customers` declares `emailLower` because the email claim is the fast path and
 *   **not** the definition of existence: when a claim does not resolve, the lookup
 *   falls back to a bounded query on this field and re-establishes it (ADR-0019's
 *   cross-cutting rule (b)). Nothing filters on the embedded addresses — every
 *   address method is given its owning customer id, so the document is reached by
 *   id and the address is found inside it.
 * - `customer_emails` declares its own doc id as a lookup index, exactly as
 *   `sku_owners` does — see that collection's declaration
 *   (`product-commerce-documents.ts`) for why it is a plain `indexes` entry,
 *   never `uniqueIndexes`: the host materializes a unique index as one
 *   physical, plugin-wide index with no per-collection `WHERE` clause, so a
 *   `uniqueIndexes` entry here would equally risk colliding with `customers`'
 *   own declared `emailLower` index above. The claim document and its
 *   create-if-absent write are the real enforcement.
 * - `sessions` declares `customerId` alone — the only filter the port asks for.
 *   The history's `createdAt DESC, id DESC` ordering is applied **in code** after a
 *   bounded paged read, so no ordering index is declared: a session's `id` is a
 *   random identifier whose sort order means nothing to a reader, and the pair has
 *   to be sorted together or the tiebreak is not a tiebreak.
 * - `login_challenges` declares `consumed` and `expiresAt`, which are the two arms
 *   of the prune. The filter algebra has no OR, so "consumed OR expired" is two
 *   queries, and `consumed` is a TEXT mirror because a boolean cannot be bound as
 *   a `where` value on the better-sqlite3 path (see `product-commerce-documents.ts`
 *   for the measurement behind that rule). `emailLower` is deliberately NOT
 *   declared: the throttle reads its own claim document, never a query over
 *   challenges, so an index here would be a read contract for a query nobody
 *   issues.
 * - `login_challenge_claims` is reached by document id alone and declares nothing.
 */
export const IDENTITY_COLLECTIONS: Readonly<Record<string, IdentityCollectionIndexDeclaration>> = {
	[CUSTOMERS_COLLECTION]: { indexes: ["emailLower"] },
	[CUSTOMER_EMAILS_COLLECTION]: { indexes: ["emailLower"] },
	[SESSIONS_COLLECTION]: { indexes: ["customerId"] },
	[LOGIN_CHALLENGES_COLLECTION]: { indexes: ["consumed", "expiresAt"] },
	[LOGIN_CHALLENGE_CLAIMS_COLLECTION]: {},
};

/**
 * The folded form of an email: the `customer_emails` document id and the indexed
 * `emailLower`.
 *
 * The domain's `Email` brand already lower-cases and trims, so this is normally
 * the identity function. It is applied anyway, at every boundary, because the fold
 * is what makes the claim document the uniqueness device: a single un-normalized
 * value reaching a claim id would let one address be claimed twice.
 */
export function foldEmail(value: string): string {
	return value.trim().toLowerCase();
}

/** One address, as embedded in its owner's document. The owner is the document. */
export interface AddressDoc {
	readonly addressId: string;
	readonly kind: AddressKind;
	readonly name: string;
	readonly line1: string;
	readonly line2: string | null;
	readonly city: string;
	readonly region: string | null;
	readonly postalCode: string;
	readonly country: string;
	/**
	 * A real boolean, unlike the SQL's portable `0`/`1`. Nothing filters on it —
	 * addresses are reached through their owner's document, never by a query — so
	 * the text-mirror rule that applies to every INDEXED flag in this package does
	 * not apply here.
	 */
	readonly isDefault: boolean;
	readonly createdAt: string;
}

/**
 * The customer aggregate, with the address book embedded.
 *
 * `email` is the discriminator between an account and an address-only document
 * (see the file header): `null` means no customer row was ever created under this
 * id, and every read answers for it exactly as the SQL answered for a row that was
 * never inserted.
 */
export interface CustomerDoc {
	readonly customerId: string;
	/** `null` for an address-only document — see {@link hasCustomerRow}. */
	readonly email: Email | null;
	/** The indexed fold of {@link CustomerDoc.email}; `null` with it. */
	readonly emailLower: string | null;
	readonly displayName: string | null;
	readonly emailVerifiedAt: string | null;
	/** `null` for an address-only document, which has no creation event. */
	readonly createdAt: string | null;
	readonly addresses: readonly AddressDoc[];
}

/** The email claim: which customer holds a folded email. Reached by id alone. */
export interface CustomerEmailDoc {
	readonly emailLower: string;
	readonly customerId: string;
	readonly claimedAt: string;
}

/** Whether an account exists under this document, as opposed to addresses alone. */
export function hasCustomerRow(doc: CustomerDoc): boolean {
	return doc.email !== null;
}

/** Fill in what an older or partial document may not carry. */
export function normalizeCustomerDoc(doc: CustomerDoc): CustomerDoc {
	const email = doc.email ?? null;
	return {
		...doc,
		email,
		// RE-DERIVED rather than trusted: the fold is a mirror of the email, and a
		// document written by any path that set one without the other would filter
		// under an address it does not hold.
		emailLower: email === null ? null : foldEmail(email),
		displayName: doc.displayName ?? null,
		emailVerifiedAt: doc.emailVerifiedAt ?? null,
		createdAt: doc.createdAt ?? null,
		addresses: sortAddresses(doc.addresses ?? []),
	};
}

/** An empty document for a customer id that only has addresses. */
export function newAddressOnlyDoc(customerId: string): CustomerDoc {
	return {
		customerId,
		email: null,
		emailLower: null,
		displayName: null,
		emailVerifiedAt: null,
		createdAt: null,
		addresses: [],
	};
}

/** `ORDER BY created_at, id` as the SQL read the address book, applied in code. */
export function sortAddresses(addresses: readonly AddressDoc[]): readonly AddressDoc[] {
	return addresses.toSorted((a, b) =>
		a.createdAt === b.createdAt
			? a.addressId.localeCompare(b.addressId)
			: a.createdAt.localeCompare(b.createdAt),
	);
}

/** The document with one address appended (and the book re-sorted). */
export function withAddress(doc: CustomerDoc, address: AddressDoc): CustomerDoc {
	return { ...doc, addresses: sortAddresses([...doc.addresses, address]) };
}

/** The document with one address replaced in place. */
export function withUpdatedAddress(doc: CustomerDoc, address: AddressDoc): CustomerDoc {
	return {
		...doc,
		addresses: sortAddresses(
			doc.addresses.map((existing) =>
				existing.addressId === address.addressId ? address : existing,
			),
		),
	};
}

/** The document with one address removed. */
export function withoutAddress(doc: CustomerDoc, addressId: string): CustomerDoc {
	return { ...doc, addresses: doc.addresses.filter((a) => a.addressId !== addressId) };
}

/** Find an address INSIDE its owner's document — the ownership check itself. */
export function findAddress(doc: CustomerDoc, addressId: string): AddressDoc | undefined {
	return doc.addresses.find((a) => a.addressId === addressId);
}

/** The port's customer, rebuilt from the document. Only valid for an account. */
export function toCustomer(doc: CustomerDoc): Customer {
	if (doc.email === null || doc.createdAt === null) {
		throw new Error(
			`customer document ${doc.customerId} has no account row — guard with hasCustomerRow`,
		);
	}
	return {
		id: doc.customerId as CustomerId,
		email: doc.email,
		displayName: doc.displayName,
		emailVerifiedAt: doc.emailVerifiedAt,
		createdAt: doc.createdAt,
	};
}

/** The port's address, rebuilt from the embedded document plus its owner. */
export function toAddress(customerId: string, doc: AddressDoc): Address {
	return {
		id: doc.addressId,
		customerId: customerId as CustomerId,
		kind: doc.kind,
		name: doc.name,
		line1: doc.line1,
		line2: doc.line2,
		city: doc.city,
		region: doc.region,
		postalCode: doc.postalCode,
		country: doc.country,
		isDefault: doc.isDefault,
		createdAt: doc.createdAt,
	};
}

/**
 * One session, keyed by the HASH of its token.
 *
 * The plaintext token is returned by `create` once and never written anywhere —
 * not to this document, not to a log, not to a test fixture. `sessionId` is a
 * separate random identifier precisely so the admin-facing
 * {@link SessionSummary} can carry an id without carrying credential material:
 * the document id is the hash, and the hash never leaves this collection.
 */
export interface SessionDoc {
	/** The port-facing id — NOT the document id, which is the token hash. */
	readonly sessionId: string;
	readonly customerId: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	/** Set when revoked; `null` while live (or merely expired). */
	readonly revokedAt: string | null;
}

/** Fill in what a partial document may not carry. */
export function normalizeSessionDoc(doc: SessionDoc): SessionDoc {
	return { ...doc, revokedAt: doc.revokedAt ?? null };
}

/**
 * The token-free history row. Exactly the four metadata fields the port names —
 * the document id (the hash) is not one of them, and neither is anything derived
 * from it.
 */
export function toSessionSummary(doc: SessionDoc): SessionSummary {
	return {
		id: doc.sessionId,
		createdAt: doc.createdAt,
		expiresAt: doc.expiresAt,
		revokedAt: doc.revokedAt,
	};
}

/** Whether a session document authenticates at `nowIso` — `validate`'s answer. */
export function isLiveSession(doc: SessionDoc, nowIso: string): boolean {
	return doc.revokedAt === null && doc.expiresAt > nowIso;
}

/** The newest-first history order the port documents: `createdAt DESC, id DESC`. */
export function sortSessionHistory(docs: readonly SessionDoc[]): readonly SessionDoc[] {
	return docs.toSorted((a, b) =>
		a.createdAt === b.createdAt
			? b.sessionId.localeCompare(a.sessionId)
			: b.createdAt.localeCompare(a.createdAt),
	);
}

/**
 * Whether a challenge has been consumed, as indexed TEXT.
 *
 * A boolean cannot be bound as a `where` value on the better-sqlite3 path, so the
 * filterable form of a flag in this package is a string mirror — the same pattern
 * as `publishKey` and `holdsUse`, not a third invention. `consumedAt` stays the
 * source of truth; the mirror is only how the prune's first arm reaches it.
 */
export type ChallengeConsumed = "yes" | "no";

/** The ONE derivation of the mirror from the timestamp, so the two cannot drift. */
export function consumedFor(consumedAt: string | null): ChallengeConsumed {
	return consumedAt === null ? "no" : "yes";
}

/**
 * One magic-link challenge. Single-use: the consume is a compare-and-set guarded
 * on the document's revision with `consumedAt` still absent, which is the exact
 * scope of the SQL's `SET consumed_at = :now WHERE id = :id AND consumed_at IS
 * NULL` (ADR-0019 §7.17).
 *
 * Only `tokenHash` is stored. The emailed token exists in one `issueChallenge`
 * return value and nowhere else.
 */
export interface ChallengeDoc {
	readonly challengeId: string;
	/** The address as branded, for the get-or-create on a successful verify. */
	readonly email: Email;
	/** The folded address — the throttle claim document this challenge holds a slot in. */
	readonly emailLower: string;
	readonly tokenHash: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly consumedAt: string | null;
	/** Indexed text mirror of `consumedAt !== null` — {@link consumedFor}. */
	readonly consumed: ChallengeConsumed;
}

/** Fill in what a partial document may not carry, and RE-DERIVE the mirror. */
export function normalizeChallengeDoc(doc: ChallengeDoc): ChallengeDoc {
	const consumedAt = doc.consumedAt ?? null;
	return { ...doc, consumedAt, consumed: consumedFor(consumedAt) };
}

/** One held throttle slot: which challenge holds it, and when it lapses by itself. */
export interface ChallengeSlot {
	readonly challengeId: string;
	readonly expiresAt: string;
}

/**
 * The per-address throttle, as the set of slots currently held.
 *
 * The document exists only while a slot is held, so the array is bounded by the
 * cap it enforces.
 */
export interface ChallengeThrottleDoc {
	readonly emailLower: string;
	readonly slots: readonly ChallengeSlot[];
}

/** Fill in what a partial document may not carry. */
export function normalizeThrottleDoc(doc: ChallengeThrottleDoc): ChallengeThrottleDoc {
	return { ...doc, slots: doc.slots ?? [] };
}

/**
 * The slots still holding the window at `nowIso` — the count the cap is compared
 * against.
 *
 * A slot lapses on its own challenge's expiry, which is what makes every residual
 * this design accepts self-healing: a slot whose challenge document was never
 * written, or whose release was lost to a crash, is dropped here once the
 * challenge it named could no longer have been redeemed. Until then it refuses a
 * request it could have admitted, which is the direction ADR-0019's rule (c)
 * requires.
 */
export function liveSlots(doc: ChallengeThrottleDoc, nowIso: string): readonly ChallengeSlot[] {
	return doc.slots.filter((slot) => slot.expiresAt > nowIso);
}
