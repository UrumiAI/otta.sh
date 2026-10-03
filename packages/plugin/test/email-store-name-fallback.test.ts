/**
 * The emails name the store even when "Store display name" was never set (QA2
 * U-3): they fall back to the display name of the saved From address
 * ("Goa Coffee <orders@goa.coffee>" → "Goa Coffee"). The sign-in email used to
 * say "Your sign-in link" and "Sign in" — nameless — on every store that had not
 * filled in the one field, although its From line already said who it was from.
 *
 * The plugin cannot read the CMS's site title (a sandboxed plugin has no such
 * read), so the From display name is the fallback it has.
 */
import { describe, expect, test } from "vitest";
import { EMAIL_FROM_KEY, makeEmailSender } from "../src/email/ctx-http-email-sender.js";
import { STORE_DISPLAY_NAME_KEY } from "../src/email/email-render-context.js";
import { fromDisplayName } from "../src/email/from-address.js";
import type { PluginContext } from "../src/types.js";

describe("fromDisplayName", () => {
	test.each([
		["Goa Coffee <orders@goa.coffee>", "Goa Coffee"],
		['"Goa, Coffee" <orders@goa.coffee>', "Goa, Coffee"],
		['"The \\"Best\\" Shop" <a@shop.co>', 'The "Best" Shop'],
		["  Spaced   Name  <a@shop.co> ", "Spaced   Name"],
		["orders@goa.coffee", undefined],
		["<orders@goa.coffee>", undefined],
		['"" <orders@goa.coffee>', undefined],
	])("%p → %p", (from, expected) => {
		expect(fromDisplayName(from)).toBe(expected);
	});
});

function ctxWith(seed: Record<string, unknown>, sent: string[]): PluginContext {
	const kv = new Map<string, unknown>(Object.entries(seed));
	return {
		http: {
			fetch: (_url: string, init?: RequestInit) => {
				sent.push(String(init?.body));
				return Promise.resolve(new Response("{}", { status: 202 }));
			},
		},
		kv: {
			get: async <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null),
			set: async (k: string, v: unknown) => void kv.set(k, v),
			delete: async (k: string) => kv.delete(k),
			list: async () => [...kv].map(([key, value]) => ({ key, value })),
		},
	};
}

async function loginSubject(seed: Record<string, unknown>): Promise<string> {
	const sent: string[] = [];
	const sender = await makeEmailSender(ctxWith(seed, sent), {
		apiUrl: "https://api.resend.com/emails",
	});
	await sender?.send({
		to: "buyer@shop.otta.sh" as never,
		template: "customer-login-link",
		data: { loginUrl: "https://shop.otta.sh/account/verify?challenge=c&token=t" },
		idempotencyKey: "login-1",
	});
	return JSON.parse(sent[0] ?? "{}")["subject"];
}

describe("the store's name in the emails", () => {
	test("no display name: the From address's display name", async () => {
		expect(await loginSubject({ [EMAIL_FROM_KEY]: "Goa Coffee <orders@goa.coffee>" })).toBe(
			"Sign in to Goa Coffee",
		);
	});

	test("a display name set: that, never the From name", async () => {
		expect(
			await loginSubject({
				[STORE_DISPLAY_NAME_KEY]: "Goa Coffee Roasters",
				[EMAIL_FROM_KEY]: "Orders Desk <orders@goa.coffee>",
			}),
		).toBe("Sign in to Goa Coffee Roasters");
	});

	test("neither: still nameless, never a made-up name", async () => {
		expect(await loginSubject({ [EMAIL_FROM_KEY]: "orders@goa.coffee" })).toBe("Your sign-in link");
	});
});
