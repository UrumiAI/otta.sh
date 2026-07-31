import {
	addressBookContract,
	CountingIdGen,
	credentialVerifierContract,
	customerStoreContract,
	FixedClock,
	InMemoryAddressStore,
	InMemoryCredentialVerifier,
	InMemoryCustomerStore,
	InMemorySessionStore,
	sessionContract,
} from "@otta-sh/domain/testing";

// Step 5.4: lift the customer/address/session/verifier ports into the shared
// contract suites, run against their in-memory fakes first (Phase-0.3 precedent).

const TTL = 1000;
const MAX_ACTIVE_CHALLENGES = 3;

customerStoreContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		return { store: new InMemoryCustomerStore({ idGen: new CountingIdGen("cust"), clock }) };
	},
	{ dialect: "fake" },
);

addressBookContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		return { store: new InMemoryAddressStore({ idGen: new CountingIdGen("addr"), clock }) };
	},
	{ dialect: "fake" },
);

sessionContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		return {
			store: new InMemorySessionStore({ idGen: new CountingIdGen("sess"), clock, ttlMs: TTL }),
			advance: (ms: number) => clock.advance(ms),
			ttlMs: TTL,
		};
	},
	{ dialect: "fake" },
);

credentialVerifierContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const customerStore = new InMemoryCustomerStore({ idGen: new CountingIdGen("cust"), clock });
		const verifier = new InMemoryCredentialVerifier({
			customerStore,
			idGen: new CountingIdGen("chal"),
			clock,
			ttlMs: TTL,
			maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
		});
		return {
			verifier,
			customerStore,
			advance: (ms: number) => clock.advance(ms),
			now: () => clock.now().toISOString(),
			challengeTtlMs: TTL,
			maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
		};
	},
	{ dialect: "fake" },
);
