/**
 * The domain's `orderTimelineContract` against `EmdashOrderStore`, on both Node
 * dialects, in full — no staging and no todos.
 *
 * The timeline merges four kinds of history off documents rather than tables: the
 * state-change spine from the order document's own append-only `events[]`, the notes
 * from `InMemoryOrderNotesStore` (the notes adapter is INC-B8's), and the fulfillment,
 * cancellation and reconciliation artifacts from the fields the guarded flips wrote.
 * `countingIds` makes the same-instant `(at, id)` tie-break append order.
 */
import { orderTimelineContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, orderTimelineHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore timeline", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderTimelineContract(
		async () => orderTimelineHarness(makeOrderHarness(bound.storage, { countingIds: true })),
		{ dialect: ctx.dialect },
	);
});
