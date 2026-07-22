import {
	CountingIdGen,
	FixedClock,
	InMemoryOrderNotesStore,
	orderNotesStoreContract,
} from "@urumi/domain/testing";

// orderNotesStoreContract against the in-memory fake — the first adapter, proving
// the suite is real and the OrderNotesStore port shape is right before any DB
// (admin-UX Increment 0, TDD contract-first).
orderNotesStoreContract(
	() => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const store = new InMemoryOrderNotesStore({ idGen: new CountingIdGen("note"), clock });
		return Promise.resolve({
			store,
			tick: (ms) => clock.advance(ms),
		});
	},
	{ dialect: "fake" },
);
