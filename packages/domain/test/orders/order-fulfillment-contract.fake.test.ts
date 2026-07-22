import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
	orderFulfillmentContract,
} from "@urumi/domain/testing";

// The order-fulfillment spec (admin-UX Increment 1) run against the in-memory
// fake first. The pg/sqlite dialect runs — incl. the concurrent record + the
// record-vs-cancel race — live in @urumi/store-postgres.

orderFulfillmentContract(
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
