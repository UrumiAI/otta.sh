/**
 * The domain's `orderTimelineContract` against `EmdashOrderStore`, on both Node
 * dialects — **staged** (see `test/order-contract-b2.ts`).
 *
 * The state-change spine is what this increment owns, and it is the whole of what
 * runs: an event is appended inside the guarded flip, a replayed flip appends
 * none, events never leak across orders, and the merged timeline (audit spine +
 * notes) is chronological with a deterministic same-instant order. The four cases
 * that reach for `recordFulfillment`, `cancelOrder` or the reconciliation pair are
 * todos naming INC-B3.
 *
 * The notes half comes from `InMemoryOrderNotesStore`: `OrderNotesStore` is its own
 * port with its own increment, and the timeline's merge is not an order-store
 * invariant. `countingIds` is on, so `(at, id)` IS append order under the fixed
 * clock — the tie-break the same-instant case pins.
 */
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { orderTimelineContractB2 } from "./order-contract-b2.js";
import { makeOrderHarness, orderTimelineHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore timeline", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderTimelineContractB2(
		async () => orderTimelineHarness(makeOrderHarness(bound.storage, { countingIds: true })),
		{ dialect: ctx.dialect },
	);
});
