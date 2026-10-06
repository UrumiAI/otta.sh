import {
	cents,
	currency as toCurrency,
	orderId as toOrderId,
	settleOrder,
	type RawConfirmation,
} from "@otta-sh/domain";
import { buildGatewayHarness, type GatewayConfirmInput } from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";
import { X402PaymentGateway } from "../src/index.js";

// The x402 adapter against the shared settle path (§8 step 4.7), with the
// receipt-forwarding model retired (ADR-0028, increment 2).
//
// This file used to run `paymentGatewayContract` with proofs signed by an
// offline HMAC facilitator. That facilitator, and the custom HTTP one it stood in
// for, are gone, and no x402 confirmation can settle until increment 7 brings a
// `page_gate` value only the domain can mint. So the contract's settling cases
// cannot hold for x402 today, and what this file pins instead is the refusal,
// end to end through `settleOrder` and the in-memory stores: a `page_gate` that
// would once have settled leaves the order pending, commits no reservation and
// grants no entitlement. Increment 7 puts `paymentGatewayContract` back here.

function pageGate(input: GatewayConfirmInput): RawConfirmation {
	return {
		kind: "page_gate",
		proof: {
			orderId: toOrderId(input.orderId),
			transaction: input.dedupeKey,
			network: "eip155:8453",
			payer: "0xbuyer",
			amount: cents(input.amountCents),
			currency: toCurrency(input.currency),
			signature: "ab".repeat(32),
		},
	};
}

function harness() {
	return buildGatewayHarness({
		gateway: new X402PaymentGateway({ payTo: "0xTEST", accepts: ["eip155:8453"] }),
		confirm: pageGate,
		confirmBadSignature: pageGate,
	});
}

describe("x402 gateway through settleOrder [ADR-0028 increment 2]", () => {
	test("a page_gate for a pending physical order is refused; the order stays pending", async () => {
		const h = harness();
		const { orderId, reservationId } = await h.seedPhysicalOrder(1500);
		const raw = await h.confirm({
			orderId,
			amountCents: 1500,
			currency: "USD",
			outcome: "succeeded",
			dedupeKey: "0xtx-1",
			providerRef: "0xtx-1",
		});
		expect(await settleOrder(h.settleDeps, h.gateway, raw)).toEqual({
			ok: false,
			reason: "MALFORMED",
		});
		expect(await h.orderState(orderId)).toBe("pending");
		expect(h.reservationState(reservationId)).not.toBe("committed");
	});

	test("a page_gate for a pending digital order grants no entitlement", async () => {
		const h = harness();
		const { orderId, sku } = await h.seedDigitalOrder(900);
		const raw = await h.confirm({
			orderId,
			amountCents: 900,
			currency: "USD",
			outcome: "succeeded",
			dedupeKey: "0xtx-2",
			providerRef: "0xtx-2",
		});
		expect(await settleOrder(h.settleDeps, h.gateway, raw)).toEqual({
			ok: false,
			reason: "MALFORMED",
		});
		expect(await h.orderState(orderId)).toBe("pending");
		expect(await h.hasEntitlement(orderId, sku)).toBe(false);
	});
});
