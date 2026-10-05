/**
 * The domain's `cancelWithRefundContract` against `EmdashOrderStore` and
 * `EmdashInventoryStore`, on both Node dialects (QA T1-4).
 *
 * What it proves through the document model: a cancellation's refund rides the same
 * reserve-before-issue ledger as any refund but never flips the order `→ refunded`;
 * the restock is the inventory ledger's own exactly-once `restock`, so a retry after
 * a crash between the refund and the cancel moves no second unit; and the cancel
 * flip records the refund and the restock on the envelope it already guards.
 */
import { cancelWithRefundContract } from "@otta-sh/domain/testing";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

describeEachDialect("EmdashOrderStore cancel with refund", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);
	cancelWithRefundContract(
		() => {
			const h = makeOrderHarness(bound.storage, { countingIds: true });
			return {
				orderStore: h.store,
				inventoryStore: h.inventory,
				clock: h.clock,
				// A checkout hold is stamped by the cart before it can be adopted.
				stampHold: (reservationId, expiresAt) =>
					h.inventory.stampHoldDeadline(reservationId, expiresAt),
			};
		},
		{ dialect: ctx.dialect },
	);
});
