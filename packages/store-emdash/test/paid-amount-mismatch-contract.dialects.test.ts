/**
 * The domain's `paidAmountMismatchContract` (issue #35) against the document store,
 * on both Node dialects: a stray wrong-amount success on an already-paid order is
 * kept in the forensic trail as ONE `PAID_AMOUNT_MISMATCH` anomaly per gateway event
 * — written through the real `EmdashPaymentEventStore`, read back from its
 * `payment_anomalies` collection — and moves no order state.
 */
import { paidAmountMismatchContract } from "@urumi.ai/otta-domain/testing";
import {
	collectionOf,
	PAYMENT_ANOMALIES_COLLECTION,
	type PaymentAnomalyDoc,
} from "../src/index.js";
import { PAYMENT_DECLINE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

describeEachDialect("paid amount mismatch", (ctx) => {
	const bound = ctx.useStorage(PAYMENT_DECLINE_LAYOUT);
	paidAmountMismatchContract(
		() => {
			const decline = makePaymentDeclineHarness(bound.storage);
			const anomalies = collectionOf<PaymentAnomalyDoc>(
				bound.storage,
				PAYMENT_ANOMALIES_COLLECTION,
			);
			return {
				...decline,
				advanceClock: (ms) => decline.clock.advance(ms),
				async anomalies() {
					const found: PaymentAnomalyDoc[] = [];
					let cursor: string | undefined;
					do {
						const page = await anomalies.query({ limit: 100, cursor });
						for (const { data } of page.items) found.push(data);
						cursor = page.hasMore ? page.cursor : undefined;
					} while (cursor !== undefined);
					return found;
				},
			};
		},
		{ dialect: ctx.dialect },
	);
});
