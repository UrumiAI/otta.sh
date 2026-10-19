/**
 * Issue #497: a site with no usable EMDASH_ENCRYPTION_KEY refuses every payment
 * key save (ADR-0037, fail closed). This suite pins the operator-facing side:
 *
 *  - on a TRUSTED host the Settings page warns before anything is typed, naming
 *    who fixes it and how;
 *  - on a sandboxed host (no view of the host's env) it warns about nothing;
 *  - a refused save says who fixes it and how, and stores nothing.
 *
 * Driven over a fake kv, like `settings-secrets.test.ts`, so what was stored can
 * be read back exactly.
 */
import type { StorageAccess, StorageCollection } from "@urumi.ai/otta-store-emdash";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSettingsFormHandler } from "../src/admin/settings-form.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import { encryptionKeyStatus } from "../src/encryption-key-status.js";
import {
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
} from "../src/payment-secrets.js";
import { setTrustedHost } from "../src/payments/trusted-host.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { findBlocks, type LooseBlock } from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

// Shaped like `emdash secrets generate` output. Not a real key.
const VALID_KEY = ["emdash_enc_v1_", "A".repeat(43)].join("");
const SK_TEST = ["sk_test_", "51QaFixtureKey000000000000"].join("");
const WHSEC = ["whsec_", "0123456789abcdef0123456789abcdef"].join("");

const SECRETS = [
	["save-stripe-secret-key", "stripeSecretKey", STRIPE_SECRET_KEY_KEY, SK_TEST],
	["save-stripe-webhook-secret", "stripeWebhookSecret", STRIPE_WEBHOOK_SECRET_KEY, WHSEC],
	["save-webhook-edge-token", "webhookEdgeToken", WEBHOOK_EDGE_TOKEN_KEY, "edge-0123456789"],
] as const;

function refuseStorageCall(): never {
	throw new Error("this suite asserts kv settings, never commerce storage");
}

function makeUnusedStorage(): StorageAccess {
	const collection = new Proxy({} as StorageCollection, { get: () => refuseStorageCall });
	return Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [name, collection]),
	);
}

/** A fake kv. `refuseSecrets` makes it behave like EmDash's settings layer with
 *  no usable key: a write to a payment key throws before storing anything. */
function makeCtx(options: { refuseSecrets?: boolean } = {}): {
	ctx: PluginContext;
	kv: Map<string, unknown>;
} {
	const kv = new Map<string, unknown>();
	const refused = new Set<string>([
		STRIPE_SECRET_KEY_KEY,
		STRIPE_WEBHOOK_SECRET_KEY,
		WEBHOOK_EDGE_TOKEN_KEY,
	]);
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		kv: {
			async get<T>(k: string): Promise<T | null> {
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				if (options.refuseSecrets === true && refused.has(k)) {
					throw new Error("Plugin secret settings require EMDASH_ENCRYPTION_KEY");
				}
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

interface Outcome {
	blocks: LooseBlock[];
	toast?: { message?: string; type?: string };
}

async function invoke(ctx: PluginContext, input: Record<string, unknown>): Promise<Outcome> {
	const handler = createSettingsFormHandler();
	return (await handler({ input, request: req }, ctx)) as unknown as Outcome;
}

function keyBanner(blocks: readonly LooseBlock[]): LooseBlock | undefined {
	return findBlocks(blocks, "banner").find((b) => b.block_id === "settings:encryption-key");
}

const saved = process.env.EMDASH_ENCRYPTION_KEY;

function setKey(value: string | undefined): void {
	if (value === undefined) delete process.env.EMDASH_ENCRYPTION_KEY;
	else process.env.EMDASH_ENCRYPTION_KEY = value;
}

beforeEach(() => {
	setTrustedHost(true);
	setKey(undefined);
});

afterEach(() => {
	setTrustedHost(false);
	setKey(saved);
});

describe("encryptionKeyStatus", () => {
	test.each([
		[undefined, "missing"],
		["", "missing"],
		[" , ", "missing"],
		[VALID_KEY, "present"],
		// A rotation list, with the whitespace and trailing comma EmDash tolerates.
		[` ${VALID_KEY} , ${VALID_KEY},`, "present"],
		["emdash_enc_v1_replace_me", "malformed"],
		[`${VALID_KEY},not-a-key`, "malformed"],
		// 43 base64url chars, but not a canonical 32-byte encoding: EmDash refuses it.
		[["emdash_enc_v1_", "A".repeat(42), "B"].join(""), "malformed"],
	] as const)("EMDASH_ENCRYPTION_KEY=%j is %s", (value, status) => {
		setKey(value);
		expect(encryptionKeyStatus()).toBe(status);
	});

	test("a sandboxed plugin cannot see the host's env, so it does not guess", () => {
		setTrustedHost(false);
		expect(encryptionKeyStatus()).toBe("unknown");
		setKey(VALID_KEY);
		expect(encryptionKeyStatus()).toBe("unknown");
	});
});

describe("the up-front warning on Settings", () => {
	test("no key: an alert before anything is typed, saying who fixes it and how", async () => {
		const { ctx } = makeCtx();
		const page = await invoke(ctx, { type: "page_load" });
		const banner = keyBanner(page.blocks);
		expect(banner).toMatchObject({
			variant: "alert",
			title: "Payment keys cannot be saved on this site yet",
		});
		const description = String(banner?.description);
		expect(description).toContain("EMDASH_ENCRYPTION_KEY is not set");
		expect(description).toContain("Whoever deployed this site");
		expect(description).toContain("wrangler secret put EMDASH_ENCRYPTION_KEY");
		expect(description).toContain(".env locally");
		expect(description).toContain("DEPLOYMENT.md §3");
		// Before the groups, so it is seen without opening one.
		const accordion = page.blocks.findIndex((b) => b.type === "accordion");
		expect(page.blocks.indexOf(banner as LooseBlock)).toBeLessThan(accordion);
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
	});

	test("a malformed key is named as not valid", async () => {
		setKey("emdash_enc_v1_replace_me");
		const { ctx } = makeCtx();
		const page = await invoke(ctx, { type: "page_load" });
		expect(String(keyBanner(page.blocks)?.description)).toContain(
			"EMDASH_ENCRYPTION_KEY is not a valid key",
		);
		// The key's value never reaches the page.
		expect(JSON.stringify(page)).not.toContain("replace_me");
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
	});

	test("a valid key: no warning", async () => {
		setKey(VALID_KEY);
		const { ctx } = makeCtx();
		const page = await invoke(ctx, { type: "page_load" });
		expect(keyBanner(page.blocks)).toBeUndefined();
		expect(JSON.stringify(page)).not.toContain(VALID_KEY);
	});

	test("a sandboxed plugin: no warning, even with no key in its own env", async () => {
		setTrustedHost(false);
		const { ctx } = makeCtx();
		const page = await invoke(ctx, { type: "page_load" });
		expect(keyBanner(page.blocks)).toBeUndefined();
	});
});

describe("a save the host refuses", () => {
	test.each(SECRETS)(
		"%s: says who fixes it and how, stores nothing, and never echoes the value",
		async (actionId, fieldId, kvKey, value) => {
			const { ctx, kv } = makeCtx({ refuseSecrets: true });
			const outcome = await invoke(ctx, {
				type: "form_submit",
				action_id: actionId,
				values: { [fieldId]: value },
			});
			const error = findBlocks(outcome.blocks, "banner").find((b) => b.variant === "error");
			const description = String(error?.description);
			expect(description).toContain("could not be stored encrypted");
			expect(description).not.toContain("sites/staging");
			expect(description).toContain("Whoever deployed this site sets EMDASH_ENCRYPTION_KEY");
			expect(description).toContain("DEPLOYMENT.md §3");
			expect(description).toContain("Nothing was saved.");
			expect(outcome.toast).toMatchObject({ type: "error" });
			expect(kv.has(kvKey)).toBe(false);
			// No save generation bump either: the field was not cleared as if saved.
			expect([...kv.keys()].some((k) => k.endsWith("Gen"))).toBe(false);
			expect(JSON.stringify(outcome)).not.toContain(value);
			// The refusal and the up-front warning together stay within the budgets.
			assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
		},
	);
});

test("a write that fails with a valid key does not blame the key", async () => {
	setKey(VALID_KEY);
	const { ctx, kv } = makeCtx({ refuseSecrets: true });
	const outcome = await invoke(ctx, {
		type: "form_submit",
		action_id: "save-stripe-secret-key",
		values: { stripeSecretKey: SK_TEST },
	});
	const error = findBlocks(outcome.blocks, "banner").find((b) => b.variant === "error");
	expect(String(error?.description)).toBe(
		"The Stripe secret key could not be saved right now. Try again. Nothing was saved.",
	);
	expect(keyBanner(outcome.blocks)).toBeUndefined();
	expect(kv.has(STRIPE_SECRET_KEY_KEY)).toBe(false);
	assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
});
