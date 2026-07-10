import { FakePaymentGateway } from "@urumi/domain/testing";
import { buildGatewayHarness, paymentGatewayContract } from "@urumi/domain/testing";

// paymentGatewayContract against the fake gateway (§8 step 4.4) — the shared
// settlement behavior (verify→dedupe→settle→commit/grant), driven end-to-end
// through the in-memory stores before any real Stripe/x402 adapter.
paymentGatewayContract(
	() => {
		const gateway = new FakePaymentGateway({ id: "stripe" });
		return buildGatewayHarness({
			gateway,
			confirm: (input) =>
				gateway.webhook({
					outcome: input.outcome,
					orderId: input.orderId,
					providerRef: input.providerRef,
					amount: input.amountCents,
					currency: input.currency,
					dedupeKey: input.dedupeKey,
				}),
			confirmBadSignature: (input) =>
				gateway.webhook(
					{
						outcome: input.outcome,
						orderId: input.orderId,
						providerRef: input.providerRef,
						amount: input.amountCents,
						currency: input.currency,
						dedupeKey: input.dedupeKey,
					},
					{ badSignature: true },
				),
		});
	},
	{ gateway: "fake" },
);
