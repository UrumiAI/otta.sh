import { type SettleDeps, type SettleResult, settleOrder } from "@urumi/domain";
import { type Context, Hono } from "hono";
import type { OrderServiceDeps } from "./orders.js";

/**
 * Public Stripe webhook receiver (§7). Consumes the **raw body** (no JSON
 * re-parse before verification) and reads `Stripe-Signature`. Runs
 * `settleOrder(stripeGateway, {kind:"webhook"})`. Returns **200 after
 * dedupe/settle** (so Stripe stops retrying) and **400 only on signature/parse
 * failure**. An amount/currency mismatch is a recorded anomaly, not retryable →
 * 200.
 */
export function webhookRoutes(deps: OrderServiceDeps): Hono {
	const app = new Hono();
	const settleDeps: SettleDeps = {
		orderStore: deps.orderStore,
		entitlementStore: deps.entitlementStore,
		paymentEventStore: deps.paymentEventStore,
		inventoryStore: deps.store,
		clock: deps.clock,
	};

	app.post("/stripe", async (c) => {
		const gateway = deps.gateways.stripe;
		if (gateway === undefined) return c.json({ ok: false, error: "stripe not configured" }, 503);

		// RAW bytes — the HMAC is verified over exactly these, never a re-serialized body.
		const body = new Uint8Array(await c.req.arrayBuffer());
		const signature = c.req.header("stripe-signature") ?? "";
		const res = await settleOrder(settleDeps, gateway, {
			kind: "webhook",
			body,
			headers: { "stripe-signature": signature },
		});
		return webhookResponse(c, res);
	});

	return app;
}

function webhookResponse(c: Context, res: SettleResult): Response {
	if (res.ok) return c.json({ ok: true }, 200);
	switch (res.reason) {
		case "INVALID_SIGNATURE":
		case "MALFORMED":
		case "UNKNOWN_EVENT":
			return c.json({ ok: false, reason: res.reason }, 400);
		case "ORDER_NOT_FOUND":
			return c.json({ ok: false, reason: res.reason }, 404);
		case "AMOUNT_MISMATCH":
			// Recorded as an anomaly (§5); retrying will never fix it → 200 so Stripe stops.
			return c.json({ ok: false, reason: res.reason }, 200);
	}
}
