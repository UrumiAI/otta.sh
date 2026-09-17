/**
 * `POST /webhooks/stripe` — the site's Stripe webhook EDGE (work order 02,
 * revised INC-C2).
 *
 * WHAT THIS ENDPOINT IS, AND WHAT IT DELIBERATELY IS NOT. It is a transport
 * shim and nothing else: it reads the delivery's raw bytes, base64-encodes
 * them, attaches the edge token, and hands the whole thing to the plugin's
 * PUBLIC `webhooks/stripe/settle` route, which does the real Stripe HMAC
 * verification (`packages/plugin/src/webhooks/stripe-settle-route.ts`). It does
 * NOT verify the signature, it holds no webhook secret, and it makes no
 * accept/reject decision of its own beyond "this request is not even shaped
 * like a Stripe delivery".
 *
 * So the properties worth pinning here are transport properties, and each group
 * below is one of them:
 *
 *  - **bytes** — a Stripe HMAC is computed over the EXACT delivered bytes. If
 *    this endpoint ever parsed and re-serialized the body, every signature
 *    would fail and every real payment would stop settling. The base64 must
 *    round-trip byte-for-byte, non-ASCII and whitespace included.
 *  - **the token** — provisioned ⇒ attached; unprovisioned ⇒ the request is
 *    still forwarded with no header at all, because the plugin's gate is
 *    pass-through-when-unset (mirroring `service/src/auth.ts`) and the HMAC is
 *    the real trust anchor. Sending an EMPTY header instead would be a
 *    behaviour change, not a no-op: the plugin's gate distinguishes "header
 *    absent" (reject when a token IS configured) from "header present".
 *  - **the status** — EmDash's route framework wraps every handler return in
 *    `{success, data}` at HTTP 200, and Stripe's retry logic keys on the HTTP
 *    STATUS. The plugin therefore returns the status it WANTS as a field and
 *    this endpoint replays it. A 401 that arrived as a 200 would tell Stripe a
 *    rejected delivery had succeeded and stop the retries forever.
 *  - **the gate** — an anonymous POST straight at this public URL, with a
 *    forged body and a wrong/absent token, must come back rejected. This is the
 *    test that replaced the original design's "routing test": there is no
 *    authenticated path into this endpoint to test, because a webhook is always
 *    unauthenticated.
 *  - **the dispatcher** — PUBLIC, never private. `handlePluginApiRoute` takes a
 *    caller identity a webhook structurally cannot supply, and EmDash binds it
 *    only on the authenticated path. A context carrying only the private
 *    dispatcher must fail closed, not fall back to it.
 *
 * The dispatcher fake below mirrors the real plugin route's OBSERVABLE contract
 * (the `StripeWebhookSettleResult` union and its statuses), not its internals —
 * the route's own suite, `packages/plugin/test/stripe-settle-route.test.ts`,
 * drives the real HMAC against a real store.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { APIContext } from "astro";
import {
	createStripeWebhookSettleHandler,
	STRIPE_WEBHOOK_SETTLE_ROUTE,
	WEBHOOK_EDGE_TOKEN_HEADER,
	WEBHOOK_EDGE_TOKEN_KEY,
	type StripeWebhookSettleResult,
} from "@otta-sh/plugin";
// The stub `vitest.config.ts` aliases `virtual:emdash/env` to. Imported by its
// real path rather than through the alias: same file, so the same module
// instance `webhook-env.ts` reads — but typed as the always-present object it
// is here, instead of the ambient declaration's `Record | undefined` (which is
// honest about a non-Cloudflare adapter, and useless to mutate).
import { env as virtualEnv } from "./helpers/virtual-emdash-env.js";
import { OTTA_WH_TOKEN_VAR } from "../src/lib/webhook-env.js";
import { POST } from "../src/pages/webhooks/stripe.js";

const SITE = "http://localhost:4321";

/** A realistic delivery: non-ASCII in a description, a trailing newline, and
 *  key order that a re-serialization would very plausibly preserve — so the
 *  byte test cannot pass by accident on a JSON round-trip. */
const RAW_BODY = new TextEncoder().encode(
	'{"id":"evt_1","type":"payment_intent.succeeded","data":{"object":{"description":"Café — 1× Widget"}}}\n',
);

const SIGNATURE = "t=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeef";

interface DispatchCall {
	route: string;
	input: Record<string, unknown>;
	/**
	 * The dispatched request's headers AS THEY ARE — a real `Headers` instance,
	 * never flattened to a record.
	 *
	 * That distinction is the whole point of recording them. This site registers
	 * the plugin in TRUSTED mode, and EmDash's trusted `PluginRouteHandler` hands
	 * the handler the genuine `Request` (behind its `guardConsumedRequestBody`
	 * proxy) — so the plugin sees a `Headers`, not the sandbox's plain record. A
	 * fake that converts here would encode the OTHER mode's shape and could not
	 * fail on a plugin-side lookup that only works on plain objects.
	 */
	headers: Headers;
}

/** A fake of `locals.emdash.handlePublicPluginApiRoute` that records every
 *  dispatch and answers with a caller-chosen `StripeWebhookSettleResult`,
 *  wrapped in the framework's `{success: true, data}` envelope. */
function makeDispatcher(result: StripeWebhookSettleResult | { success: false }): {
	handler: unknown;
	calls: DispatchCall[];
} {
	const calls: DispatchCall[] = [];
	const handler = async (_pluginId: string, _method: string, path: string, request: Request) => {
		calls.push({
			route: path.replace(/^\//, ""),
			input: (await request.json()) as Record<string, unknown>,
			headers: request.headers,
		});
		if ("success" in result) return result;
		return { success: true, data: result };
	};
	return { handler, calls };
}

function makeContext(
	handler: unknown,
	options: { body?: Uint8Array; signature?: string | null; private?: boolean } = {},
): APIContext {
	const url = new URL("/webhooks/stripe", SITE);
	const signature = options.signature === undefined ? SIGNATURE : options.signature;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (signature !== null) headers["stripe-signature"] = signature;
	const request = new Request(url, {
		method: "POST",
		headers,
		body: (options.body ?? RAW_BODY) as BodyInit,
	});
	const emdash =
		options.private === true
			? { handlePluginApiRoute: handler }
			: { handlePublicPluginApiRoute: handler };
	return { request, url, locals: { emdash } } as unknown as APIContext;
}

function setToken(value: string | undefined): void {
	if (value === undefined) delete virtualEnv[OTTA_WH_TOKEN_VAR];
	else virtualEnv[OTTA_WH_TOKEN_VAR] = value;
}

/** The token header, read the way the plugin reads it off a real `Headers` —
 *  `get()` is already case-insensitive. */
function sentToken(call: DispatchCall): string | undefined {
	return call.headers.get(WEBHOOK_EDGE_TOKEN_HEADER) ?? undefined;
}

const OK: StripeWebhookSettleResult = { ok: true, status: 200 };

afterEach(() => {
	setToken(undefined);
});

describe("POST /webhooks/stripe — the raw bytes reach the plugin unchanged", () => {
	test("the body is forwarded as base64 that decodes to the EXACT delivered bytes", async () => {
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		expect(calls).toHaveLength(1);
		const decoded = new Uint8Array(
			Buffer.from(calls[0]!.input["rawBodyBase64"] as string, "base64"),
		);
		expect(decoded).toEqual(RAW_BODY);
		// And specifically NOT a re-serialization: `JSON.stringify(JSON.parse(x))`
		// drops the trailing newline, which is exactly the byte a lazy
		// implementation loses and the HMAC would notice.
		expect(new TextDecoder().decode(decoded).endsWith("\n")).toBe(true);
	});

	test("a body that is not JSON at all still round-trips — this endpoint never parses it", async () => {
		const garbage = new Uint8Array([0x00, 0xff, 0x10, 0x7f, 0x41]);
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler, { body: garbage }));

		expect(calls).toHaveLength(1);
		expect(
			new Uint8Array(Buffer.from(calls[0]!.input["rawBodyBase64"] as string, "base64")),
		).toEqual(garbage);
	});

	test("the Stripe-Signature header is forwarded verbatim, and the route path is the plugin's public settle route", async () => {
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		expect(calls[0]!.route).toBe(STRIPE_WEBHOOK_SETTLE_ROUTE);
		expect(calls[0]!.input["stripeSignature"]).toBe(SIGNATURE);
	});

	test("the wire contract's required idempotencyKey is a non-empty string", async () => {
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		const key = calls[0]!.input["idempotencyKey"];
		expect(typeof key).toBe("string");
		expect((key as string).length).toBeGreaterThan(0);
	});

	test("no Stripe-Signature at all is rejected 400 HERE, without spending a dispatch", async () => {
		const { handler, calls } = makeDispatcher(OK);

		const response = await POST(makeContext(handler, { signature: null }));

		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

describe("POST /webhooks/stripe — the edge token", () => {
	test("provisioned ⇒ attached as X-Otta-Wh-Token, byte-identical", async () => {
		setToken("otta_edge_value");
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		expect(sentToken(calls[0]!)).toBe("otta_edge_value");
	});

	test("unprovisioned ⇒ the header is ABSENT (not empty) and the delivery is still forwarded", async () => {
		const { handler, calls } = makeDispatcher(OK);

		const response = await POST(makeContext(handler));

		expect(calls).toHaveLength(1);
		expect(sentToken(calls[0]!)).toBeUndefined();
		// Pass-through-when-unset is the plugin's gate, not this endpoint's
		// decision: refusing to forward here would turn an unprovisioned deploy
		// into "every webhook fails" instead of "Stripe HMAC only".
		expect(response.status).toBe(200);
	});

	test("a whitespace-only value is treated as unprovisioned, not sent as a blank token", async () => {
		setToken("   ");
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		expect(sentToken(calls[0]!)).toBeUndefined();
	});
});

/**
 * Run a recorded dispatch through the plugin's REAL token gate, against a kv
 * that answers exactly one key.
 *
 * The one place this suite crosses the boundary instead of faking it. Every
 * other case asserts what this endpoint SENDS; these two assert that the
 * plugin's own gate can still READ it out of the container this site actually
 * hands over. That container is a real `Headers` (trusted mode — see
 * `DispatchCall.headers`), and a plugin-side lookup that only enumerates own
 * properties finds nothing in one: the delivery would 401 with a correct token
 * attached. Faking the gate here would reproduce that bug rather than catch it.
 */
function gate(call: DispatchCall, configured: string): Promise<StripeWebhookSettleResult> {
	const ctx = {
		kv: {
			get: async (key: string): Promise<unknown> =>
				key === WEBHOOK_EDGE_TOKEN_KEY ? configured : null,
		},
	};
	return createStripeWebhookSettleHandler()(
		{
			input: call.input as never,
			request: {
				method: "POST",
				url: `/${call.route}`,
				headers: call.headers as unknown as Record<string, string>,
			},
		},
		ctx as never,
	) as Promise<StripeWebhookSettleResult>;
}

describe("POST /webhooks/stripe — the token survives the hop INTO the plugin's real gate", () => {
	test("a matching token gets PAST the gate — the next refusal is the unset webhook secret", async () => {
		setToken("otta_edge_value");
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		// 503 NOT_CONFIGURED is gate 2 (no `settings:stripeWebhookSecret` in this
		// fake kv), which is only reachable once gate 1 has accepted the token.
		expect(await gate(calls[0]!, "otta_edge_value")).toMatchObject({
			status: 503,
			reason: "NOT_CONFIGURED",
		});
	});

	test("an unprovisioned site against a provisioned plugin still 401s — the gate is real", async () => {
		const { handler, calls } = makeDispatcher(OK);

		await POST(makeContext(handler));

		expect(await gate(calls[0]!, "otta_edge_value")).toMatchObject({
			status: 401,
			reason: "UNAUTHORIZED",
		});
	});
});

describe("POST /webhooks/stripe — the plugin's status is replayed, never swallowed", () => {
	test("ok ⇒ 200", async () => {
		const { handler } = makeDispatcher(OK);

		expect((await POST(makeContext(handler))).status).toBe(200);
	});

	test("AMOUNT_MISMATCH ⇒ 200, so Stripe stops retrying an anomaly a retry cannot fix", async () => {
		const { handler } = makeDispatcher({ ok: false, status: 200, reason: "AMOUNT_MISMATCH" });

		const response = await POST(makeContext(handler));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ reason: "AMOUNT_MISMATCH" });
	});

	test("ORDER_NOT_FOUND ⇒ 404", async () => {
		const { handler } = makeDispatcher({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });

		expect((await POST(makeContext(handler))).status).toBe(404);
	});

	test("NOT_CONFIGURED ⇒ 503, so Stripe RETRIES an unprovisioned deploy rather than dropping the event", async () => {
		const { handler } = makeDispatcher({ ok: false, status: 503, reason: "NOT_CONFIGURED" });

		expect((await POST(makeContext(handler))).status).toBe(503);
	});
});

describe("POST /webhooks/stripe — the gate (an anonymous POST at the public URL)", () => {
	test("a forged, unsigned body is rejected 400 INVALID_SIGNATURE — the plugin's verdict, replayed", async () => {
		const { handler } = makeDispatcher({ ok: false, status: 400, reason: "INVALID_SIGNATURE" });

		const response = await POST(
			makeContext(handler, { body: new TextEncoder().encode('{"forged":true}') }),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, reason: "INVALID_SIGNATURE" });
	});

	test("a wrong edge token is rejected 401 UNAUTHORIZED and never becomes a 200", async () => {
		setToken("wrong-token");
		const { handler } = makeDispatcher({ ok: false, status: 401, reason: "UNAUTHORIZED" });

		const response = await POST(makeContext(handler));

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ ok: false, reason: "UNAUTHORIZED" });
	});

	test("no secret of either kind appears in the response body", async () => {
		setToken("otta_edge_NEVER_LEAK");
		const { handler } = makeDispatcher({ ok: false, status: 401, reason: "UNAUTHORIZED" });

		const body = await (await POST(makeContext(handler))).text();

		expect(body).not.toContain("otta_edge_NEVER_LEAK");
		expect(body).not.toContain(SIGNATURE);
	});
});

describe("POST /webhooks/stripe — fails closed", () => {
	test("only the PRIVATE dispatcher is bound ⇒ 500, and it is never called", async () => {
		const { handler, calls } = makeDispatcher(OK);

		const response = await POST(makeContext(handler, { private: true }));

		expect(response.status).toBe(500);
		expect(calls).toHaveLength(0);
	});

	test("a failed envelope ⇒ 500, so Stripe retries rather than treating a dispatch error as settled", async () => {
		const { handler } = makeDispatcher({ success: false });

		expect((await POST(makeContext(handler))).status).toBe(500);
	});
});
