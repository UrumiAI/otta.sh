import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey } from "../money/ids.js";
import { settleOrder } from "../orders/settle-order.js";
import type { PaymentGatewayHarness } from "./gateway-harness.js";

export type { PaymentGatewayHarness } from "./gateway-harness.js";

export interface PaymentGatewayContractOptions {
	gateway: string;
}

/**
 * The shared *settlement* behavioral spec (§7): verify → dedupe → settle →
 * commit/grant. Run against the fake gateway first, then the real Stripe
 * adapters (each supplies its own confirm-minting; the settle orchestration is
 * identical). Proves the wire→port fidelity of every gateway converging on one
 * settle path.
 */
export function paymentGatewayContract(
	makeHarness: () => PaymentGatewayHarness,
	opts: PaymentGatewayContractOptions,
): void {
	describe(`paymentGatewayContract [${opts.gateway}]`, () => {
		test("a verified confirmation flips the order to paid and commits the physical reservation", async () => {
			const h = makeHarness();
			const { orderId, reservationId } = await h.seedPhysicalOrder(1500);
			const raw = await h.confirm({
				orderId,
				amountCents: 1500,
				currency: "USD",
				outcome: "succeeded",
				dedupeKey: "evt-1",
				providerRef: "pi_1",
			});
			const res = await settleOrder(h.settleDeps, h.gateway, raw);
			expect(res.ok).toBe(true);
			expect(await h.orderState(orderId)).toBe("paid");
			expect(h.reservationState(reservationId)).toBe("committed");
		});

		test("a replayed confirmation (same dedupeKey) settles once — the second is a no-op", async () => {
			const h = makeHarness();
			const { orderId, reservationId } = await h.seedPhysicalOrder(1500);
			const raw = await h.confirm({
				orderId,
				amountCents: 1500,
				currency: "USD",
				outcome: "succeeded",
				dedupeKey: "evt-2",
				providerRef: "pi_2",
			});
			await settleOrder(h.settleDeps, h.gateway, raw);
			const replay = await settleOrder(h.settleDeps, h.gateway, raw);
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.noop).toBe(true);
			expect(await h.orderState(orderId)).toBe("paid");
			expect(h.reservationState(reservationId)).toBe("committed");
		});

		test("a verified confirmation on a digital order grants an entitlement", async () => {
			const h = makeHarness();
			const { orderId, sku } = await h.seedDigitalOrder(900);
			const raw = await h.confirm({
				orderId,
				amountCents: 900,
				currency: "USD",
				outcome: "succeeded",
				dedupeKey: "evt-3",
				providerRef: "pi_3",
			});
			const res = await settleOrder(h.settleDeps, h.gateway, raw);
			expect(res.ok).toBe(true);
			expect(await h.orderState(orderId)).toBe("paid");
			expect(await h.hasEntitlement(orderId, sku)).toBe(true);
		});

		test("amount/currency mismatch is rejected and recorded as an anomaly; order stays pending", async () => {
			const h = makeHarness();
			const { orderId } = await h.seedPhysicalOrder(1500);
			const raw = await h.confirm({
				orderId,
				amountCents: 999, // wrong amount
				currency: "USD",
				outcome: "succeeded",
				dedupeKey: "evt-4",
				providerRef: "pi_4",
			});
			const res = await settleOrder(h.settleDeps, h.gateway, raw);
			expect(res).toEqual({ ok: false, reason: "AMOUNT_MISMATCH" });
			expect(await h.orderState(orderId)).toBe("pending");
			expect(h.anomalies().some((a) => a.kind === "AMOUNT_MISMATCH")).toBe(true);
		});

		test("an invalid-signature confirmation is rejected (no settle)", async () => {
			const h = makeHarness();
			const { orderId } = await h.seedPhysicalOrder(1500);
			const raw = await h.confirmBadSignature({
				orderId,
				amountCents: 1500,
				currency: "USD",
				outcome: "succeeded",
				dedupeKey: "evt-5",
				providerRef: "pi_5",
			});
			const res = await settleOrder(h.settleDeps, h.gateway, raw);
			expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
			expect(await h.orderState(orderId)).toBe("pending");
		});
	});
}

export interface OfflinePaymentGatewayContractOptions {
	gateway: string;
}

/**
 * The spec an OFFLINE gateway (ADR-0044 — cash on delivery) meets in place of the
 * settlement spec above: it has no provider, no webhook and no money to move, so
 * every verb answers "nothing online", and NO confirmation of any shape can settle
 * one of its orders. The harness's `confirm` mints the most plausible raw
 * confirmation the caller can (a correctly-signed webhook from another gateway);
 * the offline gateway must still reject it. Paying such an order is a person's
 * act — the admin Mark paid — pinned by `offlinePaymentContract`.
 */
export function offlinePaymentGatewayContract(
	makeHarness: () => PaymentGatewayHarness,
	opts: OfflinePaymentGatewayContractOptions,
): void {
	describe(`offlinePaymentGatewayContract [${opts.gateway}]`, () => {
		test("it cannot refund: refundable is false and a refund answers UNSUPPORTED", async () => {
			const h = makeHarness();
			expect(h.gateway.refundable).toBe(false);
			const res = await h.gateway.refund({
				orderId: (await h.seedPhysicalOrder(1500)).orderId,
				providerRef: "anything",
				amount: cents(500),
				currency: currency("USD"),
				priorRefunded: cents(0),
				idempotencyKey: idempotencyKey("refund-1"),
			});
			expect(res).toEqual({ ok: false, reason: "UNSUPPORTED" });
		});

		test("createIntent places the order with no online step: an offline action and no intent id, the same on a replay", async () => {
			const h = makeHarness();
			const { orderId } = await h.seedPhysicalOrder(1500);
			const input = {
				orderId,
				amount: cents(1500),
				currency: currency("USD"),
				idempotencyKey: idempotencyKey("checkout-1"),
				lines: [{ title: "Widget", quantity: 1 }],
			};
			const first = await h.gateway.createIntent(input);
			expect(first).toEqual({
				gateway: h.gateway.id,
				intentId: "",
				clientAction: { kind: "offline" },
			});
			expect(await h.gateway.createIntent(input)).toEqual(first);
		});

		test("no confirmation settles an offline order — a signed webhook is rejected and the order stays pending", async () => {
			const h = makeHarness();
			const { orderId, reservationId } = await h.seedPhysicalOrder(1500);
			const raw = await h.confirm({
				orderId,
				amountCents: 1500,
				currency: "USD",
				outcome: "succeeded",
				dedupeKey: "evt-offline-1",
				providerRef: "pi_offline_1",
			});
			const res = await settleOrder(h.settleDeps, h.gateway, raw);
			expect(res.ok).toBe(false);
			expect(await h.orderState(orderId)).toBe("pending");
			expect(h.reservationState(reservationId)).toBe("adopted");
			expect(h.anomalies()).toEqual([]);
		});

		test("there is no standing intent to withdraw: cancelIntent answers UNSUPPORTED", async () => {
			const h = makeHarness();
			const { orderId } = await h.seedPhysicalOrder(1500);
			expect(
				await h.gateway.cancelIntent({
					orderId,
					intentId: "",
					idempotencyKey: idempotencyKey("cancel-1"),
				}),
			).toEqual({ ok: false, reason: "UNSUPPORTED" });
		});
	});
}
