/**
 * The order-email from-address setting, `settings:emailFrom` — and why the save
 * refuses an address no real provider will send from.
 *
 * THE FAILURE THIS PREVENTS. The field's old placeholder and the runtime default
 * were both `no-reply@otta.local`. A real provider (Resend, the one DEPLOYMENT.md
 * documents) refuses any sending domain the account has not verified, and a
 * reserved name like `.local` can never be verified — so an operator who saved
 * one got a screen that said "saved" and an outbox whose every send was refused
 * on a cron tick nobody watches. The save now refuses it, all-or-nothing, the way
 * it already refuses a bad payTo or sign-in link URL.
 *
 * WHAT IT CANNOT CHECK: whether the domain is verified with the provider. That
 * refusal is the provider's, and arrives as a diagnosable send error
 * (`ctx-http-email-sender.ts`). This is a placeholder catcher, not a verifier.
 *
 * The handler is driven over a fake kv, as in `store-theme-setting.test.ts` —
 * kv is the only store these settings touch.
 */
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createSettingsFormHandler,
	SAVE_PAYMENT_SETTINGS_ACTION,
} from "../src/admin/settings-form.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import {
	DEFAULT_EMAIL_FROM,
	EMAIL_FROM_KEY,
	makeEmailSender,
	resetEmailWarningsForTesting,
} from "../src/email/ctx-http-email-sender.js";
import { isDeliverableFromAddress } from "../src/email/from-address.js";
import { LOGIN_LINK_URL_KEY } from "../src/storefront/login-link.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { field, findBlocks, formFor, type LooseBlock } from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

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
	const handler = createSettingsFormHandler({ storeThemes: undefined });
	return (await handler({ input, request: req }, ctx)) as unknown as Outcome;
}

function save(ctx: PluginContext, values: Record<string, string>): Promise<Outcome> {
	return invoke(ctx, { type: "form_submit", action_id: SAVE_PAYMENT_SETTINGS_ACTION, values });
}

function errorBanner(blocks: readonly LooseBlock[]): LooseBlock | undefined {
	return findBlocks(blocks, "banner").find((b) => b.variant === "error");
}

describe("isDeliverableFromAddress", () => {
	test.each([
		"orders@shop.otta.sh",
		"no-reply@mail.boutique.co.uk",
		"Boutique <orders@boutique.com>",
		'"Boutique, Paris" <orders@boutique.fr>',
		'"Boutique; Paris" <orders@boutique.fr>',
		"  orders@boutique.com  ",
		// An internationalized domain in its ASCII (punycode) form.
		"orders@xn--bcher-kva.de",
		"orders@shop.xn--p1ai",
		"orders@mail-1.boutique.com",
	])("accepts %s", (value) => {
		expect(isDeliverableFromAddress(value)).toBe(true);
	});

	test.each([
		// The reserved names (RFC 2606, RFC 6761/6762) — no provider sends from them.
		DEFAULT_EMAIL_FROM,
		"orders@shop.local",
		"orders@shop.LOCAL",
		"orders@shop.localhost",
		"orders@shop.test",
		"orders@shop.example",
		"orders@shop.invalid",
		"orders@example.com",
		"orders@mail.example.org",
		"orders@shop.internal",
		"orders@shop.onion",
		"orders@shop.alt",
		"orders@home.arpa",
		"orders@nas.home.arpa",
		"Shop <orders@shop.local>",
		// Single-label: `localhost`, or a bare intranet host.
		"orders@localhost",
		"orders@shop",
		// Malformed.
		"",
		"orders",
		"@shop.otta.sh",
		"orders@",
		"orders@@shop.otta.sh",
		"orders @shop.otta.sh",
		"Shop <orders@shop.otta.sh",
		"Shop <>",
		// Control characters anywhere: a CR/LF in a from-address is a header
		// injection waiting for a transport that writes headers from it.
		"Shop\r\nBcc: x <a@shop.com>",
		"Shop\nBcc: x <a@shop.com>",
		"orders@shop.com\r\nBcc: x@evil.com",
		"Shop\u0000 <a@shop.com>",
		"Shop\u007f <a@shop.com>",
		"orders\t@shop.com",
		// C1 controls and the Unicode line/paragraph separators break lines too.
		"Shop\u0085 <a@shop.com>",
		"Shop\u009f <a@shop.com>",
		"Shop\u2028Bcc: x <a@shop.com>",
		"Shop\u2029 <a@shop.com>",
		// `,` and `;` in the local part: a comma is two mailboxes in either form.
		"a,b@shop.com",
		"a;b@shop.com",
		"Shop <a,b@shop.com>",
		// Unquoted specials in the display name — a comma makes it two mailboxes.
		"Shop, Inc <orders@shop.com>",
		"Shop; x <orders@shop.com>",
		'Shop "x" <orders@shop.com>',
		'"Shop <orders@shop.com>',
		// The TLD must be alphabetic (or punycode); an IP literal is no sending domain.
		"orders@1.2.3.4",
		"orders@[1.2.3.4]",
		"orders@shop.123",
		"orders@shop.c",
		// A label may not start or end with a hyphen.
		"orders@-shop.com",
		"orders@shop-.com",
		"orders@shop.-com",
		// A Unicode domain: write it in its xn-- form (the banner says so).
		"orders@bücher.de",
	])("refuses %s", (value) => {
		expect(isDeliverableFromAddress(value)).toBe(false);
	});

	test("the runtime default is refused — it is a dev-mailbox fallback, not a real sender", () => {
		// Kept as the fallback so a blank kv still makes a well-formed request to
		// a local mail catcher; never something an operator can save.
		expect(DEFAULT_EMAIL_FROM).toBe("no-reply@otta.local");
		expect(isDeliverableFromAddress(DEFAULT_EMAIL_FROM)).toBe(false);
	});
});

describe("Settings: saving the from-address", () => {
	test("a deliverable address, bare or with a display name, is saved", async () => {
		for (const value of ["orders@shop.otta.sh", "Boutique <orders@shop.otta.sh>"]) {
			const { ctx, kv } = makeCtx();
			const outcome = await save(ctx, { emailFrom: value });
			expect(errorBanner(outcome.blocks)).toBeUndefined();
			expect(outcome.toast?.type).toBe("success");
			expect(kv.get(EMAIL_FROM_KEY)).toBe(value);
		}
	});

	test("a reserved-domain address is REFUSED, and nothing in the submit is saved", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await save(ctx, {
			emailFrom: "no-reply@otta.local",
			loginLinkUrl: "https://shop.otta.sh/account/verify",
		});
		// The whole screen, inside the block contract (banner budget included).
		assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
		const banner = errorBanner(outcome.blocks);
		expect(banner).toBeDefined();
		const text = JSON.stringify(banner);
		expect(text).toContain("Nothing was saved");
		expect(text).toContain("from-address");
		// Names the field and the rule, never the rejected value — the same
		// no-echo rule as the payTo and sign-in link refusals.
		expect(text).not.toContain("otta.local");
		// It does not claim a verification this check cannot perform.
		expect(text).not.toMatch(/verified/iu);
		expect(text).toContain("xn--");
		expect(outcome.toast).toBeUndefined();
		// ATOMIC: the valid sibling did not land either.
		expect(kv.has(EMAIL_FROM_KEY)).toBe(false);
		expect(kv.has(LOGIN_LINK_URL_KEY)).toBe(false);
	});

	test("a malformed address is refused the same way", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await save(ctx, { emailFrom: "orders" });
		expect(JSON.stringify(errorBanner(outcome.blocks))).toContain("Nothing was saved");
		expect(kv.has(EMAIL_FROM_KEY)).toBe(false);
	});

	test("an EMPTY from-address is still allowed — clearing the box restores the default", async () => {
		// The operator clearing the field on purpose (e.g. a dev setup going back
		// to the local mail catcher) must remain possible.
		const { ctx, kv } = makeCtx({ [EMAIL_FROM_KEY]: "orders@shop.otta.sh" });
		const outcome = await save(ctx, { emailFrom: "" });
		expect(errorBanner(outcome.blocks)).toBeUndefined();
		expect(kv.get(EMAIL_FROM_KEY)).toBe("");
	});

	test("the field's placeholder is an address the save would accept", async () => {
		// The old placeholder was the refused default — a value an operator could
		// copy straight into a refusal.
		const { ctx } = makeCtx();
		const page = await invoke(ctx, { type: "page_load", page: "/settings" });
		const input = field(formFor(page.blocks, SAVE_PAYMENT_SETTINGS_ACTION), "emailFrom");
		const placeholder = String(input?.["placeholder"]);
		expect(isDeliverableFromAddress(placeholder)).toBe(true);
	});
});

/**
 * A from-address that was saved BEFORE the save refused reserved domains (or
 * written to kv by anything other than the form) is still sent with — the send
 * path does not second-guess it, because silently swapping in the dev default
 * would hide the misconfiguration — but it is LOGGED, once per isolate: every
 * send to a real provider is about to be refused.
 */
describe("makeEmailSender: a stored undeliverable from-address", () => {
	// The once-per-isolate latch is module state: reset it, or the negative case
	// below would pass only because an earlier case already tripped it.
	beforeEach(() => {
		resetEmailWarningsForTesting();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("is used as stored, and warned about once — never a silent fallback", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { ctx } = makeCtx({ [EMAIL_FROM_KEY]: "orders@shop.local" });
		const calls: Array<{ body: string }> = [];
		const withFetch: PluginContext = {
			...ctx,
			http: {
				fetch: (_url: string, init?: RequestInit) => {
					calls.push({ body: String(init?.body) });
					return Promise.resolve(new Response("{}", { status: 202 }));
				},
			},
		};
		for (let i = 0; i < 2; i++) {
			const sender = await makeEmailSender(withFetch, { apiUrl: "https://api.resend.com/emails" });
			await sender?.send({
				to: "buyer@shop.otta.sh" as never,
				template: "order-confirmation",
				data: { orderId: "ord_1", totalCents: 100, currency: "USD" },
				idempotencyKey: `row_${i}`,
			});
		}
		expect(JSON.parse(calls[0]?.body ?? "{}")["from"]).toBe("orders@shop.local");
		const notices = warn.mock.calls.filter((args) =>
			String(args[0]).includes("settings:emailFrom is not a deliverable address"),
		);
		expect(notices).toHaveLength(1);
		// Names the setting, never the value.
		expect(String(notices[0]?.[0])).not.toContain("shop.local");
	});

	test("a deliverable or absent from-address is not warned about", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await makeEmailSender(makeCtx({ [EMAIL_FROM_KEY]: "orders@shop.otta.sh" }).ctx, {
			apiUrl: "https://api.resend.com/emails",
		});
		await makeEmailSender(makeCtx().ctx, { apiUrl: "https://api.resend.com/emails" });
		expect(warn).not.toHaveBeenCalled();
	});
});
