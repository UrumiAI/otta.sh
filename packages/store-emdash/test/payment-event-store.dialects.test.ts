/**
 * The `PaymentEventStore` behaviours, on every Node dialect.
 *
 * There is no shared contract suite for this port: the domain exercises it only
 * through `paymentGatewayContract` and the SQL package only through its settle-flow
 * suites, both of which drive it via `settleOrder` rather than calling it. So the
 * port's own two guarantees are pinned here, stated as the SQL they replace —
 * `INSERT … ON CONFLICT (dedupe_key) DO NOTHING RETURNING` for the first, a durable
 * insert that is never swallowed for the second.
 *
 * The anomaly half also pins the ONE place this adapter is stricter than the SQL: a
 * digest document id makes an identical replay record once, where the SQL's fresh
 * `id` per call wrote a second indistinguishable row.
 */
import { orderId } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { paymentAnomalyId } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import { makeMiscHarness } from "./misc-harness.js";

describeEachDialect("EmdashPaymentEventStore", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);
	const harness = () => makeMiscHarness(bound.storage);

	const NOW = "2026-07-10T00:00:00.000Z";

	test("dedupe claims the key: true for the first delivery, false for a redelivery", async () => {
		const h = harness();
		expect(await h.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", NOW)).toBe(true);
		expect(await h.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", NOW)).toBe(false);
		expect(await h.events.count()).toBe(1);
	});

	test("the audit row is keyed by the dedupe key and records order, gateway and instant", async () => {
		const h = harness();
		await h.paymentEventStore.dedupe("evt_2", orderId("ord-7"), "x402", NOW);
		// The dedupe key IS the document id — that is the whole of the once-only.
		expect(await h.events.get("evt_2")).toEqual({
			orderId: "ord-7",
			gateway: "x402",
			receivedAt: NOW,
		});
	});

	test("distinct dedupe keys are distinct deliveries", async () => {
		const h = harness();
		expect(await h.paymentEventStore.dedupe("evt_a", orderId("ord-1"), "stripe", NOW)).toBe(true);
		expect(await h.paymentEventStore.dedupe("evt_b", orderId("ord-1"), "stripe", NOW)).toBe(true);
		expect(await h.events.count()).toBe(2);
	});

	test("orderForDedupeKey reports WHOSE row a dedupe key holds — that is the cross-order binding", async () => {
		// `dedupe`'s boolean says a row exists; only this says which order it names,
		// and for x402 (where the dedupe key IS the on-chain transaction) that is
		// what stops one receipt from settling a second, same-priced order.
		const h = harness();
		expect(await h.paymentEventStore.orderForDedupeKey("evt_none")).toBeNull();
		await h.paymentEventStore.dedupe("evt_owned", orderId("ord-9"), "x402", NOW);
		expect(await h.paymentEventStore.orderForDedupeKey("evt_owned")).toBe("ord-9");
		// A second claim does not rebind it.
		await h.paymentEventStore.dedupe("evt_owned", orderId("ord-10"), "x402", NOW);
		expect(await h.paymentEventStore.orderForDedupeKey("evt_owned")).toBe("ord-9");
	});

	test("a dedupe key redelivered against a DIFFERENT order still answers false", async () => {
		// Faithful to the SQL, whose UNIQUE was global and whose conflict clause was
		// silent. `dedupe` stays faithful; the loud cross-order refusal is
		// `settleOrder`'s, off `orderForDedupeKey` above.
		const h = harness();
		expect(await h.paymentEventStore.dedupe("evt_3", orderId("ord-1"), "stripe", NOW)).toBe(true);
		expect(await h.paymentEventStore.dedupe("evt_3", orderId("ord-2"), "stripe", NOW)).toBe(false);
		expect(await h.events.count()).toBe(1);
		// The recorded row still names the order that claimed it.
		expect((await h.events.get("evt_3"))?.orderId).toBe("ord-1");
	});

	test("recordAnomaly stores the anomaly durably", async () => {
		const h = harness();
		await h.paymentEventStore.recordAnomaly({
			orderId: orderId("ord-1"),
			gateway: "stripe",
			kind: "AMOUNT_MISMATCH",
			detail: "expected 1000, saw 900",
			now: NOW,
		});
		expect(await h.listAnomalies()).toEqual([
			{
				orderId: "ord-1",
				gateway: "stripe",
				kind: "AMOUNT_MISMATCH",
				detail: "expected 1000, saw 900",
				recordedAt: NOW,
			},
		]);
	});

	test("an identical anomaly replayed records once; anything that differs is its own row", async () => {
		const h = harness();
		const anomaly = {
			orderId: orderId("ord-1"),
			gateway: "stripe",
			kind: "COMMIT_LOST",
			detail: "reservation res-1 was not committed",
			now: NOW,
		} as const;
		await h.paymentEventStore.recordAnomaly(anomaly);
		await h.paymentEventStore.recordAnomaly(anomaly);
		expect(await h.anomalies.count()).toBe(1);

		// A different detail, a different instant, a different kind and a different
		// order are each a separate anomaly.
		await h.paymentEventStore.recordAnomaly({ ...anomaly, detail: "and res-2 too" });
		await h.paymentEventStore.recordAnomaly({ ...anomaly, now: "2026-07-10T00:00:01.000Z" });
		await h.paymentEventStore.recordAnomaly({ ...anomaly, kind: "PAID_FLIP_LOST" });
		await h.paymentEventStore.recordAnomaly({ ...anomaly, orderId: orderId("ord-2") });
		expect(await h.anomalies.count()).toBe(5);
	});

	test("the anomaly document id is the digest of its own fields", async () => {
		const h = harness();
		const anomaly = {
			orderId: orderId("ord-9"),
			gateway: "x402",
			kind: "REFUND_UNRECORDED",
			detail: "refund rf_1 issued, ledger row not finalized",
			now: NOW,
		} as const;
		await h.paymentEventStore.recordAnomaly(anomaly);
		const id = await paymentAnomalyId(anomaly);
		expect(await h.anomalies.get(id)).not.toBeNull();
	});
});
