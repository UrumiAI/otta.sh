/**
 * INC-C3 — the payment/email secrets the folded-in commerce layer needs, held
 * in WRITE-ONLY plugin kv exactly as `settings:serviceToken` (ADR-0007) already
 * is, plus the Settings provisioning surface for them.
 *
 * WHERE THE NAMES COME FROM. Every key below is the in-process equivalent of an
 * environment variable `@otta-sh/service` reads TODAY — nothing is invented:
 *  - `settings:stripeSecretKey`        ← `STRIPE_SECRET_KEY`
 *                                        (`packages/service/src/stripe-wiring.ts:7`)
 *  - `settings:stripeWebhookSecret`    ← `STRIPE_WEBHOOK_SECRET`
 *                                        (`packages/service/src/stripe-wiring.ts:6`)
 *  - `settings:emailApiKey`            ← `EMAIL_API_KEY`
 *                                        (`packages/service/src/index.ts:79`,
 *                                         `packages/service/src/worker.ts:72`)
 *  - `settings:x402FacilitatorSecret`  ← `X402_FACILITATOR_SECRET`
 *                                        (`packages/service/src/x402-wiring.ts:6`)
 *
 * The service's NON-secret companions (`EMAIL_API_URL`, `EMAIL_FROM`,
 * `X402_PAYTO`, `X402_ACCEPTS`, `STOREFRONT_BASE_URL`) are deliberately NOT
 * here: this increment is the secret tier only, and a write-only key is the
 * wrong home for a value that has to be readable back into a form.
 *
 * FAIL-CLOSED IS THE POINT (not decoration). Every reader swallows a kv
 * REJECTION to `undefined` — same posture as `serviceTokenFromKv` — so a kv
 * outage degrades to "not configured" (no gateway wired, no email sent, no
 * signature accepted) rather than throwing out of a hook, and never to an empty
 * string that a downstream `!== undefined` check would read as "configured".
 */
import { describe, expect, test } from "vitest";
import {
	constantTimeEquals,
	EMAIL_API_KEY_KEY,
	PAYMENT_SECRET_KEYS,
	readPaymentSecrets,
	readWriteOnlySecret,
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
	webhookEdgeTokenFromKv,
	X402_FACILITATOR_SECRET_KEY,
} from "../src/payment-secrets.js";
import { SERVICE_TOKEN_KEY } from "../src/manifest.js";
import {
	createSettingsFormHandler,
	INTERNAL_TOKEN_KEY,
	PAYMENT_SECRET_ACTION_IDS,
	SETTINGS_ACTION_IDS,
	SETTINGS_SCHEMA,
} from "../src/admin/settings-form.js";
import type { PluginContext } from "../src/types.js";

const req = { method: "POST", url: "/route", headers: {} };

/** A fake ctx with a seeded kv. `failingKeys` makes `kv.get` REJECT for exactly
 *  those keys — the only honest way to prove the fail-closed path, since a
 *  `null` return exercises the "unset" branch instead. */
function makeCtx(
	seed: Record<string, unknown> = {},
	failingKeys: ReadonlySet<string> = new Set(),
): { ctx: PluginContext; kv: Map<string, unknown> } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const ctx: PluginContext = {
		http: {
			fetch: () => Promise.reject(new Error("no egress in this suite")),
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (failingKeys.has(k)) throw new Error(`kv unavailable: ${k}`);
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, kv };
}

describe("the payment/email secret kv keys", () => {
	test("each key is the service env var it replaces, in this repo's settings:* convention", () => {
		expect(STRIPE_SECRET_KEY_KEY).toBe("settings:stripeSecretKey");
		expect(STRIPE_WEBHOOK_SECRET_KEY).toBe("settings:stripeWebhookSecret");
		expect(EMAIL_API_KEY_KEY).toBe("settings:emailApiKey");
		expect(X402_FACILITATOR_SECRET_KEY).toBe("settings:x402FacilitatorSecret");
	});

	test("the INC-C1b edge token key and header are pinned by name", () => {
		// Both names are a CONTRACT with the calling site: it provisions this exact
		// kv key from Settings and attaches this exact header. A rename on either
		// side alone silently turns every forwarded webhook into a 401.
		expect(WEBHOOK_EDGE_TOKEN_KEY).toBe("settings:otta-wh-token");
		expect(WEBHOOK_EDGE_TOKEN_HEADER).toBe("X-Otta-Wh-Token");
	});

	test("PAYMENT_SECRET_KEYS is EXACTLY those five — a sixth needs a deliberate edit here", () => {
		// Exact set, not containment: this list drives the Settings provisioning
		// forms and the no-echo pins below, so an accidentally-added key would
		// otherwise ship an unreviewed secret surface, and an accidentally-dropped
		// one would silently stop being provisionable.
		expect([...PAYMENT_SECRET_KEYS].toSorted()).toEqual(
			[
				EMAIL_API_KEY_KEY,
				STRIPE_SECRET_KEY_KEY,
				STRIPE_WEBHOOK_SECRET_KEY,
				X402_FACILITATOR_SECRET_KEY,
				WEBHOOK_EDGE_TOKEN_KEY,
			].toSorted(),
		);
	});

	test("INC-C1b's dependency: settings:stripeWebhookSecret specifically exists", () => {
		// The settle route INC-C1b builds verifies the Stripe webhook HMAC with
		// THIS key. Pinned by name so a rename is a conscious, cross-increment act.
		expect(PAYMENT_SECRET_KEYS).toContain("settings:stripeWebhookSecret");
	});

	test("no payment secret collides with an existing settings key", () => {
		for (const key of PAYMENT_SECRET_KEYS) {
			expect(key).not.toBe(SERVICE_TOKEN_KEY);
			expect(key).not.toBe(INTERNAL_TOKEN_KEY);
		}
	});
});

describe("readWriteOnlySecret is fail-closed", () => {
	test("returns the stored value when set", async () => {
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: "sk_test_abc" });
		await expect(readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY)).resolves.toBe("sk_test_abc");
	});

	test("an UNSET key is undefined (never null, never '')", async () => {
		const { ctx } = makeCtx();
		await expect(readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY)).resolves.toBeUndefined();
	});

	test("an EMPTY stored value folds to undefined — '' must never read as configured", async () => {
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: "" });
		await expect(readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY)).resolves.toBeUndefined();
	});

	test("a NON-STRING stored value folds to undefined rather than being handed on", async () => {
		// kv is untyped at runtime; a number/object reaching a secret consumer as
		// a "value" is worse than absence.
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: 42 });
		await expect(readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY)).resolves.toBeUndefined();
	});

	test("A KV READ THAT REJECTS is swallowed to undefined — never propagated", async () => {
		const { ctx } = makeCtx(
			{ [STRIPE_SECRET_KEY_KEY]: "sk_live_never_reachable" },
			new Set([STRIPE_SECRET_KEY_KEY]),
		);
		await expect(readWriteOnlySecret(ctx, STRIPE_SECRET_KEY_KEY)).resolves.toBeUndefined();
	});

	test("the rejection's message never carries the secret (error paths leak too)", async () => {
		// The forced failure below throws a message naming the KEY. Assert that
		// whatever escapes the reader carries no VALUE — the same hazard class as
		// the rendered-block pins, on the path nobody looks at.
		const { ctx } = makeCtx(
			{ [STRIPE_WEBHOOK_SECRET_KEY]: "whsec_do_not_leak" },
			new Set([STRIPE_WEBHOOK_SECRET_KEY]),
		);
		let thrown: unknown;
		let result: string | undefined;
		try {
			result = await readWriteOnlySecret(ctx, STRIPE_WEBHOOK_SECRET_KEY);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeUndefined();
		expect(result).toBeUndefined();
	});
});

describe("readPaymentSecrets is fail-closed PER SECRET", () => {
	test("reads every secret that is set", async () => {
		const { ctx } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: "sk_test_abc",
			[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_abc",
			[EMAIL_API_KEY_KEY]: "email_key_abc",
			[X402_FACILITATOR_SECRET_KEY]: "x402_abc",
			[WEBHOOK_EDGE_TOKEN_KEY]: "edge_abc",
		});
		await expect(readPaymentSecrets(ctx)).resolves.toEqual({
			stripeSecretKey: "sk_test_abc",
			stripeWebhookSecret: "whsec_abc",
			emailApiKey: "email_key_abc",
			x402FacilitatorSecret: "x402_abc",
			webhookEdgeToken: "edge_abc",
		});
	});

	test("nothing configured ⇒ every field undefined, and no throw", async () => {
		const { ctx } = makeCtx();
		await expect(readPaymentSecrets(ctx)).resolves.toEqual({
			stripeSecretKey: undefined,
			stripeWebhookSecret: undefined,
			emailApiKey: undefined,
			x402FacilitatorSecret: undefined,
			webhookEdgeToken: undefined,
		});
	});

	test("ONE failing key degrades only itself — the others still resolve", async () => {
		// `Promise.all` over four reads would reject the whole batch on one
		// failure; the per-secret catch is what keeps a Stripe kv blip from also
		// disarming email.
		const { ctx } = makeCtx(
			{
				[STRIPE_SECRET_KEY_KEY]: "sk_test_abc",
				[EMAIL_API_KEY_KEY]: "email_key_abc",
			},
			new Set([STRIPE_SECRET_KEY_KEY]),
		);
		const secrets = await readPaymentSecrets(ctx);
		expect(secrets.stripeSecretKey).toBeUndefined();
		expect(secrets.emailApiKey).toBe("email_key_abc");
	});

	test("EVERY key failing still resolves (a total kv outage is not a throw)", async () => {
		const { ctx } = makeCtx({}, new Set(PAYMENT_SECRET_KEYS));
		await expect(readPaymentSecrets(ctx)).resolves.toEqual({
			stripeSecretKey: undefined,
			stripeWebhookSecret: undefined,
			emailApiKey: undefined,
			x402FacilitatorSecret: undefined,
			webhookEdgeToken: undefined,
		});
	});
});

/**
 * INC-C1b's edge token, whose reader is the same fail-closed
 * `readWriteOnlySecret` and whose comparison is the part that must not be a
 * `===`.
 */
describe("the webhook edge token (INC-C1b)", () => {
	test("webhookEdgeTokenFromKv reads its own key and nothing else", async () => {
		const { ctx } = makeCtx({
			[WEBHOOK_EDGE_TOKEN_KEY]: "edge_abc",
			[STRIPE_WEBHOOK_SECRET_KEY]: "whsec_abc",
		});
		await expect(webhookEdgeTokenFromKv(ctx)).resolves.toBe("edge_abc");
	});

	test("UNSET, EMPTY, NON-STRING and a REJECTING kv all fold to undefined", async () => {
		// All four are one outcome on purpose: the gate reads `undefined` as "the
		// operator never provisioned one" and passes through, so any state that is
		// not a usable token must arrive as exactly that value — an empty string
		// reaching the comparison would make "" the accepted token.
		await expect(webhookEdgeTokenFromKv(makeCtx().ctx)).resolves.toBeUndefined();
		await expect(
			webhookEdgeTokenFromKv(makeCtx({ [WEBHOOK_EDGE_TOKEN_KEY]: "" }).ctx),
		).resolves.toBeUndefined();
		await expect(
			webhookEdgeTokenFromKv(makeCtx({ [WEBHOOK_EDGE_TOKEN_KEY]: 42 }).ctx),
		).resolves.toBeUndefined();
		await expect(
			webhookEdgeTokenFromKv(
				makeCtx({ [WEBHOOK_EDGE_TOKEN_KEY]: "edge_never" }, new Set([WEBHOOK_EDGE_TOKEN_KEY])).ctx,
			),
		).resolves.toBeUndefined();
	});
});

describe("constantTimeEquals", () => {
	// WHY NOT `===`: string equality returns at the first differing byte, so the
	// time it takes leaks how much of a guess was right, one character per
	// request. This comparison XORs EVERY byte of an equal-length pair and never
	// exits early. `node:crypto.timingSafeEqual` is not an option — the plugin
	// runs in workerd, where `node:crypto` is not importable.
	test("is true only for an exact match", () => {
		expect(constantTimeEquals("otta_edge_abc", "otta_edge_abc")).toBe(true);
		expect(constantTimeEquals("", "")).toBe(true);
	});

	test("is false for a differing byte at any position — first, middle or last", () => {
		expect(constantTimeEquals("Xbcdef", "abcdef")).toBe(false);
		expect(constantTimeEquals("abcXef", "abcdef")).toBe(false);
		expect(constantTimeEquals("abcdeX", "abcdef")).toBe(false);
	});

	test("is false for a prefix, a suffix and any other length mismatch", () => {
		expect(constantTimeEquals("abcde", "abcdef")).toBe(false);
		expect(constantTimeEquals("abcdefg", "abcdef")).toBe(false);
		expect(constantTimeEquals("", "abcdef")).toBe(false);
		expect(constantTimeEquals("abcdef", "")).toBe(false);
	});

	test("compares BYTES, not UTF-16 code units (a multi-byte token still works)", () => {
		expect(constantTimeEquals("tökén-π", "tökén-π")).toBe(true);
		expect(constantTimeEquals("tökén-π", "tökén-p")).toBe(false);
	});

	test("does not exit early: every byte of an equal-length pair is examined", () => {
		// Behavioural proxy for the timing property, which cannot be asserted
		// directly without a flaky clock: two same-length inputs differing ONLY in
		// the final byte must still be false, and the accumulate-then-compare shape
		// is what makes the work identical to the all-match case.
		const long = "a".repeat(4096);
		expect(constantTimeEquals(long, long)).toBe(true);
		expect(constantTimeEquals(`${long.slice(0, -1)}b`, long)).toBe(false);
	});
});

/**
 * The Settings provisioning surface, held to the SAME write-only discipline as
 * the two connection tokens (`service-token-kv-wiring.test.ts`): persist only on
 * a non-empty submit, never render the value back into any block or toast.
 */
describe("Settings provisioning of the payment/email secrets (write-only)", () => {
	const CASES = [
		["save-stripe-secret-key", "stripeSecretKey", STRIPE_SECRET_KEY_KEY, "sk_live_NEVER_RENDER"],
		[
			"save-stripe-webhook-secret",
			"stripeWebhookSecret",
			STRIPE_WEBHOOK_SECRET_KEY,
			"whsec_NEVER_RENDER",
		],
		["save-email-api-key", "emailApiKey", EMAIL_API_KEY_KEY, "email_NEVER_RENDER"],
		[
			"save-webhook-edge-token",
			"webhookEdgeToken",
			WEBHOOK_EDGE_TOKEN_KEY,
			"otta_edge_NEVER_RENDER",
		],
		[
			"save-x402-facilitator-secret",
			"x402FacilitatorSecret",
			X402_FACILITATOR_SECRET_KEY,
			"x402_NEVER_RENDER",
		],
	] as const;

	test("every payment-secret action id is routable (the dispatcher recognizes it)", () => {
		for (const [actionId] of CASES) {
			expect(SETTINGS_ACTION_IDS.has(actionId)).toBe(true);
			expect(PAYMENT_SECRET_ACTION_IDS.has(actionId)).toBe(true);
		}
	});

	test.each(CASES)(
		"%s persists ONLY to its own key and is never rendered back",
		async (actionId, fieldId, kvKey, value) => {
			const { ctx, kv } = makeCtx();
			const res = await createSettingsFormHandler()(
				{ input: { action_id: actionId, values: { [fieldId]: value } }, request: req },
				ctx,
			);
			expect(kv.get(kvKey)).toBe(value);
			// The WHOLE response — blocks, labels, notices, toast — never echoes it.
			expect(JSON.stringify(res)).not.toContain(value);
			// And it lives in EXACTLY its own key: no gen counter, no other secret,
			// no display name quietly carrying a copy.
			for (const [key, stored] of kv.entries()) {
				if (key !== kvKey) expect(JSON.stringify(stored)).not.toContain(value);
			}
		},
	);

	test.each(CASES)(
		"a blank %s submit does NOT clobber the stored secret",
		async (actionId, fieldId, kvKey, value) => {
			const { ctx, kv } = makeCtx({ [kvKey]: value });
			await createSettingsFormHandler()(
				{ input: { action_id: actionId, values: { [fieldId]: "" } }, request: req },
				ctx,
			);
			expect(kv.get(kvKey)).toBe(value);
		},
	);

	test("a PAGE LOAD with every secret set renders none of them", async () => {
		const seed = Object.fromEntries(CASES.map(([, , kvKey, value]) => [kvKey, value]));
		const { ctx } = makeCtx(seed);
		const res = await createSettingsFormHandler()(
			{ input: { type: "page_load", action_id: undefined }, request: req },
			ctx,
		);
		const whole = JSON.stringify(res);
		for (const [, , , value] of CASES) expect(whole).not.toContain(value);
	});

	test("the rendered secret fields are plain, always-empty text_inputs (INC-09 discipline)", async () => {
		const seed = Object.fromEntries(CASES.map(([, , kvKey, value]) => [kvKey, value]));
		const { ctx } = makeCtx(seed);
		const res = await createSettingsFormHandler()(
			{ input: { type: "page_load" }, request: req },
			ctx,
		);
		const fields = collectFields(res);
		for (const [, fieldId] of CASES) {
			const found = fields.find((f) => f["action_id"] === fieldId);
			expect(found, `no rendered field for ${fieldId}`).toBeDefined();
			expect(found?.["type"]).toBe("text_input");
			expect(found).not.toHaveProperty("initial_value");
			expect(found).not.toHaveProperty("has_value");
		}
	});

	test("a kv OUTAGE on every secret still renders the page (fail-closed, not a throw)", async () => {
		const { ctx } = makeCtx({}, new Set(PAYMENT_SECRET_KEYS));
		const res = await createSettingsFormHandler()(
			{ input: { type: "page_load" }, request: req },
			ctx,
		);
		// The screen must still be usable — a kv blip must not lock an operator out
		// of the very form they would use to re-provision.
		expect(collectFields(res).some((f) => f["action_id"] === "stripeSecretKey")).toBe(true);
	});

	test("no payment secret sneaks into the DECLARED settings schema", () => {
		// The schema is the manifest-visible, readable-back tier. Secrets bypass it
		// entirely (same rule the two connection tokens follow).
		for (const name of Object.keys(SETTINGS_SCHEMA)) {
			expect([
				"stripeSecretKey",
				"stripeWebhookSecret",
				"emailApiKey",
				"x402FacilitatorSecret",
				"webhookEdgeToken",
			]).not.toContain(name);
		}
	});
});

/** Every `fields` entry anywhere in a block response, flattened. */
function collectFields(value: unknown): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (Array.isArray(record["fields"])) {
			for (const field of record["fields"] as unknown[]) {
				if (field !== null && typeof field === "object") out.push(field as Record<string, unknown>);
			}
		}
		for (const child of Object.values(record)) walk(child);
	};
	walk(value);
	return out;
}
