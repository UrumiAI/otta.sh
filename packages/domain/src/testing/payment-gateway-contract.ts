import { describe, expect, test } from "vitest";
import { settleOrder } from "../orders/settle-order.js";
import type { PaymentGatewayHarness } from "./gateway-harness.js";

export type { PaymentGatewayHarness } from "./gateway-harness.js";

export interface PaymentGatewayContractOptions {
	gateway: string;
}

/**
 * The shared *settlement* behavioral spec (§7): verify → dedupe → settle →
 * commit/grant. Run against the fake gateway first, then the real Stripe and x402
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
			const raw = h.confirm({
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
			const raw = h.confirm({
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
			const raw = h.confirm({
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
			const raw = h.confirm({
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
			const raw = h.confirmBadSignature({
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
