import {
	CountingIdGen,
	FixedClock,
	InMemoryOrderNotesStore,
	InMemoryOrderStore,
	orderTimelineContract,
} from "@otta-sh/domain/testing";

// The order timeline / audit spec (admin-UX Increment 1, timeline slice) run
// against the in-memory fake first. The pg/sqlite dialect runs — incl. the
// Postgres-required exactly-one-event-under-race cases — live in
// @otta-sh/store-postgres.

orderTimelineContract(
	async () => {
		// Both stores share ONE clock + idGen so the fake models the single-db
		// adapter (events and notes interleave on one timeline).
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const idGen = new CountingIdGen("oi");
		return {
			orderStore: new InMemoryOrderStore({ idGen, clock }),
			orderNotesStore: new InMemoryOrderNotesStore({ idGen, clock }),
			tick: (ms: number) => clock.advance(ms),
		};
	},
	{ dialect: "fake" },
);
