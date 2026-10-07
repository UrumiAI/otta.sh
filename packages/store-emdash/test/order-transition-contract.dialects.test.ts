/**
 * The domain's `orderTransitionContract` against `EmdashOrderStore`, on both Node
 * dialects, in full — no staging and no todos.
 *
 * INC-B4 is what finished it: the suite's two guest-linking cases need
 * `linkGuestOrders` (which must also rewrite the denormalized `customerKey`, ADR-0019
 * R3) and `listForCustomer`, and those were the last two methods the port was missing.
 *
 * The forced-rollback case runs from here too, and passes by EARLY RETURN: the
 * document harness exposes no `forceFailedTransition`, because there is no transaction
 * to abort. The property it pins — the flip, the audit event and the outbox entry are
 * ONE write, all or nothing — is asserted directly in
 * `order-crash-seams.dialects.test.ts`, which PARKS the single compare-and-set and
 * reads the documents back. That is a stronger statement on this store than a rollback
 * would be, which is why nothing here is skipped to make room for it.
 */
import { orderTransitionContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, orderTransitionHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore transitions", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	orderTransitionContract(
		// `countingIds` for the reason every sibling suite passes it: deterministic,
		// lexically increasing ids, so a same-instant `(at, id)` tie-break is append
		// order rather than uuid luck.
		async () => orderTransitionHarness(makeOrderHarness(bound.storage, { countingIds: true })),
		{ dialect: ctx.dialect },
	);
});
