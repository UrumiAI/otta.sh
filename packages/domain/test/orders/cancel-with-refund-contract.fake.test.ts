import {
	cancelWithRefundContract,
	CountingIdGen,
	FixedClock,
	InMemoryInventoryStore,
	InMemoryOrderStore,
} from "@otta-sh/domain/testing";

// Cancelling a paid order refunds and restocks it (QA T1-4) — the spec against the
// in-memory fakes first; store-emdash runs it on both dialects.
cancelWithRefundContract(
	() => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		return {
			orderStore: new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock }),
			inventoryStore: new InMemoryInventoryStore({ idGen: new CountingIdGen("inv"), clock }),
			clock,
		};
	},
	{ dialect: "fake" },
);
