/**
 * The domain's `refundOrderContract` against `EmdashOrderStore`, on both Node
 * dialects, in full — no staging and no todos.
 *
 * What it proves through the document model rather than a fake: the refund ceiling
 * `min(Σ captured, frozen total)` is arbitrated INSIDE the single compare-and-set
 * that appends the row, against that same document's `payments[]` and `refunds[]`;
 * the four-state capacity lifecycle (ADR-0019 R6) holds — `reserved`/`unverified`
 * hold capacity, `voided` releases it, a finalize is status-guarded and never
 * re-arbitrates; and the whole reserve-before-issue protocol reaches the store only
 * through `refund_keys/{key}`, which is the only handle its settle half has.
 *
 * `buildRefundSeed` is the domain's own adapter-agnostic seed (createFromCart →
 * markPaid → recordPayment), so the fake, both SQL dialects and this document store
 * seed identically. The lines it seeds are DIGITAL, so no inventory hold is involved
 * and the refund suite exercises the money path alone.
 *
 * Postgres additionally runs the races, in `refund-race.pg.test.ts` — SQLite
 * serializes writes globally, so it cannot race.
 */
import { buildRefundSeed, refundOrderContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore refunds", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	refundOrderContract(
		() => {
			// `countingIds` for the same reason the sibling suites and the SQL harness pass
			// it: deterministic, lexically increasing ids, so a same-instant `(at, id)`
			// tie-break is append order rather than uuid luck.
			const orderStore = makeOrderHarness(bound.storage, { countingIds: true }).store;
			return { orderStore, seedPaidOrder: buildRefundSeed(orderStore) };
		},
		{ dialect: ctx.dialect },
	);
});
