/**
 * The domain's `cartStoreContract` against `EmdashCartStore`, on both Node
 * dialects.
 *
 * The contract suite IS the spec: every case runs the real cart USE-CASES over a
 * real `EmdashCartStore` + `EmdashInventoryStore` on real plugin storage, so the
 * cart-layer guarantees — ledger-first replay, delta reserve / partial release,
 * lazy expiry, the checkout fence and its write-once order id — are proven through
 * the document model rather than against a fake. Zero skips: SQLite always,
 * Postgres whenever the connection string is present (and a visibly skipped suite
 * naming the missing variable when it is not).
 */
import { cartStoreContract } from "@otta-sh/domain/testing";
import { CART_LAYOUT } from "./cart-collections.js";
import { makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

describeEachDialect("EmdashCartStore", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);
	cartStoreContract(async () => makeCartHarness(bound.storage), { dialect: ctx.dialect });
});
