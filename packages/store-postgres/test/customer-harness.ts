import type {
	AddressBookHarness,
	CredentialVerifierHarness,
	CustomerStoreHarness,
	SessionHarness,
} from "@otta-sh/domain/testing";
import { CountingIdGen, FixedClock } from "@otta-sh/domain/testing";
import type { Kysely } from "kysely";
import {
	KyselyAddressStore,
	KyselyCredentialVerifier,
	KyselyCustomerStore,
	KyselySessionStore,
	makeSqliteDb,
	migrateToLatest,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

/** Short TTLs so the session/challenge expiry cases can cross them by advancing. */
const SESSION_TTL_MS = 1000;
const CHALLENGE_TTL_MS = 1000;
/** The per-email active-challenge cap under test (review round H1). */
const MAX_ACTIVE_CHALLENGES = 3;

const cleanups: Array<() => Promise<void>> = [];

export async function teardownCustomers(): Promise<void> {
	const fns = cleanups.splice(0);
	for (const fn of fns) await fn();
}

async function makeSqliteDbMigrated(): Promise<Kysely<Database>> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return db;
}

async function makePgDb(): Promise<Kysely<Database>> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return iso.db;
}

// -- CustomerStore -----------------------------------------------------------

function buildCustomerHarness(db: Kysely<Database>): CustomerStoreHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return { store: new KyselyCustomerStore({ db, idGen: new CountingIdGen("cust"), clock }) };
}

export async function makeSqliteCustomerHarness(): Promise<CustomerStoreHarness> {
	return buildCustomerHarness(await makeSqliteDbMigrated());
}
export async function makePgCustomerHarness(): Promise<CustomerStoreHarness> {
	return buildCustomerHarness(await makePgDb());
}

// -- AddressStore ------------------------------------------------------------

function buildAddressHarness(db: Kysely<Database>): AddressBookHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return { store: new KyselyAddressStore({ db, idGen: new CountingIdGen("addr"), clock }) };
}

export async function makeSqliteAddressHarness(): Promise<AddressBookHarness> {
	return buildAddressHarness(await makeSqliteDbMigrated());
}
export async function makePgAddressHarness(): Promise<AddressBookHarness> {
	return buildAddressHarness(await makePgDb());
}

// -- SessionStore ------------------------------------------------------------

function buildSessionHarness(db: Kysely<Database>): SessionHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return {
		store: new KyselySessionStore({
			db,
			idGen: new CountingIdGen("sess"),
			clock,
			ttlMs: SESSION_TTL_MS,
		}),
		advance: (ms) => clock.advance(ms),
		ttlMs: SESSION_TTL_MS,
	};
}

export async function makeSqliteSessionHarness(): Promise<SessionHarness> {
	return buildSessionHarness(await makeSqliteDbMigrated());
}
export async function makePgSessionHarness(): Promise<SessionHarness> {
	return buildSessionHarness(await makePgDb());
}

// -- CustomerCredentialVerifier ----------------------------------------------

function buildVerifierHarness(db: Kysely<Database>): CredentialVerifierHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const customerStore = new KyselyCustomerStore({ db, idGen: new CountingIdGen("cust"), clock });
	const verifier = new KyselyCredentialVerifier({
		db,
		customerStore,
		idGen: new CountingIdGen("chal"),
		clock,
		ttlMs: CHALLENGE_TTL_MS,
		maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
	});
	return {
		verifier,
		customerStore,
		advance: (ms) => clock.advance(ms),
		now: () => clock.now().toISOString(),
		challengeTtlMs: CHALLENGE_TTL_MS,
		maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
	};
}

export async function makeSqliteVerifierHarness(): Promise<CredentialVerifierHarness> {
	return buildVerifierHarness(await makeSqliteDbMigrated());
}
export async function makePgVerifierHarness(): Promise<CredentialVerifierHarness> {
	return buildVerifierHarness(await makePgDb());
}
