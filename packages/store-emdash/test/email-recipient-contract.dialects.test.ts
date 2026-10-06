/**
 * The domain's `emailRecipientContract` against `EmdashOrderStore`, on both Node
 * dialects (ADR-0028 Decision 7, increment 4): an order with no email recipient — an
 * x402 buyer's `x402:0x…` reference — is never emailed, and each of its outbox entries
 * is completed as SKIPPED, a terminal outcome of its own rather than "sent". The
 * "skipped" completion is a write to the order document, which is why the suite runs
 * here and on D1 (`d1/order-store-contract.d1.spec.ts`) as well as on the fake.
 */
import { emailRecipientContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { emailRecipientHarness, makeOrderHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore email recipient", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	emailRecipientContract(
		async () => emailRecipientHarness(makeOrderHarness(bound.storage, { countingIds: true })),
		{ dialect: ctx.dialect },
	);
});
