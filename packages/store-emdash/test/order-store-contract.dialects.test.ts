/**
 * The domain's `orderStoreContract` against `EmdashOrderStore`, on both Node
 * dialects — **staged**: the 14 cases INC-B2 owns run for real, and the 33 that
 * need a method INC-B3 or INC-B4 owns are registered as named todos. The staging,
 * and why it is a copy rather than a filter, is documented in
 * `test/order-contract-b2.ts`; the methods behind the todos throw
 * `NotImplementedInIncrementError` naming the same increment.
 *
 * What the cases that DO run prove through the document model rather than against
 * a fake: the key claim makes creation once-only, the replay returns the original
 * order and re-snapshots nothing, the frozen line and ship-to snapshots survive a
 * reload, and every guarded flip (paid / failed / expired) is once-only with the
 * deadline re-checked inside the write. Zero skips: SQLite always, Postgres
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
