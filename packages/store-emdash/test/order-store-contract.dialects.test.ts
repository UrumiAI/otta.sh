/**
 * The domain's `orderStoreContract` against `EmdashOrderStore`, on both Node
 * dialects — the DOMAIN suite itself, in full, with nothing copied and nothing
 * staged. The package held a narrowed copy for exactly as long as the port's
 * `search` guaranteed an unanchored `buyer_ref` SUBSTRING the document store's
 * filter algebra cannot express; the contract now guarantees the ratified anchored
 * PREFIX (ADR-0019 §6), which this store serves, so the copy and its drift guard
 * are gone and every case runs here for real.
 *
 * What the cases prove through the document model rather than against a fake: the key
 * claim makes creation once-only, the replay returns the original order and
 * re-snapshots nothing, the frozen line and ship-to snapshots survive a reload, every
 * guarded flip (paid / failed / expired) is once-only with the deadline re-checked
 * inside the write, a reconciliation resolve is an equality-guarded compare-and-clear
 * a stale review cannot win, and the admin list pages, counts, filters and searches
 * off three denormalized indexed fields plus one derived by-sku index — one row per
 * order, with `countOrders` sharing the predicate exactly. This store's search is a
 * PREFIX and nothing wider; that it finds nothing mid-string is its own statement,
 * pinned in `order-list-cases.ts` rather than in the domain contract, which fixes the
 * floor every adapter must reach and leaves an unanchored superset conformant. Zero
 * skips: SQLite always, Postgres whenever the connection string is present (and a
 * visibly skipped suite naming the missing variable when it is not).
 */
import { orderStoreContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, orderStoreHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderStoreContract(async () => orderStoreHarness(makeOrderHarness(bound.storage)), {
		dialect: ctx.dialect,
	});
});
