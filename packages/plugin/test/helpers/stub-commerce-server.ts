import { createServer, type Server } from "node:http";

export interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export type StubResponder = (req: RecordedRequest) => { status: number; body: unknown };

export interface StubCommerceServer {
	baseUrl: string;
	/** Hostname only (no port) — `ctx.http`'s allowedHosts check matches on
	 *  `new URL(url).hostname`, which never includes the port. */
	host: string;
	requests: RecordedRequest[];
	respondWith(method: string, responder: StubResponder): void;
	close(): Promise<void>;
}

/** A tiny hand-rolled HTTP stub standing in for `@urumi/service` (plan §6
 *  step 1) — records every request it receives and replies per a
 *  test-configured responder. */
export async function startStubCommerceServer(): Promise<StubCommerceServer> {
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
