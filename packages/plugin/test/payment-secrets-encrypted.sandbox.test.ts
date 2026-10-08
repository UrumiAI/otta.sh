/**
 * ADR-0032 under workerd: the payment keys are READ inside the isolate through
 * the same fail-closed readers after the one-time re-save, and a key the host
 * cannot decrypt is refused rather than used.
 *
 * The encryption itself happens on the host's side of the bridge (EmDash's
 * settings layer), which this harness's kv mirror does not reproduce — the raw
 * row proofs are `sites/staging/test/payment-secrets-at-rest.test.ts` and
 * `packages/store-emdash/test/**plugin-secret-settings*`. What only workerd can
 * show is the plugin side: the cron tick runs the re-save with the host's
 * conditional kv pair, and a REJECTED read (the host's "cannot decrypt")
 * reaches every reader as a refusal.
 */
import { signStripeWebhook } from "@otta-sh/payments-stripe";
import { afterEach, describe, expect, test } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import { startStubHttpServer, type StubHttpServer } from "./helpers/stub-http-server.js";
import {
	loadPluginInSandbox,
	productionAllowedHosts,
	type SandboxHandle,
} from "./sandbox/harness.js";

const WEBHOOK_SECRET = "whsec_sandbox_ENCRYPTED_NEVER_LEAK";
const EDGE_TOKEN = "otta_edge_sandbox_ENCRYPTED_NEVER_LEAK";

let sandbox: SandboxHandle | undefined;
let stub: StubHttpServer | undefined;

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

function resultOf(outcome: { result: unknown } | { error: string }): unknown {
	if ("error" in outcome) throw new Error(outcome.error);
	return outcome.result;
}

async function delivery(orderId: string) {
	const signed = await signStripeWebhook(
		{
			eventId: `evt_${orderId}`,
			type: "payment_intent.succeeded",
			paymentIntentId: `pi_${orderId}`,
			orderId,
			amountCents: 1500,
			currency: "usd",
		},
		WEBHOOK_SECRET,
	);
	return {
		rawBodyBase64: Buffer.from(signed.body).toString("base64"),
		stripeSignature: signed.signatureHeader,
		idempotencyKey: `wh-${orderId}`,
	};
}

async function boot(entry?: string): Promise<SandboxHandle> {
	stub = await startStubHttpServer();
	stub.respondWith("GET", () => ({
		status: 200,
		body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
	}));
	const handle = await loadPluginInSandbox({
		allowedHosts: productionAllowedHosts([stub.host]),
		storage: true,
		...(entry === undefined ? {} : { entry }),
	});
	for (const [action, field, value] of [
		["save-webhook-edge-token", "webhookEdgeToken", EDGE_TOKEN],
		["save-stripe-webhook-secret", "stripeWebhookSecret", WEBHOOK_SECRET],
	] as const) {
		const saved = await handle.invokeRoute("admin", {
			type: "form_submit",
			action_id: action,
			values: { [field]: value },
		});
		expect(JSON.stringify(saved)).not.toContain(value);
	}
	return handle;
}

describe("encrypted payment keys under workerd (ADR-0032)", () => {
	test("after the cron tick's re-save, the settle route still reads both keys", async () => {
		sandbox = await boot();
		const ticked = await sandbox.invokeHook("cron", {
			name: SWEEP_TASK_NAME,
			scheduledAt: new Date().toISOString(),
		});
		expect("error" in ticked ? ticked.error : undefined).toBeUndefined();

		const signed = await delivery("ord-encrypted");
		// Past the token gate AND the HMAC: 404 is the domain's own answer for an
		// order that was never seeded, which neither gate could produce.
		expect(
			resultOf(
				await sandbox.invokeRoute("webhooks/stripe/settle", signed, {
					headers: { "X-Otta-Wh-Token": EDGE_TOKEN },
				}),
			) as SettleResponse,
		).toMatchObject({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });
		expect(
			resultOf(await sandbox.invokeRoute("webhooks/stripe/settle", signed)) as SettleResponse,
		).toMatchObject({ ok: false, status: 401, reason: "UNAUTHORIZED" });
	});

	test("keys the host cannot decrypt: the settle route refuses 503 and never opens the gate", async () => {
		sandbox = await boot("payments/testing/unreadable-secrets-entry.ts");
		const signed = await delivery("ord-unreadable");
		for (const headers of [{ "X-Otta-Wh-Token": EDGE_TOKEN }, {}] as Record<string, string>[]) {
			const result = resultOf(
				await sandbox.invokeRoute("webhooks/stripe/settle", signed, { headers }),
			) as SettleResponse;
			expect(result).toMatchObject({ ok: false, status: 503, reason: "NOT_CONFIGURED" });
			expect(JSON.stringify(result)).not.toContain(EDGE_TOKEN);
		}
	});

	test("keys the host cannot decrypt: the Settings page says so and shows no value", async () => {
		sandbox = await boot("payments/testing/unreadable-secrets-entry.ts");
		const page = resultOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const whole = JSON.stringify(page);
		expect(whole).toContain("Stripe webhook signing secret — saved, but cannot be read");
		expect(whole).toContain("EMDASH_ENCRYPTION_KEY");
		expect(whole).not.toContain(WEBHOOK_SECRET);
		expect(whole).not.toContain(EDGE_TOKEN);
	});
});
