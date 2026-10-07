import { recordingEmailProvider, type TestEmailMessage } from "@otta-sh/plugin/testing";
import type { EmailDeliverEvent, HookHandlers } from "emdash/plugin";
import { describe, expect, expectTypeOf, test } from "vitest";
import { httpEmailProvider } from "../src/index.js";
import plugin, { type DeliverContext, deliver } from "../src/plugin.js";

const API_KEY = "sk_test_do-not-leak-0123456789";
const ENDPOINT = "https://api.mail.example.net/v1/send";
const event: EmailDeliverEvent = {
	message: {
		to: "buyer@example.com",
		subject: "Order #1001",
		text: "Thanks",
		html: "<p>Thanks</p>",
	},
	source: "otta",
};

type Call = { url: string; init: RequestInit | undefined };

function stubContext(status: number, settings: Record<string, string> = {}) {
	const calls: Call[] = [];
	const values: Record<string, string> = {
		"settings:endpoint": ENDPOINT,
		"settings:apiKey": API_KEY,
		"settings:from": "shop@example.net",
		...settings,
	};
	const ctx: DeliverContext = {
		kv: { get: async <T>(key: string) => (values[key] ?? null) as T | null },
		http: {
			fetch: async (url, init) => {
				calls.push({ url, init });
				// The body echoes the key, as some APIs do in error responses.
				return new Response(`{"error":"rejected","key":"${API_KEY}"}`, { status });
			},
		},
	};
	return { ctx, calls };
}

describe("example email provider", () => {
	test("POSTs the message as JSON with a bearer key on 2xx", async () => {
		const { ctx, calls } = stubContext(202);
		await deliver(event, ctx);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(ENDPOINT);
		expect(call?.init?.method).toBe("POST");
		expect(call?.init?.headers).toEqual({
			"content-type": "application/json",
			authorization: `Bearer ${API_KEY}`,
		});
		expect(JSON.parse(String(call?.init?.body))).toEqual({
			from: "shop@example.net",
			to: "buyer@example.com",
			subject: "Order #1001",
			text: "Thanks",
			html: "<p>Thanks</p>",
		});
	});

	test("throws on non-2xx, naming status and host but never the key or the body", async () => {
		const { ctx } = stubContext(401);
		const error = await deliver(event, ctx).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		const err = error as Error;
		expect(err.message).toBe("email provider: HTTP 401 from api.mail.example.net");
		for (const text of [err.message, String(err), err.stack ?? "", JSON.stringify(err)]) {
			expect(text).not.toContain(API_KEY);
		}
		expect(err.cause).toBeUndefined();
	});

	test("throws before any request when a setting is missing", async () => {
		const { ctx, calls } = stubContext(200, { "settings:apiKey": "" });
		await expect(deliver(event, ctx)).rejects.toThrow('"settings:apiKey" is not set');
		expect(calls).toEqual([]);
	});

	test("registers an exclusive email:deliver hook, with the capabilities and host it needs", () => {
		expect(plugin.hooks["email:deliver"]).toEqual({ exclusive: true, handler: deliver });
		const descriptor = httpEmailProvider({ apiHost: "api.mail.example.net" });
		expect(descriptor.format).toBe("standard");
		expect(descriptor.capabilities).toEqual(["hooks.email-transport:register", "network:request"]);
		expect(descriptor.allowedHosts).toEqual(["api.mail.example.net"]);
		expect(Object.keys(descriptor.settingsSchema ?? {})).toEqual(["endpoint", "apiKey", "from"]);
	});

	test("recordingEmailProvider stays shape-compatible with EmDash's email types", async () => {
		expectTypeOf<TestEmailMessage>().toEqualTypeOf<EmailDeliverEvent["message"]>();
		const recorder = recordingEmailProvider();
		// Usable directly as an `email:deliver` handler in a stand-in transport plugin.
		const handler: HookHandlers["email:deliver"] = recorder.deliver;
		await handler(event, undefined as never);
		expect(recorder.sent).toEqual([event.message]);
	});
});
