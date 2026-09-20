import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
	orderTransitionContract,
} from "@otta-sh/domain/testing";

// Step 5.4: lift the order state-machine + exactly-once-email spec into the
// shared contract suite, run against the in-memory fake first. (The pg/sqlite
// dialect runs now live in store-emdash's order-transition-contract.dialects.test.ts
// — @otta-sh/store-postgres is gone. The atomicity case moved with the store
// change: this document store has no transaction to roll back, so it is
// asserted instead in store-emdash's order-crash-seams.dialects.test.ts, which
// parks the single compare-and-set and reads the documents back.)

orderTransitionContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		return {
			store: new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock }),
			emailSender: new FakeEmailSender(),
			clock,
		};
	},
	{ dialect: "fake" },
);
