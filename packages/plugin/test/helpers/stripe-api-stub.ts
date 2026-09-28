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
	/** Replace the responder (default: a successful PaymentIntent create). */
	respondWith(responder: StripeResponder): void;
	close(): Promise<void>;
}

/**
 * The default reply to `POST /v1/payment_intents`: a PaymentIntent with an id and
 * a client secret, numbered by arrival so two creates are distinguishable.
 */
export function createdIntent(
	req: StripeRecordedRequest,
	n: number,
): { status: number; body: unknown } {
	const orderId = req.form.get("metadata[order_id]") ?? "unknown";
	const id = `pi_stub_${String(n)}_${orderId}`;
	return { status: 200, body: { id, client_secret: `${id}_secret_stub` } };
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
 * address, which must be loopback: a sandbox test that reaches the real
 * internet through this proxy is a bug, and it fails loudly instead.
 */
export async function startStripeApiStub(): Promise<StripeApiStub> {
	const requests: StripeRecordedRequest[] = [];
	let responder: StripeResponder = (req) => createdIntent(req, requests.length);

	const server: Server = createServer((req, res) => {
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

			void forward(host, method, path, req.headers, raw).then(
				(forwarded) => {
					res.writeHead(forwarded.status, forwarded.headers);
					res.end(forwarded.body);
				},
				(err: unknown) => {
					res.writeHead(502, { "content-type": "text/plain" });
					res.end(`stripe-api-stub could not forward to ${host}: ${String(err)}`);
				},
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		address: `127.0.0.1:${String(port)}`,
		requests,
		respondWith(next) {
			responder = next;
		},
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

async function forward(
	host: string,
	method: string,
	path: string,
	headers: IncomingHttpHeaders,
	body: Buffer,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
	const hostname = host.replace(/:\d+$/, "");
	if (hostname !== "127.0.0.1" && hostname !== "localhost") {
		throw new Error(`refusing to forward a sandbox request to non-loopback host "${host}"`);
	}
	const outHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || name === "host" || name === "connection") continue;
		outHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	const res = await fetch(`http://${host}${path}`, {
		method,
		headers: outHeaders,
		...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
	});
	const resHeaders: Record<string, string> = {};
	res.headers.forEach((value, name) => {
		if (name !== "content-encoding" && name !== "content-length" && name !== "transfer-encoding") {
			resHeaders[name] = value;
		}
	});
	return { status: res.status, headers: resHeaders, body: Buffer.from(await res.arrayBuffer()) };
}
