/**
 * The domain's `orderTransitionContract` against `EmdashOrderStore`, on both Node
 * dialects — **staged** (see `test/order-contract-b2.ts`).
 *
 * Only two of its eleven cases run here, and the reason is worth stating: every
 * other case counts DELIVERED emails, which drains the outbox through
 * `claimNextEmail` — the `updateIf` lease on the denormalized `emailDueAt` field
 * that ADR-0019 R2 hands to INC-B4. This increment WRITES the outbox entry (inside
 * the same compare-and-set as the flip, at most one per `(orderId, toState)`); it
 * does not yet claim one. The entry's existence and its once-only-ness are
 * therefore asserted on the DOCUMENT, in `order-crash-seams.dialects.test.ts`,
 * until the lease lands and these todos become real cases.
 *
 * `forceFailedTransition` is deliberately not supplied: there is no transaction to
 * abort. The property it pins — flip + event + outbox are one atom — is proven by
 * parking the single compare-and-set instead (same crash-seams file).
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
