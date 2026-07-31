import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
	orderCancellationContract,
} from "@otta-sh/domain/testing";

// The order-cancellation spec (admin-UX Increment 1, "cancel with reason") run
// against the in-memory fake first. The pg/sqlite dialect runs — incl. the
// concurrent-cancel and cancel-vs-recordFulfillment races — live in
// @otta-sh/store-postgres.

orderCancellationContract(
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
