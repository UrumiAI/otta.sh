/**
 * The wiring every identity suite shares: real stores over real plugin-storage
 * repositories, plus the test-surface hooks the domain's four identity harnesses
 * ask for.
 *
 * All four share ONE clock, because that is how the adapters are wired in
 * production and because the credential verifier's window and the customer's
 * `createdAt` have to move together for a seam test to mean anything.
 *
 * Nothing here seeds a document behind a store's back: every fixture goes through
 * the store, so a suite can never assert against a state the store does not
 * produce. And nothing here ever holds a plaintext token except the value a port
 * method returned to its caller — there is no fixture that writes one.
 */
import type {
	AddressBookHarness,
	CredentialVerifierHarness,
	CustomerStoreHarness,
	SessionHarness,
} from "@otta-sh/domain/testing";
import { CountingIdGen, FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	CUSTOMER_EMAILS_COLLECTION,
	CUSTOMERS_COLLECTION,
	EmdashAddressStore,
	EmdashCredentialVerifier,
	EmdashCustomerStore,
	EmdashSessionStore,
	LOGIN_CHALLENGE_CLAIMS_COLLECTION,
	LOGIN_CHALLENGES_COLLECTION,
	SESSIONS_COLLECTION,
	type ChallengeDoc,
	type ChallengeThrottleDoc,
	type CustomerDoc,
	type CustomerEmailDoc,
	type SessionDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";

/** The epoch every identity suite starts from. */
export const IDENTITY_EPOCH = new Date("2026-07-10T00:00:00.000Z");

/** Short TTLs so the expiry cases can cross them by advancing the clock. */
export const SESSION_TTL_MS = 1000;
export const CHALLENGE_TTL_MS = 1000;
/** The per-address active-challenge cap under test. */
export const MAX_ACTIVE_CHALLENGES = 3;

export interface IdentityHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Wrap the storage the STORES write through (fault injection). */
	storageForStore?: StorageAccess;
	/** Reuse another harness's clock, so a fault-injected twin shares its time. */
	clock?: FixedClock;
	/** Page ceiling for the email lookup's fallback query. */
	maxLookupPages?: number;
	/** Page ceiling for the session history read. */
	maxHistoryPages?: number;
	/** Page ceiling per prune arm. */
	maxPrunePages?: number;
}

/**
 * Everything the four identity stores expose to a suite.
 *
 * It deliberately does NOT implement the domain's four harness interfaces at once:
 * three of them name a field called `store` and mean a different port by it, so the
 * four views are built from this one bag by the adapters below.
 */
export interface IdentityHarness {
	readonly clock: FixedClock;
	readonly customerStore: EmdashCustomerStore;
	readonly addressStore: EmdashAddressStore;
	readonly sessionStore: EmdashSessionStore;
	readonly verifier: EmdashCredentialVerifier;
	/** The documents, for the assertions the ports cannot express. */
	readonly customers: StorageCollection<CustomerDoc>;
	readonly emailClaims: StorageCollection<CustomerEmailDoc>;
	readonly sessions: StorageCollection<SessionDoc>;
	readonly challenges: StorageCollection<ChallengeDoc>;
	readonly throttle: StorageCollection<ChallengeThrottleDoc>;
	/** The slots the throttle currently holds for an address, or null if none. */
	slotsOf(emailLower: string): Promise<readonly string[] | null>;
	/** Advance the one shared clock. */
	advance(ms: number): void;
	/** The shared clock's current instant (ISO-8601) — what the adapters see. */
	now(): string;
}

/** Build an identity harness over an already-bound `StorageAccess`. */
export function makeIdentityHarness(
	storage: StorageAccess,
	options: IdentityHarnessOptions = {},
): IdentityHarness {
	const clock = options.clock ?? new FixedClock(new Date(IDENTITY_EPOCH.getTime()));
	const written = options.storageForStore ?? storage;
	const shared = {
		storage: written,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
	};
	const customerStore = new EmdashCustomerStore({
		...shared,
		idGen: new CountingIdGen("cust"),
		maxLookupPages: options.maxLookupPages,
	});
	const addressStore = new EmdashAddressStore({
		...shared,
		idGen: new CountingIdGen("addr"),
	});
	const sessionStore = new EmdashSessionStore({
		...shared,
		idGen: new CountingIdGen("sess"),
		ttlMs: SESSION_TTL_MS,
		maxHistoryPages: options.maxHistoryPages,
	});
	const verifier = new EmdashCredentialVerifier({
		...shared,
		customerStore,
		idGen: new CountingIdGen("chal"),
		ttlMs: CHALLENGE_TTL_MS,
		maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
		maxPrunePages: options.maxPrunePages,
	});

	// The RAW collections, deliberately unwrapped by any fault injection: an
	// observation is not a write, and a test that injected a fault into its own
	// assertions would be reading a state the stores never produce.
	const customers = collectionOf<CustomerDoc>(storage, CUSTOMERS_COLLECTION);
	const emailClaims = collectionOf<CustomerEmailDoc>(storage, CUSTOMER_EMAILS_COLLECTION);
	const sessions = collectionOf<SessionDoc>(storage, SESSIONS_COLLECTION);
	const challenges = collectionOf<ChallengeDoc>(storage, LOGIN_CHALLENGES_COLLECTION);
	const throttle = collectionOf<ChallengeThrottleDoc>(storage, LOGIN_CHALLENGE_CLAIMS_COLLECTION);

	return {
		clock,
		customerStore,
		addressStore,
		sessionStore,
		verifier,
		customers,
		emailClaims,
		sessions,
		challenges,
		throttle,
		advance: (ms) => {
			clock.advance(ms);
		},
		now: () => clock.now().toISOString(),
		async slotsOf(emailLower) {
			const doc = await throttle.get(emailLower);
			return doc === null ? null : doc.slots.map((slot) => slot.challengeId);
		},
	};
}

/** The `customerStoreContract` view of the bag. */
export function makeCustomerHarness(
	storage: StorageAccess,
	options: IdentityHarnessOptions = {},
): CustomerStoreHarness {
	return { store: makeIdentityHarness(storage, options).customerStore };
}

/** The `addressBookContract` view of the bag. */
export function makeAddressHarness(
	storage: StorageAccess,
	options: IdentityHarnessOptions = {},
): AddressBookHarness {
	return { store: makeIdentityHarness(storage, options).addressStore };
}

/** The `sessionContract` view of the bag, with the TTL it was built with. */
export function makeSessionHarness(
	storage: StorageAccess,
	options: IdentityHarnessOptions = {},
): SessionHarness {
	const harness = makeIdentityHarness(storage, options);
	return {
		store: harness.sessionStore,
		advance: (ms) => {
			harness.advance(ms);
		},
		ttlMs: SESSION_TTL_MS,
	};
}

/** The `credentialVerifierContract` view of the bag. */
export function makeVerifierHarness(
	storage: StorageAccess,
	options: IdentityHarnessOptions = {},
): CredentialVerifierHarness {
	const harness = makeIdentityHarness(storage, options);
	return {
		verifier: harness.verifier,
		customerStore: harness.customerStore,
		advance: (ms) => {
			harness.advance(ms);
		},
		now: () => harness.now(),
		challengeTtlMs: CHALLENGE_TTL_MS,
		maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
	};
}
