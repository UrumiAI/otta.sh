/**
 * The domain's `orderStoreContract` against `EmdashOrderStore`, on both Node
 * dialects — **staged**: 17 cases run for real (14 creation / replay / snapshot /
 * transition / expiry, plus the three guarded `resolveReconciliation` ones the refunds
 * increment added), and the 30 that need the lists, the search or the customer view
 * are registered as named todos. The staging, and why it is a copy rather than a
 * filter, is documented in `test/order-contract-b2.ts`; the methods behind the todos
 * throw `NotImplementedInIncrementError` naming the increment that owns them.
 *
 * What the cases that DO run prove through the document model rather than against
 * a fake: the key claim makes creation once-only, the replay returns the original
 * order and re-snapshots nothing, the frozen line and ship-to snapshots survive a
 * reload, every guarded flip (paid / failed / expired) is once-only with the
 * deadline re-checked inside the write, and a reconciliation resolve is an
 * equality-guarded compare-and-clear that a stale review cannot win. Zero skips: SQLite always, Postgres
 * whenever the connection string is present (and a visibly skipped suite naming
 * the missing variable when it is not).
 */
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { orderStoreContractB2 } from "./order-contract-b2.js";
import { makeOrderHarness, orderStoreHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderStoreContractB2(async () => orderStoreHarness(makeOrderHarness(bound.storage)), {
		dialect: ctx.dialect,
	});
});
