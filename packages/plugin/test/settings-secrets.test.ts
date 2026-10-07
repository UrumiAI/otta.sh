/**
 * U-8 (QA 2026-10-02): the payment keys on the Settings screen.
 *
 * QA found every key saved exactly as typed (surrounding spaces included, any
 * shape at all), rendered as a plain text box, with no way to tell a set key
 * from an unset one, and a group label that listed only the optional
 * credentials that were missing. This suite pins the fix:
 *
 *  - a key is TRIMMED, then checked for the shape its provider issues, and a
 *    wrong shape is refused naming the field — never echoing the value;
 *  - every key field is a password input (`secret_input`) whose label says
 *    "set" or "not set", and nothing about the value;
 *  - a set key can be removed on purpose;
 *  - the group label states what card checkout and email actually have (email:
 *    whether the EmDash host hands over `ctx.email`, ADR-0031).
 *
 * Driven over a fake kv: kv is the only
 * store these settings touch, and a fake kv is the only way to read back
 * exactly what was stored (the sandbox suite cannot see kv).
 */
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";
import { describe, expect, test } from "vitest";
import { createSettingsFormHandler } from "../src/admin/settings-form.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import {
	checkOpaqueToken,
	checkStripeSecretKey,
	checkStripeWebhookSecret,
	stripeKeyMode,
} from "../src/payment-secret-shapes.js";
import {
	STRIPE_SECRET_KEY_KEY,
	STRIPE_WEBHOOK_SECRET_KEY,
	WEBHOOK_EDGE_TOKEN_KEY,
	X402_FACILITATOR_API_KEY_KEY,
} from "../src/payment-secrets.js";
import { X402_PAYTO_KEY } from "../src/payments/x402-wiring.js";
import { LOGIN_LINK_URL_KEY } from "../src/storefront/login-link.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { contextTexts, field, findBlocks, formFor, type LooseBlock } from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

// Fixtures in the shapes the providers issue. None is a real credential.
const SK_TEST = ["sk_test_", "51QaFixtureKey000000000000"].join("");
const SK_LIVE = ["sk_live_", "51QaFixtureKey000000000000"].join("");
const RK_TEST = ["rk_test_", "51QaFixtureKey000000000000"].join("");
const WHSEC = ["whsec_", "0123456789abcdef0123456789abcdef"].join("");

function refuseStorageCall(): never {
	throw new Error("this suite asserts kv settings, never commerce storage");
}

function makeUnusedStorage(): StorageAccess {
	const collection = new Proxy({} as StorageCollection, { get: () => refuseStorageCall });
	return Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [name, collection]),
	);
}

function makeCtx(
	seed: Record<string, unknown> = {},
	options: { email?: boolean } = {},
): {
	ctx: PluginContext;
	kv: Map<string, unknown>;
} {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		// The EmDash host's email pipeline (ADR-0031): present only when a provider is.
		...(options.email === true
			? { email: { send: () => Promise.reject(new Error("no sends in this suite")) } }
			: {}),
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

function saveSecret(
	ctx: PluginContext,
	actionId: string,
	fieldId: string,
	value: string,
): Promise<Outcome> {
	return invoke(ctx, { type: "form_submit", action_id: actionId, values: { [fieldId]: value } });
}

function errorBanner(blocks: readonly LooseBlock[]): LooseBlock | undefined {
	return findBlocks(blocks, "banner").find((b) => b.variant === "error");
}

function paymentsLabel(blocks: readonly LooseBlock[]): string {
	return String(
		findBlocks(blocks, "accordion").find((a) => a.block_id === "settings:payments")?.label,
	);
}

/** Every secret on the screen: [submit id, field id, kv key, a value of the right shape]. */
const SECRETS = [
	["save-stripe-secret-key", "stripeSecretKey", STRIPE_SECRET_KEY_KEY, SK_TEST],
	["save-stripe-webhook-secret", "stripeWebhookSecret", STRIPE_WEBHOOK_SECRET_KEY, WHSEC],
	[
		"save-x402-facilitator-secret",
		"x402FacilitatorSecret",
		X402_FACILITATOR_API_KEY_KEY,
		"fac_0123456789",
	],
	["save-webhook-edge-token", "webhookEdgeToken", WEBHOOK_EDGE_TOKEN_KEY, "edge-0123456789"],
] as const;

describe("key shapes", () => {
	test.each([SK_TEST, SK_LIVE, RK_TEST, ["rk_live_", "51QaFixtureKey000000000000"].join("")])(
		"a Stripe secret key %s is accepted",
		(value) => {
			expect(checkStripeSecretKey(value)).toEqual({ ok: true, value });
		},
	);

	test.each([
		// A publishable key is the commonest paste into this field.
		"pk_test_51QaFixtureKey000000000000",
		"pk_live_51QaFixtureKey000000000000",
		WHSEC,
		"sk_test_",
		"sk_test_short",
		"sk_prod_51QaFixtureKey000000000000",
		["sk_test_", "51QaFixture Key000000000000"].join(""),
		"not a key",
	])("a Stripe secret key %s is refused", (value) => {
		const checked = checkStripeSecretKey(value);
		expect(checked.ok).toBe(false);
		// The reason names the shape, never the value (a bare prefix is part of
		// the shape, so it is the one value the reason may contain).
		if (!checked.ok && value !== "sk_test_") expect(checked.problem).not.toContain(value);
	});

	test("surrounding whitespace is trimmed before the check, and the trimmed value is what is kept", () => {
		expect(checkStripeSecretKey(`  ${SK_TEST}\n`)).toEqual({ ok: true, value: SK_TEST });
		expect(checkStripeWebhookSecret(`\t${WHSEC} `)).toEqual({ ok: true, value: WHSEC });
	});

	test("the Stripe mode is read from the key's prefix", () => {
		expect(stripeKeyMode(SK_TEST)).toBe("test");
		expect(stripeKeyMode(RK_TEST)).toBe("test");
		expect(stripeKeyMode(SK_LIVE)).toBe("live");
		expect(stripeKeyMode("legacy-unchecked-value")).toBeUndefined();
	});

	test.each([WHSEC, ["whsec_", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"].join("")])(
		"a webhook signing secret %s is accepted",
		(value) => {
			expect(checkStripeWebhookSecret(value).ok).toBe(true);
		},
	);

	test.each([
		SK_TEST,
		"whsec_",
		"whsec_short",
		"we_0123456789abcdef",
		["whsec_", "0123 456789abcdef"].join(""),
	])("a webhook signing secret %s is refused", (value) => {
		expect(checkStripeWebhookSecret(value).ok).toBe(false);
	});

	test.each(["has space", "tab\there", "line\nbreak", "é-not-ascii", "x".repeat(513)])(
		"an opaque token %j is refused",
		(value) => {
			expect(checkOpaqueToken(value).ok).toBe(false);
		},
	);
});

describe("Settings: saving a payment key", () => {
	test("each key is trimmed before it is stored", async () => {
		for (const [actionId, fieldId, kvKey, value] of SECRETS) {
			const { ctx, kv } = makeCtx();
			const outcome = await saveSecret(ctx, actionId, fieldId, `  ${value}\n`);
			expect(errorBanner(outcome.blocks), actionId).toBeUndefined();
			expect(kv.get(kvKey), actionId).toBe(value);
		}
	});

	test("a key of the wrong shape is refused naming the field, nothing is stored, and the value is never echoed", async () => {
		const wrong: ReadonlyArray<readonly [string, string, string, string, RegExp]> = [
			[
				"save-stripe-secret-key",
				"stripeSecretKey",
				STRIPE_SECRET_KEY_KEY,
				"pk_test_51QaFixtureKey000000000000",
				/Stripe secret key/,
			],
			[
				"save-stripe-webhook-secret",
				"stripeWebhookSecret",
				STRIPE_WEBHOOK_SECRET_KEY,
				SK_TEST,
				/webhook signing secret/i,
			],
			[
				"save-x402-facilitator-secret",
				"x402FacilitatorSecret",
				X402_FACILITATOR_API_KEY_KEY,
				"two words",
				/x402/,
			],
			[
				"save-webhook-edge-token",
				"webhookEdgeToken",
				WEBHOOK_EDGE_TOKEN_KEY,
				"two words",
				/edge token/i,
			],
		];
		for (const [actionId, fieldId, kvKey, value, names] of wrong) {
			const { ctx, kv } = makeCtx();
			const outcome = await saveSecret(ctx, actionId, fieldId, value);
			assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
			const banner = errorBanner(outcome.blocks);
			expect(banner, actionId).toBeDefined();
			expect(`${String(banner?.title)} ${String(banner?.description)}`).toMatch(names);
			expect(String(banner?.description)).toContain("Nothing was saved");
			expect(outcome.toast?.type).toBe("error");
			expect(JSON.stringify(outcome)).not.toContain(value);
			expect(kv.has(kvKey), actionId).toBe(false);
		}
	});

	test("a refused key leaves the key already stored in place", async () => {
		const { ctx, kv } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST });
		await saveSecret(
			ctx,
			"save-stripe-secret-key",
			"stripeSecretKey",
			"pk_live_51QaFixtureKey000000000000",
		);
		expect(kv.get(STRIPE_SECRET_KEY_KEY)).toBe(SK_TEST);
	});

	test("a blank (or whitespace-only) submit keeps the stored key and says nothing was entered", async () => {
		const { ctx, kv } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST });
		for (const blank of ["", "   "]) {
			const outcome = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", blank);
			expect(errorBanner(outcome.blocks)).toBeUndefined();
			expect(String(findBlocks(outcome.blocks, "banner")[0]?.title)).toBe(
				"Nothing entered — Stripe secret key unchanged",
			);
			expect(kv.get(STRIPE_SECRET_KEY_KEY)).toBe(SK_TEST);
		}
	});
});

describe("Settings: how a key field renders", () => {
	test("every key is a password input with a set / not set status and no value", async () => {
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST });
		const page = await invoke(ctx, { type: "page_load", page: "/settings" });
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
		for (const [actionId, fieldId] of SECRETS) {
			const input = field(formFor(page.blocks, actionId), fieldId);
			expect(input?.type, actionId).toBe("secret_input");
			expect(input).not.toHaveProperty("initial_value");
			// `has_value` would make the host draw a fake "••••••••" value; the
			// label carries the status instead.
			expect(input).not.toHaveProperty("has_value");
		}
		const stripe = field(formFor(page.blocks, "save-stripe-secret-key"), "stripeSecretKey");
		expect(stripe?.label).toBe("Stripe secret key — set");
		expect(String(stripe?.placeholder)).toMatch(/leave blank to keep/i);
		const webhook = field(
			formFor(page.blocks, "save-stripe-webhook-secret"),
			"stripeWebhookSecret",
		);
		expect(webhook?.label).toBe("Stripe webhook signing secret — not set");
		expect(String(webhook?.placeholder)).toContain("whsec_");
		expect(JSON.stringify(page)).not.toContain(SK_TEST);
	});

	test("the payments group label states the truth about card checkout and email", async () => {
		const fresh = await invoke(makeCtx().ctx, { type: "page_load", page: "/settings" });
		expect(paymentsLabel(fresh.blocks)).toBe(
			"Payments & email — no Stripe key · no webhook · no email",
		);

		const testMode = await invoke(
			makeCtx(
				{
					[STRIPE_SECRET_KEY_KEY]: SK_TEST,
					[STRIPE_WEBHOOK_SECRET_KEY]: WHSEC,
				},
				{ email: true },
			).ctx,
			{ type: "page_load", page: "/settings" },
		);
		expect(paymentsLabel(testMode.blocks)).toBe(
			"Payments & email — Stripe test · webhook set · email set",
		);

		const live = await invoke(makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_LIVE }).ctx, {
			type: "page_load",
			page: "/settings",
		});
		expect(paymentsLabel(live.blocks)).toBe(
			"Payments & email — Stripe live · no webhook · no email",
		);

		// A key stored before shapes were checked still reads as set, without a mode.
		const legacy = await invoke(makeCtx({ [STRIPE_SECRET_KEY_KEY]: "legacy-unchecked" }).ctx, {
			type: "page_load",
			page: "/settings",
		});
		expect(paymentsLabel(legacy.blocks)).toBe(
			"Payments & email — Stripe key set · no webhook · no email",
		);
	});

	test("one email status line: via EmDash, or no provider with a pointer to the guide (ADR-0031)", async () => {
		const none = await invoke(makeCtx().ctx, { type: "page_load", page: "/settings" });
		const noneText = contextTexts(none.blocks).join("\n");
		expect(noneText).toContain(
			"Email: no EmDash email provider. Order emails wait up to 72 h, then are skipped; sign-in links are not sent.",
		);
		expect(noneText).not.toContain("queued");
		expect(noneText).toContain("docs/email-providers.md");
		const via = await invoke(makeCtx({}, { email: true }).ctx, {
			type: "page_load",
			page: "/settings",
		});
		const viaText = contextTexts(via.blocks).join("\n");
		expect(viaText).toContain("sent via EmDash");
		expect(viaText).not.toContain("docs/email-providers.md");
		// A sandboxed host always hands over `ctx.email`; once it has answered "no
		// email provider" the line says so (ADR-0031).
		const answered = await invoke(
			makeCtx({ "state:emailTransportUnavailableAt": new Date().toISOString() }, { email: true })
				.ctx,
			{ type: "page_load", page: "/settings" },
		);
		expect(contextTexts(answered.blocks).join("\n")).toContain("no EmDash email provider");
		// No email key, from-address, provider or region field is left on the screen.
		for (const page of [none, via]) {
			const ids = JSON.stringify(page).match(/"action_id":"[^"]*"/g) ?? [];
			for (const id of ids) expect(id).not.toMatch(/email|smtp/i);
		}
	});

	test("the label follows a save on the same response", async () => {
		const { ctx } = makeCtx();
		const saved = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", SK_LIVE);
		expect(paymentsLabel(saved.blocks)).toBe(
			"Payments & email — Stripe live · no webhook · no email",
		);
		expect(field(formFor(saved.blocks, "save-stripe-secret-key"), "stripeSecretKey")?.label).toBe(
			"Stripe secret key — set",
		);
		expect(JSON.stringify(saved)).not.toContain(SK_LIVE);
	});

	test("submit buttons and notices name the key the way the operator reads it", async () => {
		const { ctx } = makeCtx();
		const saved = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", SK_TEST);
		expect(formFor(saved.blocks, "save-stripe-secret-key")?.submit).toMatchObject({
			label: "Save Stripe secret key",
		});
		const banner = findBlocks(saved.blocks, "banner")[0];
		expect(String(banner?.title)).toBe("Stripe secret key saved");
		expect(String(banner?.description)).not.toMatch(/write-only/i);
	});
});

describe("Settings: removing a key", () => {
	const CLEAR = "clear-payment-secret";

	function removeButtons(blocks: readonly LooseBlock[]): LooseBlock[] {
		return findBlocks(blocks, "actions").flatMap((a) =>
			(a.elements as LooseBlock[]).filter((e) => e.action_id === CLEAR),
		);
	}

	test("only a set key offers a Remove button, and it asks first", async () => {
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST });
		const page = await invoke(ctx, { type: "page_load", page: "/settings" });
		const buttons = removeButtons(page.blocks);
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.value).toEqual({ secret: "stripeSecretKey" });
		expect(buttons[0]?.style).toBe("danger");
		expect(buttons[0]?.confirm).toMatchObject({ style: "danger" });
		const confirm = buttons[0]?.confirm as { title?: string } | undefined;
		expect(String(confirm?.title)).toContain("Stripe secret key");
	});

	test("removing a key deletes only that key", async () => {
		const { ctx, kv } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SK_TEST,
			[STRIPE_WEBHOOK_SECRET_KEY]: WHSEC,
		});
		const outcome = await invoke(ctx, {
			type: "block_action",
			action_id: CLEAR,
			value: { secret: "stripeSecretKey" },
		});
		assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
		expect(kv.has(STRIPE_SECRET_KEY_KEY)).toBe(false);
		expect(kv.get(STRIPE_WEBHOOK_SECRET_KEY)).toBe(WHSEC);
		expect(String(findBlocks(outcome.blocks, "banner")[0]?.title)).toBe(
			"Stripe secret key removed",
		);
		expect(outcome.toast).toEqual({ message: "Stripe secret key removed", type: "success" });
		expect(paymentsLabel(outcome.blocks)).toBe(
			"Payments & email — no Stripe key · webhook set · no email",
		);
		expect(removeButtons(outcome.blocks)).toHaveLength(1);
	});

	test("a remove naming no known key changes nothing and says so", async () => {
		const { ctx, kv } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST });
		for (const value of [{ secret: "storeDisplayName" }, undefined, "stripeSecretKey"]) {
			const outcome = await invoke(ctx, { type: "block_action", action_id: CLEAR, value });
			const banner = errorBanner(outcome.blocks);
			expect(banner).toBeDefined();
			expect(String(banner?.description)).toContain("Nothing was removed");
		}
		expect(kv.get(STRIPE_SECRET_KEY_KEY)).toBe(SK_TEST);
	});
});

// -- review nits (round 1) --------------------------------------------------------

describe("Settings: review nits", () => {
	test("each key's expected shape is visible help text, not only a placeholder", async () => {
		const page = await invoke(makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST }).ctx, {
			type: "page_load",
			page: "/settings",
		});
		const help = contextTexts(page.blocks).join("\n");
		// Shown whether or not the key is set — a set key's placeholder no longer
		// carries the shape.
		expect(help).toContain("Starts with sk_live_ or sk_test_");
		expect(help).toContain("Starts with whsec_");
	});

	test("Remove on a key that is not stored says so, and claims no removal", async () => {
		const { ctx } = makeCtx();
		const outcome = await invoke(ctx, {
			type: "block_action",
			action_id: "clear-payment-secret",
			value: { secret: "stripeSecretKey" },
		});
		const banner = findBlocks(outcome.blocks, "banner")[0];
		expect(String(banner?.title)).toBe("No Stripe secret key was stored — nothing was removed.");
		expect(banner?.variant).toBe("default");
		// One statement of it, not three: no description repeating the title.
		expect(banner?.description).toBeUndefined();
		expect(outcome.toast).toEqual({ message: "Nothing removed", type: "info" });
	});

	test("after Remove, the notice says where to find the key again", async () => {
		const stripe = await invoke(makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_TEST }).ctx, {
			type: "block_action",
			action_id: "clear-payment-secret",
			value: { secret: "stripeSecretKey" },
		});
		expect(String(findBlocks(stripe.blocks, "banner")[0]?.description)).toContain(
			"Stripe Dashboard → Developers → API keys",
		);
		const webhook = await invoke(makeCtx({ [STRIPE_WEBHOOK_SECRET_KEY]: WHSEC }).ctx, {
			type: "block_action",
			action_id: "clear-payment-secret",
			value: { secret: "stripeWebhookSecret" },
		});
		expect(String(findBlocks(webhook.blocks, "banner")[0]?.description)).toContain(
			"your webhook endpoint in the Stripe Dashboard (Developers or Workbench → Webhooks) → Signing secret",
		);
		assertBlockContract(webhook.blocks, { screen: "settings", level: "list" });
	});

	test("a stored clear-text sign-in page saved before the https rule is flagged, not blocked", async () => {
		const flagged = await invoke(
			makeCtx({ [LOGIN_LINK_URL_KEY]: "http://shop.otta.sh/account/verify" }).ctx,
			{ type: "page_load", page: "/settings" },
		);
		assertBlockContract(flagged.blocks, { screen: "settings", level: "list" });
		const warning = findBlocks(flagged.blocks, "banner").find((b) => b.variant === "alert");
		expect(String(warning?.description)).toContain(
			"The links in sign-in emails point to an http page, so their tokens travel unencrypted when clicked — change this address to https. You'll need to change it before saving other payment settings.",
		);

		for (const fine of [
			"https://shop.otta.sh/account/verify",
			"http://localhost:4700/account/verify",
			"",
		]) {
			const page = await invoke(makeCtx({ [LOGIN_LINK_URL_KEY]: fine }).ctx, {
				type: "page_load",
				page: "/settings",
			});
			expect(JSON.stringify(page), fine).not.toContain("travel unencrypted");
		}
	});

	test("a payment-settings refusal names EVERY problem and keeps what was typed", async () => {
		const { ctx, kv } = makeCtx();
		const typed = {
			loginLinkUrl: "http://shop.otta.sh/account/verify",
			x402PayTo: "my-wallet",
			x402Accepts: "eip155:8453",
		};
		const outcome = await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: typed,
		});
		assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
		const banner = findBlocks(outcome.blocks, "banner").find((b) => b.variant === "error");
		const description = String(banner?.description);
		expect(description).toContain("x402 destination wallet");
		expect(description).toContain("sign-in page address");
		expect(description).toContain("Nothing was saved");
		// Each rule is stated in full beside the form.
		const help = contextTexts(outcome.blocks).join("\n");
		expect(help).toContain("0x followed by 40 hex characters");
		expect(help).toContain("https://");
		// J6: the form keeps exactly what was typed.
		const form = formFor(outcome.blocks, "save-payment-settings");
		for (const [fieldId, value] of Object.entries(typed)) {
			expect(field(form, fieldId)?.initial_value, fieldId).toBe(value);
		}
		for (const key of [LOGIN_LINK_URL_KEY, X402_PAYTO_KEY]) {
			expect(kv.has(key), key).toBe(false);
		}
	});

	test("a refused sign-in address is put back WITHOUT any user:pw@ credentials", async () => {
		const { ctx } = makeCtx();
		const outcome = await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { loginLinkUrl: "https://user:pw@shop.otta.sh/account/verify?x=1" },
		});
		const form = formFor(outcome.blocks, "save-payment-settings");
		expect(field(form, "loginLinkUrl")?.initial_value).toBe(
			"https://shop.otta.sh/account/verify?x=1",
		);
		expect(JSON.stringify(outcome)).not.toContain("user:pw");
	});
});

/**
 * Issue #382: saving the Stripe secret key reads the account's country once
 * (`GET /v1/account`), and the Payments group states it — read-only — so a
 * merchant on an India account sees why checkout asks every buyer for an
 * address, and a merchant whose restricted key cannot read it sees what to do.
 */
function countryLine(blocks: readonly LooseBlock[]): string | undefined {
	return contextTexts(blocks).find((text) => text.startsWith("Stripe account"));
}

describe("Settings: the Stripe account's country", () => {
	function withStripe(
		answer: { status: number; body: unknown },
		seed: Record<string, unknown> = {},
	): { ctx: PluginContext; kv: Map<string, unknown>; urls: string[] } {
		const made = makeCtx(seed);
		const urls: string[] = [];
		made.ctx.http = {
			async fetch(url) {
				urls.push(url);
				return new Response(JSON.stringify(answer.body), { status: answer.status });
			},
		};
		return { ...made, urls };
	}

	test("saving the key reads the country once, and an India account says checkout asks for the address", async () => {
		const { ctx, urls } = withStripe({ status: 200, body: { id: "acct_1", country: "IN" } });
		const saved = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", SK_TEST);
		expect(urls).toEqual(["https://api.stripe.com/v1/account"]);
		expect(countryLine(saved.blocks)).toBe(
			"Stripe account country: India (IN). Checkout asks every buyer for their name and address — Stripe accounts in India need them. A restricted key needs write access to customers.",
		);
		// The page load shows the cached answer and asks Stripe nothing.
		const page = await invoke(ctx, { type: "page_load", page: "/settings" });
		expect(countryLine(page.blocks)).toContain("India (IN)");
		expect(urls).toHaveLength(1);
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
	});

	test("another country is stated plainly", async () => {
		const { ctx } = withStripe({ status: 200, body: { country: "US" } });
		const saved = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", SK_LIVE);
		expect(countryLine(saved.blocks)).toBe("Stripe account country: United States (US).");
	});

	test("a restricted key without account read (403) is named, with what to do", async () => {
		const { ctx } = withStripe({ status: 403, body: { error: { type: "invalid_request_error" } } });
		const saved = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", RK_TEST);
		expect(countryLine(saved.blocks)).toBe(
			"Stripe account country: unknown — this restricted key can't read account details. If your account is in India, give it read access to account details and write access to customers, then save it again.",
		);
	});

	test("Stripe unreachable at save: the save still succeeds, and the line says it will be checked", async () => {
		const { ctx, kv } = makeCtx();
		const saved = await saveSecret(ctx, "save-stripe-secret-key", "stripeSecretKey", SK_TEST);
		expect(kv.get("settings:stripeSecretKey")).toBe(SK_TEST);
		expect(saved.toast?.type).toBe("success");
		expect(countryLine(saved.blocks)).toBe(
			"Stripe account country: not checked yet — Stripe couldn't be reached. Opening this page again checks in a few minutes; saving the key again checks now.",
		);
	});

	test("no key, no line — and nothing asked", async () => {
		const { ctx, urls } = withStripe({ status: 200, body: { country: "IN" } });
		const page = await invoke(ctx, { type: "page_load", page: "/settings" });
		expect(countryLine(page.blocks)).toBeUndefined();
		expect(urls).toHaveLength(0);
	});

	test("a key saved before the country was read: the Settings page load reads it, once", async () => {
		const { ctx, urls } = withStripe(
			{ status: 200, body: { country: "IN" } },
			{ "settings:stripeSecretKey": SK_TEST },
		);
		const page = await invoke(ctx, { type: "page_load", page: "/settings" });
		expect(countryLine(page.blocks)).toContain("India (IN)");
		await invoke(ctx, { type: "page_load", page: "/settings" });
		expect(urls).toEqual(["https://api.stripe.com/v1/account"]);
	});

	test("saving any OTHER key asks Stripe nothing", async () => {
		const { ctx, urls } = withStripe({ status: 200, body: { country: "IN" } });
		await saveSecret(ctx, "save-stripe-webhook-secret", "stripeWebhookSecret", WHSEC);
		expect(urls).toHaveLength(0);
	});
});
