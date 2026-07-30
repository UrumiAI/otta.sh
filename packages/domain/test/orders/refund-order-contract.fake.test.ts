import {
	buildRefundSeed,
	CountingIdGen,
	FixedClock,
	InMemoryOrderStore,
	refundOrderContract,
} from "@otta-sh/domain/testing";

// The refunds spec (ADR-0008) against the in-memory OrderStore fake — the first
// adapter to pass it, before sqlite + pg. Money movement, so this runs the full
// ceiling / gateway-vs-manual / idempotency / full-refund-flip behavioral suite.
refundOrderContract(
	() => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
		return { orderStore, seedPaidOrder: buildRefundSeed(orderStore) };
	},
	{ dialect: "fake" },
);
