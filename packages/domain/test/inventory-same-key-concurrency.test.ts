import { idempotencyKey } from "@otta-sh/domain";
import { CountingIdGen, FixedClock, InMemoryInventoryStore } from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

function makeStore(onHand: number): InMemoryInventoryStore {
	return new InMemoryInventoryStore({
		idGen: new CountingIdGen("res"),
		clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		seed: [{ sku: "SKU-1", onHand }],
	});
}

/** Suspend the first finalizer until a second caller has also entered
 *  finalize observing `pending`, scripting the same-key race. */
function gateOnSecondEntrant(store: InMemoryInventoryStore): void {
	let entered = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	store.hooks.beforeFinalize = async () => {
		entered += 1;
		if (entered === 1) {
			await gate; // first caller waits for the second to arrive
		} else {
			release(); // second caller frees the first
		}
	};
}

// Step 0.5 same-key race, fake variant (deterministic ordering via the fake's
// `beforeFinalize` hook). The Postgres suite folds the same property into its
// concurrency loop as a real race.
describe("reserve — concurrent same idempotency key (fake, deterministic)", () => {
	test("concurrent reserve calls sharing the same idempotency key never return ok before the reservation reaches a terminal state", async () => {
		const store = makeStore(1);
		gateOnSecondEntrant(store);
		const key = idempotencyKey("k");

		const results = await Promise.all([
			store.reserve("SKU-1", 1, key),
			store.reserve("SKU-1", 1, key),
		]);

		// Both callers resolve to the *same* terminal outcome; stock is
		// decremented exactly once (never a premature ok before terminal).
		expect(results[0]).toEqual(results[1]);
		expect(results[0]?.ok).toBe(true);
		expect(store.onHand("SKU-1")).toBe(0);
	});

	test("concurrent same-key reserves at zero stock all resolve to OUT_OF_STOCK, never a premature ok", async () => {
		const store = makeStore(0);
		gateOnSecondEntrant(store);
		const key = idempotencyKey("k");

		const results = await Promise.all([
			store.reserve("SKU-1", 1, key),
			store.reserve("SKU-1", 1, key),
		]);

		expect(results[0]).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		expect(results[1]).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		expect(store.onHand("SKU-1")).toBe(0);
	});
});
