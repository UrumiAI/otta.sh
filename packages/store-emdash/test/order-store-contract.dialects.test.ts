/**
 * The domain's `orderStoreContract` against `EmdashOrderStore`, on both Node
 * dialects — **narrowed, not staged**: every case the document store can serve runs
 * for real, and the five the ratified orders-list search narrowing makes unservable
 * stay named todos. `test/order-store-contract-narrowed.ts` carries the copy and the
 * reason it still exists; INC-B4's evidence carries the case-by-case classification.
 *
 * What the cases prove through the document model rather than against a fake: the key
 * claim makes creation once-only, the replay returns the original order and
 * re-snapshots nothing, the frozen line and ship-to snapshots survive a reload, every
 * guarded flip (paid / failed / expired) is once-only with the deadline re-checked
 * inside the write, a reconciliation resolve is an equality-guarded compare-and-clear
 * a stale review cannot win, and the admin list pages, counts, filters and searches
 * off three denormalized indexed fields plus one derived by-sku index — one row per
 * order, with `countOrders` sharing the predicate exactly. Zero skips: SQLite always,
 * Postgres whenever the connection string is present (and a visibly skipped suite
 * naming the missing variable when it is not).
 */
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { orderStoreContractNarrowed } from "./order-store-contract-narrowed.js";
import { makeOrderHarness, orderStoreHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderStoreContractNarrowed(async () => orderStoreHarness(makeOrderHarness(bound.storage)), {
		dialect: ctx.dialect,
	});
});
