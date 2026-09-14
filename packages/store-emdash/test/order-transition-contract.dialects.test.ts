/**
 * The domain's `orderTransitionContract` against `EmdashOrderStore`, on both Node
 * dialects — **staged** (see `test/order-contract-b2.ts`).
 *
 * Eight of its eleven cases run here. Six of them count DELIVERED emails, which
 * drains the outbox through `claimNextEmail` — ADR-0019 R2's `emailDueAt` lease — and
 * they were todos until the refunds increment landed it. Of the three that remain,
 * two need `listForCustomer`/`linkGuestOrders` (the lists increment).
 *
 * The third will not become a real case here at all: `forceFailedTransition` is
 * deliberately not supplied, because there is no transaction to abort on a document
 * store, so a green would be vacuous. The property it pins — flip + event + outbox
 * are one atom — is proven instead by PARKING the single compare-and-set in
 * `order-crash-seams.dialects.test.ts` and asserting none of the three has landed,
 * which is a stronger statement than aborting a transaction would be.
 */
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { orderTransitionContractB2 } from "./order-contract-b2.js";
import { makeOrderHarness, orderTransitionHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore transitions", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderTransitionContractB2(
		async () => orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true })),
		{ dialect: ctx.dialect },
	);
});
