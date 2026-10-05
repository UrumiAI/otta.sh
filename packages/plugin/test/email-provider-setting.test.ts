/**
 * The "Email provider" setting on the Settings screen: which provider the store
 * sends through (Resend-shaped, the default, or SMTP2GO) and SMTP2GO's region.
 *
 * Both are saved with the other non-secret payment and email settings, by the
 * same all-or-nothing save: an unknown provider or region is refused, by field
 * name, and nothing in that submit is stored.
 *
 * The key stays in the one write-only email key slot. Its shape check and help
 * text follow the saved provider, so an SMTP2GO key is accepted once SMTP2GO is
 * chosen and the field says where to find one.
 *
 * Driven over a fake kv, like `email-from-setting.test.ts`.
 */
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";
import { describe, expect, test } from "vitest";
import {
	CLEAR_PAYMENT_SECRET_ACTION,
	createSettingsFormHandler,
	SAVE_PAYMENT_SETTINGS_ACTION,
} from "../src/admin/settings-form.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import { EMAIL_FROM_KEY } from "../src/email/ctx-http-email-sender.js";
import { EMAIL_PROVIDER_KEY, SMTP2GO_REGION_KEY } from "../src/email/email-provider.js";
import { checkEmailApiKey, checkSmtp2goApiKey } from "../src/payment-secret-shapes.js";
import { EMAIL_API_KEY_KEY, SMTP2GO_API_KEY_KEY } from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { contextTexts, field, findBlocks, formFor, type LooseBlock } from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

/** A fake key with SMTP2GO's shape. Never a real one. */
const SMTP2GO_KEY = "api-0123456789ABCDEF0123456789ABCDEF";

function refuseStorageCall(): never {
	throw new Error("this suite asserts kv settings, never commerce storage");
}

function makeUnusedStorage(): StorageAccess {
	const collection = new Proxy({} as StorageCollection, { get: () => refuseStorageCall });
	return Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [name, collection]),
	);
}

function makeCtx(seed: Record<string, unknown> = {}): {
	ctx: PluginContext;
	kv: Map<string, unknown>;
} {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		kv: {
			async get<T>(k: string): Promise<T | null> {
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

interface Outcome {
	blocks: LooseBlock[];
	toast?: { message?: string; type?: string };
}

async function invoke(ctx: PluginContext, input: Record<string, unknown>): Promise<Outcome> {
	const handler = createSettingsFormHandler();
	return (await handler({ input, request: req }, ctx)) as unknown as Outcome;
}

function save(ctx: PluginContext, values: Record<string, string>): Promise<Outcome> {
	return invoke(ctx, { type: "form_submit", action_id: SAVE_PAYMENT_SETTINGS_ACTION, values });
}

function saveSmtp2goKey(ctx: PluginContext, value: string): Promise<Outcome> {
	return invoke(ctx, {
		type: "form_submit",
		action_id: "save-smtp2go-api-key",
		values: { smtp2goApiKey: value },
	});
}

function errorBanner(blocks: readonly LooseBlock[]): LooseBlock | undefined {
	return findBlocks(blocks, "banner").find((b) => b.variant === "error");
}

function optionValues(options: unknown): string[] {
	return Array.isArray(options) ? options.map((o: { value: string }) => o.value) : [];
}

function settingsForm(blocks: readonly LooseBlock[]): LooseBlock | undefined {
	return formFor(blocks, SAVE_PAYMENT_SETTINGS_ACTION);
}

describe("Settings: the email provider fields", () => {
	test("render as radios, defaulting to Resend and the global region when nothing is saved", async () => {
		const { ctx } = makeCtx();
		const { blocks } = await invoke(ctx, { type: "page_load" });
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const form = settingsForm(blocks);
		const provider = field(form, "emailProvider");
		expect(provider?.type).toBe("radio");
		expect(provider?.initial_value).toBe("resend");
		expect(optionValues(provider?.options)).toEqual(["resend", "smtp2go"]);
		const region = field(form, "emailSmtp2goRegion");
		expect(region?.type).toBe("radio");
		expect(region?.initial_value).toBe("global");
		expect(optionValues(region?.options)).toEqual(["global", "us", "eu", "au"]);
	});

	test("show what is saved", async () => {
		const { ctx } = makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go", [SMTP2GO_REGION_KEY]: "eu" });
		const form = settingsForm((await invoke(ctx, { type: "page_load" })).blocks);
		expect(field(form, "emailProvider")?.initial_value).toBe("smtp2go");
		expect(field(form, "emailSmtp2goRegion")?.initial_value).toBe("eu");
	});

	test("a valid choice is saved with the rest of the settings", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await save(ctx, {
			emailFrom: "Shop <orders@shop.otta.sh>",
			emailProvider: "smtp2go",
			emailSmtp2goRegion: "au",
		});
		expect(errorBanner(outcome.blocks)).toBeUndefined();
		expect(outcome.toast?.type).toBe("success");
		expect(kv.get(EMAIL_PROVIDER_KEY)).toBe("smtp2go");
		expect(kv.get(SMTP2GO_REGION_KEY)).toBe("au");
		expect(kv.get(EMAIL_FROM_KEY)).toBe("Shop <orders@shop.otta.sh>");
	});

	test("an unknown provider is refused by name, and NOTHING in the submit is saved", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await save(ctx, {
			emailFrom: "orders@shop.otta.sh",
			emailProvider: "carrier-pigeon",
			emailSmtp2goRegion: "eu",
		});
		assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
		const text = JSON.stringify(errorBanner(outcome.blocks));
		expect(text).toContain("Nothing was saved");
		expect(text).toContain("email provider");
		expect(text).not.toContain("carrier-pigeon");
		expect(kv.has(EMAIL_PROVIDER_KEY)).toBe(false);
		expect(kv.has(SMTP2GO_REGION_KEY)).toBe(false);
		expect(kv.has(EMAIL_FROM_KEY)).toBe(false);
	});

	test("an unknown region is refused the same way", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await save(ctx, { emailProvider: "smtp2go", emailSmtp2goRegion: "mars" });
		const text = JSON.stringify(errorBanner(outcome.blocks));
		expect(text).toContain("Nothing was saved");
		expect(text).toContain("SMTP2GO region");
		expect(kv.has(EMAIL_PROVIDER_KEY)).toBe(false);
		expect(kv.has(SMTP2GO_REGION_KEY)).toBe(false);
	});

	test("an empty choice is not a choice: refused, not stored as blank", async () => {
		const { ctx, kv } = makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go" });
		const outcome = await save(ctx, { emailProvider: "" });
		expect(JSON.stringify(errorBanner(outcome.blocks))).toContain("Nothing was saved");
		expect(kv.get(EMAIL_PROVIDER_KEY)).toBe("smtp2go");
	});

	test("a submit without the fields leaves the saved choice alone (absent is not empty)", async () => {
		const { ctx, kv } = makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go", [SMTP2GO_REGION_KEY]: "us" });
		const outcome = await save(ctx, { emailFrom: "orders@shop.otta.sh" });
		expect(errorBanner(outcome.blocks)).toBeUndefined();
		expect(kv.get(EMAIL_PROVIDER_KEY)).toBe("smtp2go");
		expect(kv.get(SMTP2GO_REGION_KEY)).toBe("us");
	});
});

describe("Settings: each provider has its own key field", () => {
	test("SMTP2GO's key shape: api- then letters, digits, _ and -", () => {
		expect(checkSmtp2goApiKey(SMTP2GO_KEY)).toEqual({ ok: true, value: SMTP2GO_KEY });
		expect(checkSmtp2goApiKey("api-abc_DEF-123456").ok).toBe(true);
		const resendKey = checkSmtp2goApiKey("re_0123456789abcdef");
		expect(resendKey.ok).toBe(false);
		if (!resendKey.ok) expect(resendKey.problem).toContain("api-");
		expect(checkSmtp2goApiKey("api-has space").ok).toBe(false);
	});

	test("the Resend check is unchanged, and an SMTP2GO key there is pointed to its own field", () => {
		const url = "https://api.resend.com/emails";
		expect(checkEmailApiKey("re_0123456789abcdef", url).ok).toBe(true);
		const smtp = checkEmailApiKey(SMTP2GO_KEY, url);
		expect(smtp.ok).toBe(false);
		if (!smtp.ok) {
			expect(smtp.problem).toContain("re_");
			expect(smtp.problem).toContain("SMTP2GO API key field");
		}
	});

	test("the SMTP2GO key is saved in ITS slot, never the Resend one", async () => {
		const { ctx, kv } = makeCtx({ [EMAIL_API_KEY_KEY]: "re_0123456789abcdef" });
		const outcome = await saveSmtp2goKey(ctx, `  ${SMTP2GO_KEY}\n`);
		expect(errorBanner(outcome.blocks)).toBeUndefined();
		expect(kv.get(SMTP2GO_API_KEY_KEY)).toBe(SMTP2GO_KEY);
		expect(kv.get(EMAIL_API_KEY_KEY)).toBe("re_0123456789abcdef");
		// Write-only: the value is never rendered back.
		expect(JSON.stringify(outcome.blocks)).not.toContain(SMTP2GO_KEY);
	});

	test("a key of another shape in the SMTP2GO field is refused and never echoed", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await saveSmtp2goKey(ctx, "re_0123456789abcdef");
		expect(JSON.stringify(errorBanner(outcome.blocks))).toContain("Nothing was saved");
		expect(JSON.stringify(outcome.blocks)).not.toContain("re_0123456789abcdef");
		expect(kv.has(SMTP2GO_API_KEY_KEY)).toBe(false);
	});

	test("the SMTP2GO key can be removed on its own", async () => {
		const { ctx, kv } = makeCtx({
			[SMTP2GO_API_KEY_KEY]: SMTP2GO_KEY,
			[EMAIL_API_KEY_KEY]: "re_0123456789abcdef",
		});
		const outcome = await invoke(ctx, {
			type: "block_action",
			action_id: CLEAR_PAYMENT_SECRET_ACTION,
			value: { secret: "smtp2goApiKey" },
		});
		expect(errorBanner(outcome.blocks)).toBeUndefined();
		expect(kv.has(SMTP2GO_API_KEY_KEY)).toBe(false);
		expect(kv.get(EMAIL_API_KEY_KEY)).toBe("re_0123456789abcdef");
	});

	test("both key fields render, each with its own help, and the group label follows the chosen provider", async () => {
		const smtp = makeCtx({
			[EMAIL_PROVIDER_KEY]: "smtp2go",
			[EMAIL_API_KEY_KEY]: "re_0123456789abcdef",
		});
		const { blocks } = await invoke(smtp.ctx, { type: "page_load" });
		expect(
			String(field(formFor(blocks, "save-smtp2go-api-key"), "smtp2goApiKey")?.placeholder),
		).toContain("api-");
		expect(formFor(blocks, "save-email-api-key")).toBeDefined();
		expect(contextTexts(blocks).some((t) => t.includes("SMTP2GO API key allowed to send"))).toBe(
			true,
		);
		// SMTP2GO chosen, only the Resend key saved: email is NOT set up.
		const label = String(
			findBlocks(blocks, "accordion").find((b) => b.block_id === "settings:payments")?.label,
		);
		expect(label).toContain("no email");

		const both = makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go", [SMTP2GO_API_KEY_KEY]: SMTP2GO_KEY });
		const again = await invoke(both.ctx, { type: "page_load" });
		const label2 = String(
			findBlocks(again.blocks, "accordion").find((b) => b.block_id === "settings:payments")?.label,
		);
		expect(label2).toContain("email set");
	});

	test("the Resend radio says it covers a Resend-compatible build URL", async () => {
		const { ctx } = makeCtx();
		const form = settingsForm((await invoke(ctx, { type: "page_load" })).blocks);
		const options = field(form, "emailProvider")?.options as Array<{
			value: string;
			label: string;
		}>;
		expect(options.find((o) => o.value === "resend")?.label).toBe(
			"Resend (or a Resend-compatible URL set at build time)",
		);
	});
});
