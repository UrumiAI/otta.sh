import type { EntitlementStore } from "../ports/entitlement-store.js";
import type { Order } from "./model.js";

/**
 * Revoke an order's download entitlements once its money has been returned IN
 * FULL (issue #376, product-owner decision: a full refund revokes download
 * access). Shared by every path that can end there, each of which decides "in
 * full" by its own recorded facts and calls this only AFTER they are recorded:
 *  - `refundOrder` — the order reached `refunded` (the ledger's own flip);
 *  - Mark refunded (`transitionOrder` / `transitionOrderAsAdmin` → `refunded`);
 *  - `resolveUnverifiedRefund` — a confirm that leaves the order `refunded`, or
 *    that settles a cancellation's refund (which is always the whole remainder);
 *  - `cancelOrderWithRefund` — its refund leg returned everything still refundable.
 *
 * Every caller also runs it on its idempotent replay, so a crash between the
 * recorded change and this revoke is finished by the retry. `revokeByOrder` is
 * itself idempotent, so a replay changes nothing once done.
 *
 * Entitlements are granted per DIGITAL line only (`settleOrder`), so an order with
 * none has nothing to revoke and costs no read. An absent store (a pure ledger
 * test, a caller that never closes a paid order) revokes nothing.
 */
export async function revokeOrderEntitlements(
	store: EntitlementStore | undefined,
	order: Pick<Order, "id" | "lines">,
): Promise<void> {
	if (store === undefined) return;
	if (!order.lines.some((line) => line.fulfillmentKind === "digital")) return;
	await store.revokeByOrder(order.id);
}
