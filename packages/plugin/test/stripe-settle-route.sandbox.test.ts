/**
 * The `webhooks/stripe/settle` route under REAL workerd (work order 02, INC-C1b).
 *
 * WHAT ONLY THIS TIER CAN PROVE. The in-process suite beside it proves the
 * handler's logic; it calls the exported factory directly, so it cannot say
 * anything about the route as the SANDBOX sees it. This one boots the production
 * `sandbox-entry.ts` inside the real workerd-on-Node isolate and reaches the route
 * by its registered NAME, which means it proves four things the other tier
 * cannot:
 *
 *  1. The route is actually REGISTERED under `webhooks/stripe/settle` (an
 *     unregistered name is a 404 from the dispatcher, not a handler result).
 *  2. `X-Otta-Wh-Token` SURVIVES the trip: it is attached by the caller, crosses
 *     the HTTP boundary into the isolate, and arrives at the handler intact —
 *     asserted by OUTCOME DIFFERENCE (the same request with a wrong token is
 *     refused and with the right one is admitted), which is only possible if the
 *     header's value genuinely reached the comparison. A header that were
 *     stripped or renamed anywhere in between would collapse both cases to 401.
 *  3. The Stripe HMAC verifies INSIDE the isolate, on workerd's own WebCrypto —
 *     the adapter is bundled (`tsdown.config.ts` `noExternal`), and a bundle that
 *     failed to include it would fail here rather than in production.
 *  4. The whole settle path runs against a real document store on `ctx.storage`.
 *
 * The secrets are provisioned the way an operator provisions them: through the
 * Settings form's own save actions, into the isolate's kv, which also proves that
 * surface writes the key this route reads.
 */
import { signStripeWebhook } from "@otta-sh/payments-stripe";
import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import {
	loadPluginInSandbox,
	productionAllowedHosts,
	type SandboxHandle,
} from "./sandbox/harness.js";

const WEBHOOK_SECRET = "whsec_sandbox_NEVER_LEAK";
const EDGE_TOKEN = "otta_edge_sandbox_NEVER_LEAK";

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;

afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

interface SettleResponse {
	ok: boolean;
	status: number;
	reason?: string;
}

function resultOf(outcome: { result: unknown } | { error: string }): SettleResponse {
	if ("error" in outcome) throw new Error(outcome.error);
	return outcome.result as SettleResponse;
}

async function delivery(orderId: string, opts: { secret?: string } = {}) {
	const signed = await signStripeWebhook(
		{
			eventId: `evt_${orderId}`,
			type: "payment_intent.succeeded",
			paymentIntentId: `pi_${orderId}`,
			orderId,
			amountCents: 1500,
			currency: "usd",
		},
		opts.secret ?? WEBHOOK_SECRET,
	);
	return {
		rawBodyBase64: Buffer.from(signed.body).toString("base64"),
		stripeSignature: signed.signatureHeader,
		idempotencyKey: `wh-${orderId}`,
	};
}

describe("webhooks/stripe/settle under workerd", () => {
	test("the edge token header crosses into the isolate and gates the route end to end", async () => {
		// The stub backs the Settings re-render only; the settle route itself makes
		// no request, and `stub.requests` below says so.
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			// PRODUCTION'S OWN LIST plus the stub, not the stub alone: this suite
			// drives the Stripe settle path, and booting it under a gate that omits
			// `STRIPE_API_HOST` would exercise that path under a narrower allowlist
			// than any deployment has (review round 3, item 1). The stub's host is
			// still the only one anything here actually reaches — asserted below.
			allowedHosts: productionAllowedHosts([stub.host]),
			storage: true,
		});

		// Provision both secrets through the operator's own surface. kv is
		// boot-scoped in the sandbox entry, exactly as the host persists it, so the
		// settle invocations below read what these saves wrote.
		for (const [action, field, value] of [
			["save-webhook-edge-token", "webhookEdgeToken", EDGE_TOKEN],
			["save-stripe-webhook-secret", "stripeWebhookSecret", WEBHOOK_SECRET],
		] as const) {
			const saved = await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: action,
				values: { [field]: value },
			});
			// The provisioning screen never renders a secret back — pinned HERE too,
			// because this is the response an operator's browser actually receives.
			expect(JSON.stringify(saved)).not.toContain(value);
		}

		const signed = await delivery("ord-sandbox");

		// NO header at all: refused.
		expect(resultOf(await sandbox.invokeRoute("webhooks/stripe/settle", signed))).toMatchObject({
			ok: false,
			status: 401,
			reason: "UNAUTHORIZED",
		});

		// The WRONG token: refused. Same bytes, same signature — only the header
		// differs, so this and the case below isolate the header as the variable.
		expect(
			resultOf(
				await sandbox.invokeRoute("webhooks/stripe/settle", signed, {
					headers: { "X-Otta-Wh-Token": "otta_edge_WRONG" },
				}),
			),
		).toMatchObject({ ok: false, status: 401, reason: "UNAUTHORIZED" });

		// The RIGHT token: admitted past the gate — and then the HMAC verifies
		// inside the isolate and the DOMAIN answers. 404 is the domain's own verdict
		// (the order was never seeded), which no request that failed the token gate
		// or the signature check could ever reach.
		expect(
			resultOf(
				await sandbox.invokeRoute("webhooks/stripe/settle", signed, {
					headers: { "X-Otta-Wh-Token": EDGE_TOKEN },
				}),
			),
		).toMatchObject({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });

		// A TAMPERED body with the right token: the HMAC is what stops it.
		const tampered = Buffer.from(
			Buffer.from(signed.rawBodyBase64, "base64").toString("utf8").replace("1500", "1"),
			"utf8",
		).toString("base64");
		expect(
			resultOf(
				await sandbox.invokeRoute(
					"webhooks/stripe/settle",
					{ ...signed, rawBodyBase64: tampered },
					{ headers: { "X-Otta-Wh-Token": EDGE_TOKEN } },
				),
			),
		).toMatchObject({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });

		// Nothing the settle route did reached for the network: every recorded
		// request belongs to the Settings re-render above.
		expect(stub.requests.every((r) => r.method === "GET")).toBe(true);
		// And no response body anywhere carried either secret.
		expect(JSON.stringify(stub.requests)).not.toContain(WEBHOOK_SECRET);
		expect(JSON.stringify(stub.requests)).not.toContain(EDGE_TOKEN);
	}, 180_000);

	test("with NO edge token provisioned the route passes through, and the HMAC still governs", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			// PRODUCTION'S OWN LIST plus the stub, not the stub alone: this suite
			// drives the Stripe settle path, and booting it under a gate that omits
			// `STRIPE_API_HOST` would exercise that path under a narrower allowlist
			// than any deployment has (review round 3, item 1). The stub's host is
			// still the only one anything here actually reaches — asserted below.
			allowedHosts: productionAllowedHosts([stub.host]),
			storage: true,
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-stripe-webhook-secret",
			values: { stripeWebhookSecret: WEBHOOK_SECRET },
		});

		// No token key, no token header: NOT a 401 — the gate degrades to
		// "Stripe HMAC only" rather than locking every webhook out.
		expect(
			resultOf(await sandbox.invokeRoute("webhooks/stripe/settle", await delivery("ord-open"))),
		).toMatchObject({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });

		// ...and that pass-through is NOT a disabled-verification path: a body
		// signed with an attacker's secret is refused just the same.
		expect(
			resultOf(
				await sandbox.invokeRoute(
					"webhooks/stripe/settle",
					await delivery("ord-open", { secret: "whsec_attacker" }),
				),
			),
		).toMatchObject({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });
	}, 180_000);
});
