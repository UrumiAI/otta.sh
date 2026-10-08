import { recordingEmailProvider, type TestEmailMessage } from "@otta-sh/plugin/testing";
import type { EmailDeliverEvent, HookHandlers } from "emdash/plugin";
import { describe, expect, expectTypeOf, test } from "vitest";
import { httpEmailProvider, httpsHost } from "../src/index.js";
import plugin, { type DeliverContext, deliver, EMAIL_API_URL } from "../src/plugin.js";

const API_KEY = "sk_test_do-not-leak-0123456789";
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

function stubContext(respond: () => Promise<Response>, settings: Record<string, string> = {}) {
	const calls: Call[] = [];
	const values: Record<string, string> = {
		"settings:apiKey": API_KEY,
		"settings:from": "shop@example.net",
		...settings,
	};
	const ctx: DeliverContext = {
		kv: { get: async <T>(key: string) => (values[key] ?? null) as T | null },
		http: {
			fetch: async (url, init) => {
				calls.push({ url, init });
				return respond();
			},
		},
	};
	return { ctx, calls };
}

/** The body echoes the key, as some APIs do in error responses. */
const reply = (status: number) => async () =>
	new Response(`{"error":"rejected","key":"${API_KEY}"}`, { status });

async function failure(p: Promise<void>): Promise<Error> {
	const error = await p.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(error instanceof Error)) throw new Error("expected deliver to throw an Error");
	return error;
}

function expectNoLeak(err: Error, secret: string): void {
	for (const text of [err.message, String(err), err.stack ?? "", JSON.stringify(err)]) {
		expect(text).not.toContain(secret);
	}
	expect(err.cause).toBeUndefined();
}

describe("example email provider", () => {
	test("POSTs the message as JSON with a bearer key on 2xx", async () => {
		const { ctx, calls } = stubContext(reply(202));
		await deliver(event, ctx);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(EMAIL_API_URL);
		expect(call?.init?.method).toBe("POST");
		expect(call?.init?.headers).toEqual({
			"content-type": "application/json",
			authorization: `Bearer ${API_KEY}`,
		});
		expect(call?.init?.signal).toBeUndefined();
		expect(JSON.parse(String(call?.init?.body))).toEqual({
			from: "shop@example.net",
			...event.message,
		});
	});

	test("forwards EmDash 1.0's optional cc and replyTo when the message has them", async () => {
		const { ctx, calls } = stubContext(reply(202));
		const message = { ...event.message, cc: ["ops@example.net"], replyTo: "help@example.net" };
		await deliver({ ...event, message }, ctx);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			from: "shop@example.net",
			...message,
		});
	});

	test("throws on non-2xx, naming status and host but never the key or the body", async () => {
		const { ctx } = stubContext(reply(401));
		const err = await failure(deliver(event, ctx));
		expect(err.message).toBe("email provider: HTTP 401 from api.mail.example.net");
		expectNoLeak(err, API_KEY);
	});

	test("rejects a key with CR/LF before any request, without quoting it", async () => {
		const badKey = "sk_live_SECRET123\r\nX-Injected: 1";
		const { ctx, calls } = stubContext(reply(200), { "settings:apiKey": badKey });
		const err = await failure(deliver(event, ctx));
		expect(err.message).toBe('email provider: "settings:apiKey" has invalid characters');
		expectNoLeak(err, "SECRET123");
		expect(calls).toEqual([]);
	});

	test("a fetch error that quotes the key is rethrown clean, with no cause", async () => {
		const { ctx } = stubContext(async () => {
			throw new TypeError(`Headers.append: "Bearer ${API_KEY}" is an invalid header value.`);
		});
		const err = await failure(deliver(event, ctx));
		expect(err.message).toBe("email provider: request to api.mail.example.net failed (TypeError)");
		expectNoLeak(err, API_KEY);
	});

	test("throws before any request when a setting is missing", async () => {
		const { ctx, calls } = stubContext(reply(200), { "settings:apiKey": "" });
		await expect(deliver(event, ctx)).rejects.toThrow('"settings:apiKey" is not set');
		expect(calls).toEqual([]);
	});

	test("the API URL must be https; its exact host is the only allowed host", () => {
		expect(httpsHost(EMAIL_API_URL)).toBe("api.mail.example.net");
		expect(() => httpsHost("http://api.mail.example.net:8080/x")).toThrow("must use https");
		expect(() => httpsHost("https://*.example.net/send")).toThrow("not a wildcard");
	});

	test("registers an exclusive email:deliver hook, with the capabilities and host it needs", () => {
		expect(plugin.hooks["email:deliver"]).toEqual({ exclusive: true, handler: deliver });
		const descriptor = httpEmailProvider();
		expect(descriptor.format).toBe("standard");
		expect(descriptor.capabilities).toEqual(["hooks.email-transport:register", "network:request"]);
		expect(descriptor.allowedHosts).toEqual(["api.mail.example.net"]);
		expect(Object.keys(descriptor.settingsSchema ?? {})).toEqual(["apiKey", "from"]);
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
