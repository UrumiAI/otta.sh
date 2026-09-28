import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { STRIPE_API_HOST } from "../../src/manifest.js";

/** One request the plugin made to `api.stripe.com`, as the stub received it. */
export interface StripeRecordedRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	/** The raw `application/x-www-form-urlencoded` body, parsed. */
	form: URLSearchParams;
}

export type StripeResponder = (req: StripeRecordedRequest) => { status: number; body: unknown };

export interface StripeApiStub {
	/** `host:port` — what {@link SandboxOptions.globalOutbound} takes. */
	address: string;
	/** Every request that was addressed to `api.stripe.com`, in arrival order. */
	requests: StripeRecordedRequest[];
	/**
	 * Every request this proxy REFUSED to forward (a non-Stripe, non-loopback
	 * host). Inside the isolate a refusal is just a 502 the plugin may swallow as
	 * an ordinary provider failure, so a suite asserts this is empty rather than
	 * trusting a route's answer to surface it.
	 */
	refused: string[];
	/** Replace the responder for the rest of the case. */
	respondWith(responder: StripeResponder): void;
	/** Clear `requests`, `refused` and the idempotency memory, and restore
	 *  {@link stripeLikeResponder}. */
	reset(): void;
	close(): Promise<void>;
}

/** Stripe's error envelope for a request it rejects before doing anything. */
function invalidRequest(code: string, message: string): { status: number; body: unknown } {
	return { status: 400, body: { error: { type: "invalid_request_error", code, message } } };
}

/**
 * The default responder: `POST /v1/payment_intents` answered the way Stripe
 * answers it, including the refusals — so a case cannot pass on a reply real
 * Stripe would never give.
 *
 *  - `amount` must be a positive integer string and `currency` a lowercase
 *    three-letter code; anything else is a 400 `invalid_request_error`.
 *  - Stripe's native idempotency: a repeated `Idempotency-Key` with the SAME
 *    parameters returns the SAME PaymentIntent, and with DIFFERENT parameters is
 *    a 400 `idempotency_error`.
 *
 * `n` numbers new intents so two distinct creates are distinguishable.
 */
export function stripeLikeResponder(): StripeResponder {
	const byKey = new Map<string, { params: string; reply: { status: number; body: unknown } }>();
	let n = 0;
	return (req) => {
		const amount = req.form.get("amount") ?? "";
		const currency = req.form.get("currency") ?? "";
		if (!/^[1-9]\d*$/.test(amount)) {
			return invalidRequest("parameter_invalid_integer", `Invalid integer: ${amount}`);
		}
		if (!/^[a-z]{3}$/.test(currency)) {
			return invalidRequest("parameter_invalid_string", `Invalid currency: ${currency}`);
		}

		const key = req.headers["idempotency-key"];
		const params = req.form.toString();
		const previous = typeof key === "string" ? byKey.get(key) : undefined;
		if (previous !== undefined) {
			return previous.params === params
				? previous.reply
				: {
						status: 400,
						body: {
							error: {
								type: "idempotency_error",
								message: "Keys for idempotent requests can only be used with the same parameters",
							},
						},
					};
		}

		n += 1;
		const orderId = req.form.get("metadata[order_id]") ?? "unknown";
		const id = `pi_stub_${String(n)}_${orderId}`;
		const reply = { status: 200, body: { id, client_secret: `${id}_secret_stub` } };
		if (typeof key === "string") byKey.set(key, { params, reply });
		return reply;
	};
}

/**
 * A stand-in for the Stripe API that a sandboxed plugin can actually reach.
 *
 * WHY IT IS AN OUTBOUND PROXY rather than a host in `allowedHosts`. The Stripe
 * gateway's URL is not configurable from the plugin — it always calls
 * `https://api.stripe.com` — and pointing it anywhere else would mean a test-only
 * seam in `src/`. Instead the harness sets this server as workerd's
 * `globalOutbound`, so every outbound request the isolate makes arrives here as
 * plain HTTP with its original `Host` header. The plugin's own `ctx.http`
 * allowlist check still runs first, against the real hostname, so a boot that
 * does not grant `api.stripe.com` is still refused inside the isolate.
 *
 * Requests addressed to `api.stripe.com` are recorded and answered. Everything
 * else — in practice the harness's storage bridge — is forwarded to its own
 * address, which must be loopback. Anything else is refused, never forwarded, and
 * recorded in {@link StripeApiStub.refused} so the suite can fail on it: a
 * sandbox test must never reach the real internet through this proxy.
 */
export async function startStripeApiStub(): Promise<StripeApiStub> {
	const requests: StripeRecordedRequest[] = [];
	const refused: string[] = [];
	let responder: StripeResponder = stripeLikeResponder();

	const server: Server = createServer((req, res) => {
		const fail = (err: unknown) => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end(`stripe-api-stub: ${String(err)}`);
		};
		req.on("error", fail);
		res.on("error", () => {
			// The isolate hung up; there is no one left to answer.
		});

		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks);
			const host = req.headers.host ?? "";
			const method = req.method ?? "GET";
			const path = req.url ?? "/";

			if (host === STRIPE_API_HOST) {
				const recorded: StripeRecordedRequest = {
					method,
					path,
					headers: req.headers,
					form: new URLSearchParams(raw.toString("utf8")),
				};
				requests.push(recorded);
				const reply = responder(recorded);
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(reply.body));
				return;
			}

			if (!isLoopback(host)) {
				refused.push(`${method} ${host}${path}`);
				fail(new Error(`refusing to forward a sandbox request to non-loopback host "${host}"`));
				return;
			}

			void forward(host, method, path, req.headers, raw).then((forwarded) => {
				res.writeHead(forwarded.status, forwarded.headers);
				res.end(forwarded.body);
			}, fail);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		address: `127.0.0.1:${String(port)}`,
		requests,
		refused,
		respondWith(next) {
			responder = next;
		},
		reset() {
			requests.length = 0;
			refused.length = 0;
			responder = stripeLikeResponder();
		},
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

function isLoopback(host: string): boolean {
	const hostname = host.replace(/:\d+$/, "");
	return hostname === "127.0.0.1" || hostname === "localhost";
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection, not the
 * request, so a proxy must not forward them — and undici's `fetch` rejects
 * several outright. `content-length` goes too: the body is re-sent whole.
 */
const HOP_BY_HOP = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

async function forward(
	host: string,
	method: string,
	path: string,
	headers: IncomingHttpHeaders,
	body: Buffer,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
	const outHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP_BY_HOP.has(name)) continue;
		outHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	const res = await fetch(`http://${host}${path}`, {
		method,
		headers: outHeaders,
		...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
	});
	const resHeaders: Record<string, string> = {};
	res.headers.forEach((value, name) => {
		if (!HOP_BY_HOP.has(name) && name !== "content-encoding") resHeaders[name] = value;
	});
	return { status: res.status, headers: resHeaders, body: Buffer.from(await res.arrayBuffer()) };
}
