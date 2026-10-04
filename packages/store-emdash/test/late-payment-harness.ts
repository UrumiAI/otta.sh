/**
 * The `latePaymentContract` harness over the document store: the decline harness
 * (the same real stores, shared between settle and expiry) plus the one hook the
 * ports cannot provide — an order written with NO state-change audit, the shape of
 * every order that predates the audit log. Factored out so all three dialects run
 * it; like the decline harness it names no Node driver, so D1 can load it.
 */
import type { LatePaymentHarness } from "@otta-sh/domain/testing";
import type { StorageAccess } from "../src/index.js";
import { makeOrderHarness } from "./order-harness.js";
import { makePaymentDeclineHarness } from "./payment-decline-harness.js";

export function makeLatePaymentHarness(storage: StorageAccess): LatePaymentHarness {
	const decline = makePaymentDeclineHarness(storage);
	// A second order harness over the SAME storage, used only for its bare-document
	// seed: the documents it writes are the ones the decline harness's stores read.
	const orders = makeOrderHarness(storage);
	return {
		...decline,
		seedOrderWithoutAudit: (row) => orders.seedOrder(row),
	};
}
