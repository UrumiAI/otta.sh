import { buildGatewayHarness, paymentGatewayContract } from "@urumi/domain/testing";
import { signStripeWebhook, StripePaymentGateway } from "../src/index.js";

const SECRET = "whsec_test_phase4";

type ConfirmInput = Parameters<ReturnType<typeof buildGatewayHarness>["confirm"]>[0];

function mint(input: ConfirmInput, secret: string) {
	const signed = signStripeWebhook(
		{
			eventId: input.dedupeKey,
			type:
				input.outcome === "succeeded"
					? "payment_intent.succeeded"
					: "payment_intent.payment_failed",
			paymentIntentId: input.providerRef,
			orderId: input.orderId,
			amountCents: input.amountCents,
			currency: input.currency,
		},
		secret,
	);
	return {
		kind: "webhook" as const,
		body: signed.body,
		headers: { "Stripe-Signature": signed.signatureHeader },
	};
}

// paymentGatewayContract against the REAL Stripe adapter (§8 step 4.6): the same
// verify→dedupe→settle→commit/grant behavior, driven with the offline fake-Stripe
// driver signing test payloads (no network).
paymentGatewayContract(
	() => {
		const gateway = new StripePaymentGateway({ webhookSecret: SECRET });
		return buildGatewayHarness({
			gateway,
			confirm: (input) => mint(input, SECRET),
			confirmBadSignature: (input) => mint(input, "whsec_wrong_secret"),
		});
	},
	{ gateway: "stripe" },
);
