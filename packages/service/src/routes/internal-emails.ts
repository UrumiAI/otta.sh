import {
	dispatchOrderEmails,
	type Clock,
	type CustomerStore,
	type EmailSender,
	type OrderStore,
} from "@urumi/domain";
import { Hono } from "hono";
import { requireInternalToken } from "./internal-auth.js";

export interface OutboxDispatchDeps {
	orderStore: OrderStore;
	emailSender: EmailSender;
	customerStore: CustomerStore;
	clock: Clock;
	internalToken?: string;
}

/**
 * The email outbox dispatcher trigger (Phase 5 §8 5.8) — the Phase-3
 * hold-expiry-cron precedent, reused: a self-interval or plugin-cron POSTs here
 * to drain pending order-status emails. Claims are atomic, so concurrent runs
 * never double-send; a send failure is retried on the next tick.
 */
export function internalEmailRoutes(deps: OutboxDispatchDeps): Hono {
	const app = new Hono();
	app.post("/dispatch-emails", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const sent = await dispatchOrderEmails({
			orderStore: deps.orderStore,
			emailSender: deps.emailSender,
			customerStore: deps.customerStore,
			clock: deps.clock,
		});
		return c.json({ ok: true, sent }, 200);
	});
	return app;
}
