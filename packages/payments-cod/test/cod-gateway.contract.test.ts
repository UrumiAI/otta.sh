import { buildGatewayHarness, offlinePaymentGatewayContract } from "@urumi.ai/otta-domain/testing";
import { CashOnDeliveryGateway } from "../src/index.js";

type ConfirmInput = Parameters<ReturnType<typeof buildGatewayHarness>["confirm"]>[0];

/** A well-formed provider-shaped `payment_intent.succeeded` for the order, with
 *  a signature header: the COD gateway has no webhook, so it must refuse even
 *  this. */
function webhookShaped(input: ConfirmInput) {
	const body = JSON.stringify({
		id: input.dedupeKey,
		type: "payment_intent.succeeded",
		data: {
			object: {
				id: input.providerRef,
				amount: input.amountCents,
				currency: input.currency.toLowerCase(),
				metadata: { orderId: input.orderId },
			},
		},
	});
	return {
		kind: "webhook" as const,
		body: new TextEncoder().encode(body),
		headers: { "Stripe-Signature": "t=1,v1=00" },
	};
}

offlinePaymentGatewayContract(
	() =>
		buildGatewayHarness({
			gateway: new CashOnDeliveryGateway(),
			confirm: webhookShaped,
			confirmBadSignature: webhookShaped,
		}),
	{ gateway: "cod" },
);
