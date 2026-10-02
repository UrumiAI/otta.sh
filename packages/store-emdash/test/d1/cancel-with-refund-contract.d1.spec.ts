/**
 * The domain's `cancelWithRefundContract` against `EmdashOrderStore` and
 * `EmdashInventoryStore`, on **D1** — the dialect Otta ships on (QA T1-4, ADR-0026).
 *
 * The same suite the Node tiers run (`../cancel-with-refund-contract.dialects.test.ts`):
 * a cancellation's refund rides the reserve-before-issue ledger without flipping the
 * order `→ refunded`; the restock moves each line's units exactly once, closing an
 * open commit bracket first so the cancel's release cannot return them a second
 * time; and the cancel flip records both on the envelope. Only the storage binding
 * differs, which `describe-d1.ts` supplies.
 */
import { cancelWithRefundContract } from "@otta-sh/domain/testing";
import { ORDER_LAYOUT } from "../order-collections.js";
import { makeOrderHarness } from "../order-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(ORDER_LAYOUT);

cancelWithRefundContract(
	() => {
		const h = makeOrderHarness(bound.storage, { countingIds: true });
		return {
			orderStore: h.store,
			inventoryStore: h.inventory,
			clock: h.clock,
			stampHold: (reservationId, expiresAt) =>
				h.inventory.stampHoldDeadline(reservationId, expiresAt),
		};
	},
	{ dialect: "d1" },
);
