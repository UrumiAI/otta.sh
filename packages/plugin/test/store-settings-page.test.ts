import { describe, expect, test } from "vitest";
import {
	createSettingsFormHandler,
	SETTINGS_ACTION_IDS,
	SETTINGS_PAGE,
} from "../src/admin/settings-form.js";
import {
	createShippingPageHandler,
	SHIPPING_ACTION_IDS,
	SHIPPING_PAGE,
} from "../src/admin/shipping-page.js";
import {
	createStoreSettingsPageHandler,
	type StoreSettingsPanel,
} from "../src/admin/store-settings-page.js";
import { createTaxPageHandler, TAX_ACTION_IDS, TAX_PAGE } from "../src/admin/tax-page.js";
import { STRIPE_SECRET_KEY_KEY } from "../src/payment-secrets.js";
import { STRIPE_ACCOUNT_COUNTRY_KEY } from "../src/payments/stripe-account-country.js";
import { STRIPE_PUBLISHABLE_KEY_KEY } from "../src/payments/stripe-publishable-key.js";
import type { PluginContext, SandboxedRouteContext } from "../src/types.js";
import { buttons, field, formFor, panel, type LooseBlock } from "./helpers/blocks.js";
import { makeInProcessCommerce } from "./helpers/in-process-commerce.js";

// The wrapper's own rules, with stub screens: run order, failure containment and
// toast pass-through. The real screens are covered through the sandbox in
// `store-settings-page.sandbox.test.ts`.

const ctx = {} as PluginContext;

function routeCtx(input: Record<string, unknown>): SandboxedRouteContext<Record<string, unknown>> {
	return { input, request: {} as SandboxedRouteContext["request"] };
}

function stubPanel(
	label: string,
	render: (input: Record<string, unknown>) => unknown,
	log: string[],
): StoreSettingsPanel {
	return {
		label,
		page: `/${label.toLowerCase()}`,
		actionIds: new Set([`${label.toLowerCase()}:act`]),
		handler: (async (rc: SandboxedRouteContext<Record<string, unknown>>) => {
			log.push(`${label}:${String(rc.input.type)}`);
			return render(rc.input);
		}) as StoreSettingsPanel["handler"],
	};
}

const text = (t: string) => ({ blocks: [{ type: "header", text: t }] });

describe("createStoreSettingsPageHandler", () => {
	test("the acting screen runs before its siblings re-load", async () => {
		const log: string[] = [];
		const handler = createStoreSettingsPageHandler([
			stubPanel("A", () => text("a"), log),
			stubPanel("B", () => text("b"), log),
		]);
		await handler(routeCtx({ type: "block_action", action_id: "b:act" }) as never, ctx);
		expect(log[0]).toBe("B:block_action");
		expect(log.slice(1)).toEqual(["A:page_load"]);
	});

	test("a sibling that throws becomes a banner in its own tab; the others still render", async () => {
		const log: string[] = [];
		const handler = createStoreSettingsPageHandler([
			stubPanel("A", () => text("a"), log),
			stubPanel(
				"B",
				() => {
					throw new Error("secret detail");
				},
				log,
			),
		]);
		const out = (await handler(routeCtx({ type: "page_load" }) as never, ctx)) as {
			blocks: LooseBlock[];
		};
		expect(panel(out.blocks, "A")).toEqual(text("a").blocks);
		const failed = panel(out.blocks, "B");
		expect(failed).toEqual([
			expect.objectContaining({ type: "banner", variant: "error", title: "Couldn't load B" }),
		]);
		expect(JSON.stringify(failed)).not.toContain("secret detail");
	});

	test("the acting screen's own failure is not swallowed", async () => {
		const handler = createStoreSettingsPageHandler([
			stubPanel(
				"A",
				() => {
					throw new Error("boom");
				},
				[],
			),
		]);
		await expect(
			handler(routeCtx({ type: "block_action", action_id: "a:act" }) as never, ctx),
		).rejects.toThrow("boom");
	});

	test("the acting screen's toast is passed through; a sibling's never is", async () => {
		const handler = createStoreSettingsPageHandler([
			stubPanel("A", () => ({ ...text("a"), toast: { message: "sibling", type: "info" } }), []),
			stubPanel("B", () => ({ ...text("b"), toast: { message: "Saved", type: "success" } }), []),
		]);
		const acted = (await handler(
			routeCtx({ type: "form_submit", action_id: "b:act" }) as never,
			ctx,
		)) as { toast?: unknown };
		expect(acted.toast).toEqual({ message: "Saved", type: "success" });

		const loaded = (await handler(routeCtx({ type: "page_load" }) as never, ctx)) as {
			toast?: unknown;
		};
		expect(loaded).not.toHaveProperty("toast");
	});
});

// #530 item 2, the #518 path: the real General, Tax and Shipping screens behind
// the wrapper, over a real document store. An action in another tab re-loads
// General; with the publishable key read failing then, General must leave the
// key out of its payment-settings form (#513), so a save from it keeps the key.
describe("Store settings tabs over the real screens", () => {
	const PK_TEST = ["pk_test_", "51QaFixtureKey000000000000"].join("");

	test("a Tax action re-renders General without the publishable key when its read fails", async () => {
		const h = await makeInProcessCommerce();
		try {
			await h.ctx.kv.set(STRIPE_PUBLISHABLE_KEY_KEY, PK_TEST);
			let failPublishableRead = false;
			const kvCtx: PluginContext = {
				...h.ctx,
				kv: {
					...h.ctx.kv,
					get: <T>(key: string): Promise<T | null> =>
						failPublishableRead && key === STRIPE_PUBLISHABLE_KEY_KEY
							? Promise.reject(new Error("kv unavailable"))
							: h.ctx.kv.get<T>(key),
				},
			};
			const handler = createStoreSettingsPageHandler([
				{
					label: "General",
					page: SETTINGS_PAGE.path,
					actionIds: SETTINGS_ACTION_IDS,
					handler: createSettingsFormHandler(),
				},
				{
					label: "Tax",
					page: TAX_PAGE.path,
					actionIds: TAX_ACTION_IDS,
					handler: createTaxPageHandler(),
				},
				{
					label: "Shipping",
					page: SHIPPING_PAGE.path,
					actionIds: SHIPPING_ACTION_IDS,
					handler: createShippingPageHandler(),
				},
			]);
			const call = async (input: Record<string, unknown>) =>
				(await handler(routeCtx(input) as never, kvCtx)) as { blocks: LooseBlock[] };

			const loaded = await call({ type: "page_load" });
			const newClass = buttons(panel(loaded.blocks, "Tax")).find(
				(b) => b.action_id === "tax:show-new-class",
			);
			expect(newClass, "no New tax class button in the Tax tab").toBeDefined();

			failPublishableRead = true;
			const after = await call({
				type: "block_action",
				action_id: "tax:show-new-class",
				value: newClass!.value,
			});
			const form = formFor(panel(after.blocks, "General"), "save-payment-settings");
			expect(form, "no payment-settings form in the General tab").toBeDefined();
			expect(field(form, "stripePublishableKey")).toBeUndefined();
			expect(field(form, "loginLinkUrl")).toBeDefined();
		} finally {
			await h.close();
		}
	});
});

// #520: an action in Tax or Shipping re-renders General around it, and General's
// page load may ask Stripe for the account country (2.5 s) when the cached check
// is stale. The acting tab must never wait on that.
describe("Store settings tabs and the Stripe country check", () => {
	const SK = ["sk_test_", "51StoreSettingsFixture000"].join("");

	async function openPage() {
		const h = await makeInProcessCommerce();
		// A key with no cached country answer: the stale case that makes a full
		// General load call Stripe. `egressAttempts()` counts any ctx.http use.
		await h.ctx.kv.set(STRIPE_SECRET_KEY_KEY, SK);
		const handler = createStoreSettingsPageHandler([
			{
				label: "General",
				page: SETTINGS_PAGE.path,
				actionIds: SETTINGS_ACTION_IDS,
				handler: createSettingsFormHandler(),
			},
			{
				label: "Tax",
				page: TAX_PAGE.path,
				actionIds: TAX_ACTION_IDS,
				handler: createTaxPageHandler(),
			},
			{
				label: "Shipping",
				page: SHIPPING_PAGE.path,
				actionIds: SHIPPING_ACTION_IDS,
				handler: createShippingPageHandler(),
			},
		]);
		const call = async (input: Record<string, unknown>) =>
			(await handler(routeCtx(input) as never, h.ctx)) as { blocks: LooseBlock[] };
		return { h, call };
	}

	test("a Tax action and a Shipping action make no Stripe call, and General still renders", async () => {
		const { h, call } = await openPage();
		try {
			const loaded = await call({ type: "page_load" });
			// The page open is the one place that may ask Stripe.
			expect(h.egressAttempts()).toBe(1);
			// The failed ask is cached with a back-off; drop it so the check is stale again.
			await h.ctx.kv.delete(STRIPE_ACCOUNT_COUNTRY_KEY);

			const taxButton = buttons(panel(loaded.blocks, "Tax")).find(
				(b) => b.action_id === "tax:show-new-class",
			);
			const taxed = await call({
				type: "block_action",
				action_id: "tax:show-new-class",
				value: taxButton!.value,
			});
			expect(formFor(panel(taxed.blocks, "General"), "save-display")).toBeDefined();
			// Nothing cached, nothing asked: General says so, and how to get it checked.
			expect(JSON.stringify(panel(taxed.blocks, "General"))).toContain(
				"Stripe account country: not checked yet. Reloading this page or saving the key again checks it.",
			);
			expect(h.egressAttempts()).toBe(1);

			await h.ctx.kv.delete(STRIPE_ACCOUNT_COUNTRY_KEY);
			const shipped = await call({ type: "block_action", action_id: "shipping:open-create-zone" });
			expect(formFor(panel(shipped.blocks, "General"), "save-display")).toBeDefined();

			expect(h.egressAttempts()).toBe(1);
		} finally {
			await h.close();
		}
	});

	test("a General action still does the full read", async () => {
		const { h, call } = await openPage();
		try {
			await call({
				type: "form_submit",
				action_id: "save-display",
				values: { storeDisplayName: "Lune & Ochre" },
			});
			expect(h.egressAttempts()).toBe(1);
		} finally {
			await h.close();
		}
	});

	test("the General panel leaves out its own heading; a standalone page keeps it", async () => {
		const { h, call } = await openPage();
		try {
			const loaded = await call({ type: "page_load" });
			expect(panel(loaded.blocks, "General")[0]).not.toMatchObject({
				type: "header",
				text: "Settings",
			});
			const standalone = (await createSettingsFormHandler()(
				routeCtx({ type: "page_load", page: SETTINGS_PAGE.path }) as never,
				h.ctx,
			)) as { blocks: LooseBlock[] };
			expect(standalone.blocks[0]).toMatchObject({ type: "header", text: "Settings" });
		} finally {
			await h.close();
		}
	});
});
