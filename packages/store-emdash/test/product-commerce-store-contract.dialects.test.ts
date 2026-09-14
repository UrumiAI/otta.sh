/**
 * The domain's `productCommerceStoreContract` against
 * `EmdashProductCommerceStore`, on every Node dialect.
 *
 * The contract suite IS the spec: the same ~185 cases the fake and the SQL
 * adapter run, with no skips and no narrowing. What it exercises here that it
 * cannot exercise on the fake is that the guard ORDER survives being reassembled
 * out of compare-and-sets — the zero-row classifier, the sku claim's precedence
 * over both stock refusals, and the embedded variants' currency resolution all
 * have to give the same answers they gave inside a transaction.
 */
import { productCommerceStoreContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

describeEachDialect("EmdashProductCommerceStore", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);
	productCommerceStoreContract(async () => makeProductCommerceHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});
