import { createHmac } from "node:crypto";

/**
 * A correctly signed Stripe delivery of ANY event type, shaped the way the
 * calling site sends it to `webhooks/stripe/settle`.
 *
 * WHY NOT `signStripeWebhook`. The adapter's signer only mints the two event
 * types Otta settles on (its input type says so), which is right for the
 * adapter. A store's endpoint, though, receives whatever the operator
 * subscribed it to — `charge.refunded`, `charge.dispute.created`, … — and those
 * deliveries carry a VALID signature. Proving how the route answers one needs a
 * genuinely signed body of a type the adapter will not mint, so this signs it
 * the way Stripe does: `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, hex.
 */
export function signedStripeEvent(
	event: { id: string; type: string; data: { object: Record<string, unknown> } },
	secret: string,
	idempotencyKey: string,
): { rawBodyBase64: string; stripeSignature: string; idempotencyKey: string } {
	const body = JSON.stringify({ object: "event", ...event });
	const timestamp = Math.floor(Date.now() / 1000);
	const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
	return {
		rawBodyBase64: Buffer.from(body, "utf8").toString("base64"),
		stripeSignature: `t=${timestamp},v1=${v1}`,
		idempotencyKey,
	};
}

/** A `charge.refunded` for `orderId` — the event a store subscribed to more
 *  than the two settle events most plausibly receives (a dashboard refund). */
export function chargeRefundedEvent(
	orderId: string,
	amountCents: number,
): { id: string; type: string; data: { object: Record<string, unknown> } } {
	return {
		id: `evt_refund_${orderId}`,
		type: "charge.refunded",
		data: {
			object: {
				id: `ch_${orderId}`,
				object: "charge",
				amount: amountCents,
				amount_refunded: amountCents,
				currency: "usd",
				payment_intent: `pi_${orderId}`,
				refunded: true,
				metadata: { order_id: orderId },
			},
		},
	};
}
