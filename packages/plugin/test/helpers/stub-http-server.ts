import { createServer, type Server } from "node:http";

export interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export type StubResponder = (req: RecordedRequest) => { status: number; body: unknown };

export interface StubHttpServer {
	baseUrl: string;
	/** Hostname only (no port) — `ctx.http`'s allowedHosts check matches on
	 *  `new URL(url).hostname`, which never includes the port. */
	host: string;
	requests: RecordedRequest[];
	respondWith(method: string, responder: StubResponder): void;
	close(): Promise<void>;
}

/**
 * A tiny hand-rolled, GENERIC recording HTTP server for tests — it records every
 * request it receives and replies per a test-configured responder, and it cares
 * nothing about what the endpoint is supposed to be.
 *
 * WHAT IT IS FOR NOW: standing in for an ARBITRARY external host so a sandbox
 * test can prove the `ctx.http` egress rules. It backs the email API in the
 * `allowedHosts` harness test, and a Settings re-render in the Stripe settle
 * route test that asserts no secret leaks outbound. It once stood in for the
 * separate commerce service as well; that service is gone, and these uses are
 * not, which is why the helper is named for what it does rather than for who it
 * used to impersonate.
 */
export async function startStubHttpServer(): Promise<StubHttpServer> {
	const requests: RecordedRequest[] = [];
	const responders = new Map<string, StubResponder>();

	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks).toString("utf8");
			let body: unknown;
			if (rawBody.length > 0) {
				try {
					body = JSON.parse(rawBody);
				} catch {
					body = rawBody;
				}
			}
			const method = req.method ?? "GET";
			const recorded: RecordedRequest = {
				method,
				url: req.url ?? "/",
				headers: req.headers as Record<string, string | string[] | undefined>,
				body,
			};
			requests.push(recorded);
			const responder = responders.get(method) ?? responders.get("*");
			const result = responder
				? responder(recorded)
				: { status: 404, body: { error: "no responder configured" } };
			res.writeHead(result.status, { "content-type": "application/json" });
			res.end(result.body === undefined ? "" : JSON.stringify(result.body));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		host: "127.0.0.1",
		requests,
		respondWith(method, responder) {
			responders.set(method, responder);
		},
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}
