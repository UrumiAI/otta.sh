/**
 * The entitlement, settings and order-note contracts against the document adapters on
 * **D1** — the dialect Otta actually ships on, through the host's OWN Kysely wiring.
 *
 * All three contracts run in full, with no skips, and the delivery gate's three real
 * shapes run with them. What this tier exercises that the others cannot is the READ
 * contract these stores depend on, planned by D1's SQLite build: the `orderId`,
 * `buyerRefLower`, `sku` and `state` equalities the gate's fallback query ANDs, and the
 * `orderId` equality one order's note list pages on. Every one of those is a
 * `json_extract` expression with the host's own limit clamp and cursor on top, and a
 * declared index is a read contract rather than a performance knob, so this is where
 * that contract is checked against the runtime that will serve it.
 *
 * It also runs the WebCrypto digest that keys every payment-anomaly document inside
 * `workerd`, which is the environment that made `node:crypto` unusable in the first
 * place.
 *
 * The harness wiring is `test/misc-harness.ts`, imported rather than restated — it
 * names no Node driver, so it loads inside `workerd`. Only the storage BINDING
 * differs, and that is what `describe-d1.ts` supplies.
 */
import { orderId } from "@otta-sh/domain";
import {
	entitlementStoreContract,
	orderNotesStoreContract,
	settingsStoreContract,
} from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { paymentAnomalyId } from "../../src/index.js";
import { MISC_LAYOUT } from "../misc-collections.js";
import { entitlementGateCases } from "../misc-gate-cases.js";
import {
	makeEntitlementHarness,
	makeMiscHarness,
	makeOrderNotesHarness,
	makeSettingsHarness,
} from "../misc-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(MISC_LAYOUT);

entitlementStoreContract(async () => makeEntitlementHarness(bound.storage), { dialect: "d1" });
settingsStoreContract(async () => makeSettingsHarness(bound.storage), { dialect: "d1" });
orderNotesStoreContract(async () => makeOrderNotesHarness(bound.storage), { dialect: "d1" });
entitlementGateCases("d1", () => makeMiscHarness(bound.storage));

test("the payment-event dedupe and the anomaly digest work inside workerd", async () => {
	const h = makeMiscHarness(bound.storage);
	const now = h.now();
	expect(await h.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", now)).toBe(true);
	expect(await h.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", now)).toBe(false);

	// The anomaly id is a WebCrypto SHA-256 — the digest this runtime forced.
	const anomaly = {
		orderId: orderId("ord-1"),
		gateway: "stripe",
		kind: "AMOUNT_MISMATCH",
		detail: "expected 1000, saw 900",
		now,
	} as const;
	await h.paymentEventStore.recordAnomaly(anomaly);
	await h.paymentEventStore.recordAnomaly(anomaly);
	expect(await h.anomalies.count()).toBe(1);
	expect(await h.anomalies.get(await paymentAnomalyId(anomaly))).not.toBeNull();
});
