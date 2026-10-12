import type { OrderState } from "./model.js";

/**
 * Which order states may deliver a digital download: those whose money was
 * taken and kept. `pending`, `failed` and `expired` never kept it; `cancelled`
 * and `refunded` gave it back. A PARTIAL refund leaves the order in its paid-side
 * state and still delivers.
 *
 * The ONE copy of this rule (issue #447): the plugin's download gate serves only
 * in these states, and the console offers Revoke download access only in them
 * (`revokeOrderDownloadAccess` refuses anywhere else). A `Record` over the whole
 * union, so a state added later fails typecheck here until someone decides
 * whether it delivers.
 */
export const DOWNLOAD_DELIVERABLE_STATES: Readonly<Record<OrderState, boolean>> = {
	paid: true,
	processing: true,
	shipped: true,
	delivered: true,
	completed: true,
	pending: false,
	failed: false,
	expired: false,
	cancelled: false,
	refunded: false,
};

/** Whether an order in `state` may deliver its downloads. */
export function isDownloadDeliverableState(state: OrderState): boolean {
	return DOWNLOAD_DELIVERABLE_STATES[state];
}
