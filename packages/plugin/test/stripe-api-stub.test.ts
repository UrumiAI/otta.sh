/**
 * The Stripe stub's PROXY RULE, pinned directly (the checkout sandbox suite only
 * ever exercises its happy path).
 *
 * The stub is workerd's global outbound, so every request the isolate makes
 * lands on it. It must forward ONLY to the origins the suite names — deciding
 * the destination from that list, never from the request — or it is an open
 * proxy keyed on a request's `Host` header: any local port, and, with the URL
 * assembled by string concatenation, a request-target of `@host/...` turning the
 * intended host into userinfo. Both shapes are sent here as raw HTTP, because a
 * well-behaved client would refuse to produce them.
 */
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startStripeApiStub, type StripeApiStub } from "./helpers/stripe-api-stub.js";

interface Target {
	server: Server;
	host: string;
	hits: string[];
}

async function startTarget(): Promise<Target> {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("reached");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return { server, host: `127.0.0.1:${String(port)}`, hits };
}

/** One raw HTTP/1.1 request through the stub; resolves with the status code. */
function rawRequest(stubAddress: string, requestTarget: string, host: string): Promise<number> {
	const [hostname, port] = stubAddress.split(":") as [string, string];
	return new Promise((resolve, reject) => {
		const socket = connect(Number(port), hostname, () => {
			socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
		});
		let response = "";
		socket.on("data", (chunk: Buffer) => {
			response += chunk.toString("utf8");
		});
		socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? "0")));
		socket.on("error", reject);
	});
}

let allowed: Target;
let other: Target;
let stub: StripeApiStub;

beforeAll(async () => {
	allowed = await startTarget();
	other = await startTarget();
	stub = await startStripeApiStub({ forwardTo: [`http://${allowed.host}`] });
});

afterAll(async () => {
	await stub.close();
	for (const target of [allowed, other]) {
		await new Promise<void>((resolve) => target.server.close(() => resolve()));
	}
});

describe("stripe-api-stub forwarding", () => {
	test("forwards a request for an allowlisted origin, path intact", async () => {
		expect(await rawRequest(stub.address, "/rpc?x=1", allowed.host)).toBe(200);
		expect(allowed.hits).toContain("/rpc?x=1");
		expect(stub.refused).toEqual([]);
	});

	test("refuses another loopback port — loopback alone is not an allowlist", async () => {
		expect(await rawRequest(stub.address, "/rpc", other.host)).toBe(502);
		expect(other.hits).toEqual([]);
		expect(stub.refused).toContain(`GET ${other.host}/rpc`);
	});

	test("refuses an absolute-form request-target — only origin-form paths are forwarded", async () => {
		// Node's parser ACCEPTS this form and hands the handler
		// `req.url === "http://<other>/rpc"`; the stub's own origin-form check is
		// what refuses it.
		expect(await rawRequest(stub.address, `http://${other.host}/rpc`, allowed.host)).toBe(502);
		expect(other.hits).toEqual([]);
		expect(stub.refused).toContain(`GET ${allowed.host}http://${other.host}/rpc`);
	});

	test("a request-target that would turn the host into userinfo never reaches another server", async () => {
		// Concatenated onto `http://<allowed>` this would read as
		// `http://<allowed>@<other>/rpc` — a request to <other>. Node's parser
		// rejects it before the handler today (400); the origin-form check above is
		// the stub's own line of defence if that ever changes (502).
		const status = await rawRequest(stub.address, `@${other.host}/rpc`, allowed.host);
		expect([400, 502]).toContain(status);
		expect(other.hits).toEqual([]);
	});

	test("refuses to be configured with a non-loopback origin", async () => {
		await expect(startStripeApiStub({ forwardTo: ["http://example.com"] })).rejects.toThrow(
			/loopback http origins only/,
		);
	});
});
