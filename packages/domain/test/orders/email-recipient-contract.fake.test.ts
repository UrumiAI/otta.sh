import {
	CountingIdGen,
	emailRecipientContract,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
} from "@otta-sh/domain/testing";

// "The order's email recipient, or none" (ADR-0028 Decision 7) against the in-memory
// fake first; the SQLite/Postgres runs are store-emdash's
// email-recipient-contract.dialects.test.ts, and D1's d1/order-store-contract.d1.spec.ts.
emailRecipientContract(
	async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const store = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
		return {
			store,
			emailSender: new FakeEmailSender(),
			clock,
			outboxRows: async (orderId) => store.outboxRows(orderId),
		};
	},
	{ dialect: "fake" },
);
