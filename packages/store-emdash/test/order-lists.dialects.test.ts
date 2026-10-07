/**
 * The document model's own list / search / customer-union / locator cases, on both Node
 * dialects. The cases live in `order-list-cases.ts` so D1's spec runs the same ones —
 * see that module for what each of them pins and why.
 */
import { describeEachDialect } from "./describe-each-dialect.js";
import { orderListCases } from "./order-list-cases.js";
import { ORDER_LAYOUT } from "./order-collections.js";

describeEachDialect("EmdashOrderStore lists", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderListCases(() => bound.storage);
});
