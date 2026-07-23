import { cents, currency as toCurrency } from "@urumi/domain";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "@urumi/domain";
import { refundOrder } from "@urumi/domain";
import type { FinalizeRefundStoreResult } from "@urumi/domain";
import {
	CountingIdGen,
	FakePaymentGateway,
	FixedClock,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
} from "@urumi/domain/testing";
import { describe, expect, test } from "vitest";

const USD = toCurrency("USD");

// ADR-0008, reserve-before-issue: "issued but unrecorded" is impossible by
// construction (issuance strictly follows a committed reservation, and finalize
// only updates that existing row). This suite drives the LOUD RESIDUAL guard
// anyway — a store whose `finalizeRefund` reports `found:false` after the gateway
// confirmed issuance — to prove the money is NEVER silently dropped: an anomaly
// carrying the provider refundRef is recorded, the order is flagged for
// reconciliation, and a DISTINCT reason surfaces (never a clean rejection).

/** An OrderStore that reserves + issues normally but whose finalize LOSES the
 *  reserved row — the only way to reach the impossible residual in a test. */
class FinalizeLosesRowStore extends InMemoryOrderStore {
	override async finalizeRefund(): Promise<FinalizeRefundStoreResult> {
		return {
			found: false,
			alreadyFinalized: false,
			refund: null,
			fullyRefunded: false,
			order: null,
		};
	}
}

async function seedPaid(
	store: InMemoryOrderStore,
	id: string,
): Promise<ReturnType<typeof toOrderId>> {
	const oid = toOrderId(id);
	await store.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(1000),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: USD },
	});
	await store.markPaid(oid);
	await store.recordPayment({
		orderId: oid,
		gateway: "stripe",
		providerRef: `pi_${id}`,
		amount: cents(1000),
		currency: USD,
		status: "succeeded",
	});
	return oid;
}

describe("refundOrder — issued-but-unrecorded residual (ADR-0008)", () => {
	test("records a REFUND_UNRECORDED anomaly with the refundRef, flags reconciliation, returns the distinct reason", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new FinalizeLosesRowStore({ idGen: new CountingIdGen("oi"), clock });
		const paymentEventStore = new InMemoryPaymentEventStore();
		const id = await seedPaid(orderStore, "ord-residual");
		const gw = new FakePaymentGateway({ id: "stripe" });

		const res = await refundOrder({ orderStore, paymentEventStore, clock }, gw, {
			orderId: id,
			amount: cents(1000),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: idempotencyKey("rf-residual"),
		});

		// The DISTINCT reason — never confusable with a clean pre-issuance rejection.
		expect(res).toEqual({ ok: false, reason: "REFUND_ISSUED_UNRECORDED" });
		// The gateway DID issue (money moved) — proven by the recorded call.
		expect(gw.refundCalls).toHaveLength(1);
		// A loud anomaly carrying the provider refundRef — the money is on the record.
		const anomalies = paymentEventStore.anomalies();
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]?.kind).toBe("REFUND_UNRECORDED");
		expect(anomalies[0]?.detail).toContain(`re_${idempotencyKey("rf-residual")}`);
		// And the order is flagged for manual reconciliation.
		expect((await orderStore.getById(id))?.reconciliationFlag).not.toBeNull();
	});

	test("without a paymentEventStore wired, it STILL flags reconciliation and returns the distinct reason (never a silent drop)", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new FinalizeLosesRowStore({ idGen: new CountingIdGen("oi"), clock });
		const id = await seedPaid(orderStore, "ord-residual2");
		const gw = new FakePaymentGateway({ id: "stripe" });

		const res = await refundOrder({ orderStore }, gw, {
			orderId: id,
			amount: cents(1000),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: idempotencyKey("rf-residual2"),
		});

		expect(res).toEqual({ ok: false, reason: "REFUND_ISSUED_UNRECORDED" });
		expect((await orderStore.getById(id))?.reconciliationFlag).not.toBeNull();
	});
});

/** A gateway that, inside `refund`, plays the concurrent same-key WINNER: it
 *  finalizes the reservation with `finalizeRef` before returning success with
 *  `returnRef` — the deterministic stand-in for the double-issue interleave. */
function racingGateway(
	store: InMemoryOrderStore,
	key: ReturnType<typeof idempotencyKey>,
	refs: { finalizeRef: string; returnRef: string },
): FakePaymentGateway {
	const gw = new FakePaymentGateway({ id: "stripe" });
	const original = gw.refund.bind(gw);
	gw.refund = async (input) => {
		await original(input); // keep the call recorded
		await store.finalizeRefund({ idempotencyKey: key, refundRef: refs.finalizeRef });
		return {
			ok: true,
			refundRef: refs.returnRef,
			amount: input.amount,
			currency: input.currency,
		};
	};
	return gw;
}

describe("refundOrder — concurrent same-key double-issue (ADR-0008)", () => {
	// Two same-key callers can both hold the ONE reservation (the replay check +
	// reserve `duplicate` outcome let both proceed) and both issue — Stripe's
	// native Idempotency-Key guarantees the provider processes ONE refund, so both
	// gateway legs return the SAME refundRef. The loser's finalize then finds the
	// row already `recorded` with that ref. That MUST be a benign duplicate (no
	// false-positive anomaly); only a DIFFERENT ref under the key stays the loud
	// residual. The "concurrent winner" is simulated deterministically by
	// `racingGateway` — a gateway whose refund() finalizes the reservation itself
	// before returning.

	test("the loser's finalize with the SAME refundRef is a benign duplicate — success, no anomaly, one ledger row", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
		const paymentEventStore = new InMemoryPaymentEventStore();
		const id = await seedPaid(orderStore, "ord-dup");
		const key = idempotencyKey("rf-dup");
		const gw = racingGateway(orderStore, key, { finalizeRef: "re_same", returnRef: "re_same" });

		const res = await refundOrder({ orderStore, paymentEventStore, clock }, gw, {
			orderId: id,
			amount: cents(1000),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: key,
		});

		// The loser sees a SUCCESS shaped like a replay — recorded:false,
		// duplicate:true — never a false-positive REFUND_UNRECORDED.
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.duplicate).toBe(true);
			expect(res.recorded).toBe(false);
			expect(res.fullyRefunded).toBe(true); // the winner's finalize flipped it
			expect(res.refund.refundRef).toBe("re_same");
		}
		expect(paymentEventStore.anomalies()).toHaveLength(0);
		expect((await orderStore.getById(id))?.reconciliationFlag).toBeNull();
		const ledger = await orderStore.listRefunds(id);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.status).toBe("recorded");
	});

	test("a DIFFERENT refundRef under the key stays the LOUD residual — anomaly + reconciliation flag + distinct reason", async () => {
		const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		const orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
		const paymentEventStore = new InMemoryPaymentEventStore();
		const id = await seedPaid(orderStore, "ord-dup2");
		const key = idempotencyKey("rf-dup2");
		// The "winner" finalized with a different provider ref than OUR gateway leg
		// returned — two distinct provider refunds under one key. That is real money
		// with no ledger row: NEVER benign.
		const gw = racingGateway(orderStore, key, { finalizeRef: "re_other", returnRef: "re_mine" });

		const res = await refundOrder({ orderStore, paymentEventStore, clock }, gw, {
			orderId: id,
			amount: cents(1000),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: key,
		});

		expect(res).toEqual({ ok: false, reason: "REFUND_ISSUED_UNRECORDED" });
		const anomalies = paymentEventStore.anomalies();
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]?.kind).toBe("REFUND_UNRECORDED");
		expect(anomalies[0]?.detail).toContain("re_mine"); // OUR unrecorded ref, on the record
		expect((await orderStore.getById(id))?.reconciliationFlag).not.toBeNull();
	});
});
