import {
	dispatchOrderEmails,
	type Clock,
	type CustomerCredentialVerifier,
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
	/** For the login-challenge prune (review round H1) — same maintenance tick. */
	credentialVerifier: CustomerCredentialVerifier;
	clock: Clock;
	internalToken?: string;
}

/**
 * The email/auth maintenance trigger (Phase 5 §8 5.8 + review round H1) — the
 * Phase-3 hold-expiry-cron precedent, reused: a self-interval or plugin-cron
 * POSTs here to (a) drain pending order-status emails and (b) prune consumed/
 * expired login challenges so `login_challenges` cannot grow unboundedly.
 * Claims are atomic, so concurrent runs never double-send; a send failure is
 * retried on the next tick; the prune is idempotent.
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
		const prunedChallenges = await deps.credentialVerifier.pruneChallenges(
			deps.clock.now().toISOString(),
		);
		return c.json({ ok: true, sent, prunedChallenges }, 200);
	});
	return app;
}
