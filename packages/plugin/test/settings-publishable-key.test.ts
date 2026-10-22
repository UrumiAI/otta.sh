/**
 * Issue #498: the Stripe publishable key is a Settings value, read per request by
 * the checkout pages through `storefront/payment-config`. This suite pins:
 *
 *  - Settings saves a `pk_…` key in plain text and prefills it back;
 *  - a wrong paste (the commonest is the SECRET key) is refused, stores nothing
 *    and is never echoed back;
 *  - the group label reads ready only when both Stripe keys are set and agree on
 *    test/live, and a mismatch or an unusable stored value is explained;
 *  - the route answers the usable stored key or `null`, and whether card payment
 *    is ready (#499, `card-payment-readiness.test.ts`), and nothing else.
 *
 * Driven over a fake kv, like `settings-secrets.test.ts`.
 */
import type { StorageAccess, StorageCollection } from "@urumi.ai/otta-store-emdash";
import { describe, expect, test } from "vitest";
import { encodeCarrier } from "../src/admin/scaffold/carrier.js";
import { createSettingsFormHandler } from "../src/admin/settings-form.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import { STRIPE_SECRET_KEY_KEY } from "../src/payment-secrets.js";
import {
	readStripePublishableKey,
	STRIPE_PUBLISHABLE_KEY_KEY,
} from "../src/payments/stripe-publishable-key.js";
import { LOGIN_LINK_URL_KEY } from "../src/storefront/login-link.js";
import { createPaymentConfigRouteHandler } from "../src/storefront/payment-config-route.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	contextTexts,
	field,
	findBlocks,
	formFor,
	sectionHeading,
	type LooseBlock,
} from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

// Fixtures in the shapes Stripe issues. None is a real credential.
const PK_TEST = ["pk_test_", "51QaFixtureKey000000000000"].join("");
const PK_LIVE = ["pk_live_", "51QaFixtureKey000000000000"].join("");
const SK_TEST = ["sk_test_", "51QaFixtureKey000000000000"].join("");
const SK_LIVE = ["sk_live_", "51QaFixtureKey000000000000"].join("");

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
	options: { kvFails?: boolean; email?: boolean } = {},
): { ctx: PluginContext; kv: Map<string, unknown>; failingReads: Set<string> } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	// #513: kv keys whose READS fail right now (a blip), toggled by the test.
	const failingReads = new Set<string>();
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		...(options.email === true
			? { email: { send: () => Promise.reject(new Error("no sends in this suite")) } }
			: {}),
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (options.kvFails === true || failingReads.has(k)) throw new Error("kv unavailable");
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
	return { ctx, kv, failingReads };
}

interface Outcome {
	blocks: LooseBlock[];
	toast?: { message?: string; type?: string };
}

async function invoke(ctx: PluginContext, input: Record<string, unknown>): Promise<Outcome> {
	const handler = createSettingsFormHandler();
	return (await handler({ input, request: req }, ctx)) as unknown as Outcome;
}

function savePublishable(ctx: PluginContext, value: string): Promise<Outcome> {
	return invoke(ctx, {
		type: "form_submit",
		action_id: "save-payment-settings",
		values: { stripePublishableKey: value },
	});
}

function publishableField(blocks: readonly LooseBlock[]): ReturnType<typeof field> {
	return field(formFor(blocks, "save-payment-settings"), "stripePublishableKey");
}

function paymentsLabel(blocks: readonly LooseBlock[]): string {
	return String(sectionHeading(blocks, "settings:payments")?.text);
}

describe("saving the publishable key", () => {
	test("a pk_ key is stored trimmed and prefilled back (it is not a secret)", async () => {
		const { ctx, kv } = makeCtx();
		const saved = await savePublishable(ctx, `  ${PK_LIVE}\n`);
		expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_LIVE);
		expect(saved.toast).toMatchObject({ type: "success" });
		expect(publishableField(saved.blocks)).toMatchObject({
			type: "text_input",
			initial_value: PK_LIVE,
		});
		assertBlockContract(saved.blocks, { screen: "settings", level: "list" });
	});

	test("the secret key pasted here is refused, stores nothing, and is never shown", async () => {
		const { ctx, kv } = makeCtx();
		const refused = await savePublishable(ctx, SK_LIVE);
		expect(kv.has(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(false);
		const error = findBlocks(refused.blocks, "banner").find((b) => b.variant === "error");
		expect(String(error?.description)).toContain("must start with pk_live_ or pk_test_");
		expect(String(error?.description)).toContain("Nothing was saved.");
		// Not put back into the field, nor anywhere else on the page.
		expect(publishableField(refused.blocks)?.initial_value).toBe("");
		expect(JSON.stringify(refused)).not.toContain(SK_LIVE);
		assertBlockContract(refused.blocks, { screen: "settings", level: "list" });
	});

	test.each(["garbage", "pk_test_", "PK_TEST_51QaFixtureKey000", "pk_wrong_51QaFixtureKey000"])(
		"%s is refused",
		async (value) => {
			const { ctx, kv } = makeCtx();
			await savePublishable(ctx, value);
			expect(kv.has(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(false);
		},
	);

	test("an emptied field clears the key (card payment then says it is not set up)", async () => {
		const { ctx, kv } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST });
		// A deliberate clear: the form this page rendered, with the key shown in it.
		const page = await invoke(ctx, { type: "page_load" });
		const form = formFor(page.blocks, "save-payment-settings");
		const saved = await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: submittedFrom(page.blocks, { stripePublishableKey: "" }),
			block_id: form?.block_id,
		});
		expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe("");
		expect(await readStripePublishableKey(ctx)).toBeUndefined();
		expect(saved.toast).toMatchObject({ type: "success" });
	});

	// #530: a form rendered by code from before #527, after its key read failed,
	// shows the key blank and has no "key shown" marker in its carrier. Its blank
	// is not an instruction to clear a stored key.
	describe("a blank key from a form that did not show the key (#530)", () => {
		const SIGN_IN = "https://shop.example/account/verify-new";
		// What that older form's block_id carried: the prefill digest, nothing else.
		const OLD_FORM_BLOCK_ID = encodeCarrier("settings:save-payment-settings", { __v: "0" });

		test.each([
			["an older form's carrier", OLD_FORM_BLOCK_ID],
			["no carrier at all", undefined],
		])(
			"over a stored key, with %s: the key is kept and the operator is told",
			async (_, blockId) => {
				const { ctx, kv } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST });
				const saved = await invoke(ctx, {
					type: "form_submit",
					action_id: "save-payment-settings",
					values: { stripePublishableKey: "", loginLinkUrl: SIGN_IN },
					...(blockId === undefined ? {} : { block_id: blockId }),
				});
				expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
				// The rest of the submit is still saved.
				expect(kv.get(LOGIN_LINK_URL_KEY)).toBe(SIGN_IN);
				const banner = findBlocks(saved.blocks, "banner").find((b) =>
					String(b.title).includes("publishable key"),
				);
				expect(String(banner?.title)).toBe("Stripe publishable key kept");
				expect(String(banner?.description)).toBe(
					"The publishable key field was blank on a form that didn't show the saved key, so the key was kept. Other changes were saved. To clear it, reload the page, empty the field and save.",
				);
				expect(saved.toast).toMatchObject({ message: "Stripe publishable key kept", type: "info" });
				expect(publishableField(saved.blocks)?.initial_value).toBe(PK_TEST);
				assertBlockContract(saved.blocks, { screen: "settings", level: "list" });
			},
		);

		test("a refused paste, then a save of the refused form with the key still blank: the key is kept", async () => {
			const { ctx, kv } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST });
			const page = await invoke(ctx, { type: "page_load" });
			const refused = await invoke(ctx, {
				type: "form_submit",
				action_id: "save-payment-settings",
				values: submittedFrom(page.blocks, { stripePublishableKey: SK_LIVE }),
				block_id: formFor(page.blocks, "save-payment-settings")?.block_id,
			});
			expect(refused.toast).not.toMatchObject({ type: "success" });
			// The refused paste is not echoed back, so the field is blank.
			expect(publishableField(refused.blocks)?.initial_value).toBe("");
			await invoke(ctx, {
				type: "form_submit",
				action_id: "save-payment-settings",
				values: submittedFrom(refused.blocks, { loginLinkUrl: SIGN_IN }),
				block_id: formFor(refused.blocks, "save-payment-settings")?.block_id,
			});
			expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
			expect(kv.get(LOGIN_LINK_URL_KEY)).toBe(SIGN_IN);
		});

		test("a refused paste, then a refused URL with the key still blank, then a fixed save: the key is kept", async () => {
			const { ctx, kv } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST });
			const submitForm = (blocks: readonly LooseBlock[], changes: Record<string, string>) =>
				invoke(ctx, {
					type: "form_submit",
					action_id: "save-payment-settings",
					values: submittedFrom(blocks, changes),
					block_id: formFor(blocks, "save-payment-settings")?.block_id,
				});
			const page = await invoke(ctx, { type: "page_load" });
			const pasted = await submitForm(page.blocks, { stripePublishableKey: SK_LIVE });
			expect(pasted.toast).not.toMatchObject({ type: "success" });
			// A second refusal, for the sign-in URL only, with the key field left blank.
			const typo = await submitForm(pasted.blocks, { loginLinkUrl: "http://shop.example/verify" });
			expect(typo.toast).not.toMatchObject({ type: "success" });
			expect(publishableField(typo.blocks)?.initial_value).toBe("");
			await submitForm(typo.blocks, { loginLinkUrl: SIGN_IN });
			expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
			expect(kv.get(LOGIN_LINK_URL_KEY)).toBe(SIGN_IN);
		});

		test("the stored key cannot be read on save: it is kept", async () => {
			const { ctx, kv, failingReads } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST });
			failingReads.add(STRIPE_PUBLISHABLE_KEY_KEY);
			await invoke(ctx, {
				type: "form_submit",
				action_id: "save-payment-settings",
				values: { stripePublishableKey: "" },
				block_id: OLD_FORM_BLOCK_ID,
			});
			expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
		});

		test("nothing stored: the blank is saved as before, with no warning", async () => {
			const { ctx, kv } = makeCtx();
			const saved = await invoke(ctx, {
				type: "form_submit",
				action_id: "save-payment-settings",
				values: { stripePublishableKey: "" },
				block_id: OLD_FORM_BLOCK_ID,
			});
			expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe("");
			expect(saved.toast).toMatchObject({ message: "Payment settings saved", type: "success" });
		});
	});

	test("a submit without the field keeps the stored key (absent is not empty)", async () => {
		const { ctx, kv } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST });
		await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { loginLinkUrl: "" },
		});
		expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
	});
});

/** What the browser submits for the payment-settings form: every field the
 *  page rendered, with its prefill unless the operator changed it. */
function submittedFrom(
	blocks: readonly LooseBlock[],
	changes: Record<string, string>,
): Record<string, string> {
	const form = formFor(blocks, "save-payment-settings");
	const fields = Array.isArray(form?.fields) ? (form.fields as LooseBlock[]) : [];
	return Object.fromEntries(
		fields.map((f) => {
			const id = String(f.action_id);
			return [id, changes[id] ?? String(f.initial_value ?? "")] as const;
		}),
	);
}

describe("a failed read never blanks a stored value (#513)", () => {
	const SIGN_IN = "https://shop.example/account/verify";
	const NEW_SIGN_IN = "https://shop.example/account/verify-new";

	test("the publishable key read fails, the sign-in URL is saved: the stored key is unchanged", async () => {
		const { ctx, kv, failingReads } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SK_TEST,
			[STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST,
			[LOGIN_LINK_URL_KEY]: SIGN_IN,
		});
		failingReads.add(STRIPE_PUBLISHABLE_KEY_KEY);
		const page = await invoke(ctx, { type: "page_load" });
		// The operator is told, rather than shown a blank field that reads as "not set".
		expect(contextTexts(page.blocks).join("\n")).toContain(
			"The Stripe publishable key couldn't be loaded",
		);
		// Not "no publishable", which would read as unset.
		expect(paymentsLabel(page.blocks)).toBe(
			"Payments & email — pk not loaded · no webhook · no email",
		);
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });

		failingReads.clear();
		const saved = await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: submittedFrom(page.blocks, { loginLinkUrl: NEW_SIGN_IN }),
		});
		expect(kv.get(LOGIN_LINK_URL_KEY)).toBe(NEW_SIGN_IN);
		expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
		expect(saved.toast).toMatchObject({ type: "success" });
		expect(publishableField(saved.blocks)?.initial_value).toBe(PK_TEST);
	});

	test("the sign-in URL read fails, the publishable key is saved: the stored URL is unchanged", async () => {
		const { ctx, kv, failingReads } = makeCtx({ [LOGIN_LINK_URL_KEY]: SIGN_IN });
		failingReads.add(LOGIN_LINK_URL_KEY);
		const page = await invoke(ctx, { type: "page_load" });
		expect(contextTexts(page.blocks).join("\n")).toContain(
			"The sign-in page address couldn't be loaded",
		);
		failingReads.clear();
		await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: submittedFrom(page.blocks, { stripePublishableKey: PK_LIVE }),
		});
		expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_LIVE);
		expect(kv.get(LOGIN_LINK_URL_KEY)).toBe(SIGN_IN);
	});

	test("a refused save whose re-read fails keeps the typed sign-in URL, and never shows a blank key", async () => {
		const { ctx, kv, failingReads } = makeCtx({
			[STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST,
			[LOGIN_LINK_URL_KEY]: SIGN_IN,
		});
		const page = await invoke(ctx, { type: "page_load" });
		// The refusal's re-render reads kv again, and both reads fail this time.
		failingReads.add(STRIPE_PUBLISHABLE_KEY_KEY).add(LOGIN_LINK_URL_KEY);
		const refused = await invoke(ctx, {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: submittedFrom(page.blocks, {
				stripePublishableKey: "garbage",
				loginLinkUrl: NEW_SIGN_IN,
			}),
		});
		expect(refused.toast).not.toMatchObject({ type: "success" });
		const form = formFor(refused.blocks, "save-payment-settings");
		// What was typed is what is shown, so the sign-in URL field stays.
		expect(field(form, "loginLinkUrl")).toMatchObject({ initial_value: NEW_SIGN_IN });
		// The refused key comes back as "": over a failed read it is left out, not blank.
		expect(field(form, "stripePublishableKey")).toBeUndefined();
		expect(kv.get(STRIPE_PUBLISHABLE_KEY_KEY)).toBe(PK_TEST);
		expect(kv.get(LOGIN_LINK_URL_KEY)).toBe(SIGN_IN);
	});

	test("every read fails: no payment-settings form to save, and the page still renders", async () => {
		const page = await invoke(makeCtx({}, { kvFails: true }).ctx, { type: "page_load" });
		expect(formFor(page.blocks, "save-payment-settings")).toBeUndefined();
		const texts = contextTexts(page.blocks).join("\n");
		expect(texts).toContain("The Stripe publishable key couldn't be loaded");
		expect(texts).toContain("The sign-in page address couldn't be loaded");
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
	});

	test("a stored empty value is not a failed read: the field is shown, blank", async () => {
		const page = await invoke(makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: "" }).ctx, {
			type: "page_load",
		});
		expect(publishableField(page.blocks)).toMatchObject({ initial_value: "" });
		expect(contextTexts(page.blocks).join("\n")).not.toContain("couldn't be loaded");
	});
});

describe("what Settings says about card checkout", () => {
	test.each([
		[{}, "no Stripe key"],
		[{ [STRIPE_SECRET_KEY_KEY]: SK_TEST }, "no publishable"],
		[{ [STRIPE_SECRET_KEY_KEY]: SK_TEST, [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST }, "Stripe test"],
		[{ [STRIPE_SECRET_KEY_KEY]: SK_LIVE, [STRIPE_PUBLISHABLE_KEY_KEY]: PK_LIVE }, "Stripe live"],
		[
			{ [STRIPE_SECRET_KEY_KEY]: SK_LIVE, [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST },
			"test/live mixed",
		],
		[
			{ [STRIPE_SECRET_KEY_KEY]: SK_TEST, [STRIPE_PUBLISHABLE_KEY_KEY]: "not-a-key" },
			"no publishable",
		],
		// #513 nit: a key stored with surrounding whitespace (outside Settings) works at
		// checkout, which trims; Settings must agree rather than say card payment is off.
		[
			{ [STRIPE_SECRET_KEY_KEY]: SK_TEST, [STRIPE_PUBLISHABLE_KEY_KEY]: ` ${PK_TEST}\n` },
			"Stripe test",
		],
	] as const)("%j → %s", async (seed, part) => {
		const page = await invoke(makeCtx(seed).ctx, { type: "page_load" });
		expect(paymentsLabel(page.blocks)).toBe(`Payments & email — ${part} · no webhook · no email`);
		assertBlockContract(page.blocks, { screen: "settings", level: "list" });
	});

	test("a test publishable key beside a live secret key is explained", async () => {
		const page = await invoke(
			makeCtx({ [STRIPE_SECRET_KEY_KEY]: SK_LIVE, [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST }).ctx,
			{ type: "page_load" },
		);
		expect(contextTexts(page.blocks).join("\n")).toContain(
			"The publishable key is a test key but the Stripe secret key is live.",
		);
	});

	test("a SECRET key stored in the publishable slot (outside Settings) is never shown back", async () => {
		const page = await invoke(makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: SK_LIVE }).ctx, {
			type: "page_load",
		});
		expect(publishableField(page.blocks)?.initial_value).toBe("");
		expect(JSON.stringify(page)).not.toContain(SK_LIVE);
	});

	test("the longest label still fits the 60-character budget", async () => {
		const page = await invoke(
			makeCtx(
				{
					[STRIPE_SECRET_KEY_KEY]: SK_LIVE,
					[STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST,
					"settings:stripeWebhookSecret": ["whsec_", "0123456789abcdef0123456789abcdef"].join(""),
					"state:emailLastSentAt": new Date().toISOString(),
				},
				{ email: true },
			).ctx,
			{ type: "page_load" },
		);
		expect(paymentsLabel(page.blocks)).toBe(
			"Payments & email — test/live mixed · webhook set · email set",
		);
		expect(paymentsLabel(page.blocks).length).toBeLessThanOrEqual(60);
	});

	test("a stored key with surrounding whitespace is not called unusable (#513)", async () => {
		const { ctx } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: `  ${PK_LIVE} ` });
		const page = await invoke(ctx, { type: "page_load" });
		expect(contextTexts(page.blocks).join("\n")).not.toContain("is not a pk_live_");
		expect(publishableField(page.blocks)?.initial_value).toBe(PK_LIVE);
		expect(await readStripePublishableKey(ctx)).toBe(PK_LIVE);
	});

	test("a stored value that is not a pk_ key is explained, and not used", async () => {
		const { ctx } = makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: "legacy-unchecked" });
		const page = await invoke(ctx, { type: "page_load" });
		expect(contextTexts(page.blocks).join("\n")).toContain(
			"is not a pk_live_… or pk_test_… key, so card payment is off",
		);
		expect(await readStripePublishableKey(ctx)).toBeUndefined();
	});
});

describe("storefront/payment-config", () => {
	const route = createPaymentConfigRouteHandler();
	const call = (ctx: PluginContext) => route({ input: {}, request: req } as never, ctx);

	test("answers the stored key", async () => {
		expect(await call(makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: ` ${PK_LIVE} ` }).ctx)).toEqual({
			ok: true,
			stripePublishableKey: PK_LIVE,
			// #499: the key alone is not card payment — both secrets are missing.
			cardPaymentReady: false,
		});
	});

	test.each([
		[{}],
		[{ [STRIPE_PUBLISHABLE_KEY_KEY]: "" }],
		[{ [STRIPE_PUBLISHABLE_KEY_KEY]: SK_TEST }],
	])("answers null for %j — never a value Stripe.js would throw on", async (seed) => {
		expect(await call(makeCtx(seed).ctx)).toEqual({
			ok: true,
			stripePublishableKey: null,
			cardPaymentReady: false,
		});
	});

	test("a kv failure is a render failure, not 'no key'", async () => {
		expect(await call(makeCtx({}, { kvFails: true }).ctx)).toEqual({
			ok: false,
			error: "RENDER_FAILED",
		});
	});

	test("answers nothing but the publishable key and whether card payment is ready", async () => {
		const answer = await call(
			makeCtx({ [STRIPE_PUBLISHABLE_KEY_KEY]: PK_TEST, [STRIPE_SECRET_KEY_KEY]: SK_TEST }).ctx,
		);
		expect(Object.keys(answer as object).toSorted()).toEqual([
			"cardPaymentReady",
			"ok",
			"stripePublishableKey",
		]);
		expect(JSON.stringify(answer)).not.toContain(SK_TEST);
	});
});
