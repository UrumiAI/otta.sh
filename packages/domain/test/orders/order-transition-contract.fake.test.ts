import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
	orderTransitionContract,
} from "@otta-sh/domain/testing";

// Step 5.4: lift the order state-machine + exactly-once-email spec into the
// shared contract suite, run against the in-memory fake first. (The pg/sqlite
// dialect runs, incl. the atomicity case, live in @otta-sh/store-postgres.)

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
