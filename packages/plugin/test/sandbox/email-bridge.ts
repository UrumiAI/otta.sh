/**
 * The workerd suites' EmDash email provider: a loopback recorder standing in for
 * the host's email pipeline behind `ctx.email` (ADR-0031).
 *
 * In a deploy the host runs `email:beforeSend`, then the selected provider's
 * `email:deliver`. Here the isolate's `ctx.email.send` (`sandbox-entry.ts`)
 * calls the replaced `sandbox-email.ts`, which POSTs the message to this server,
 * which records it. It proves what the plugin HANDS the host — every message,
 * exactly — and nothing about the host's own pipeline.
 *
 * ONE SERVER PER BOOT, so `sentEmails()` is that boot's messages and nothing
 * else's.
 */
import { createServer, type Server } from "node:http";
import type { EmailMessage } from "../../src/types.js";

export interface EmailBridge {
	/** Base URL the worker posts to, e.g. `http://127.0.0.1:1234`. */
	readonly baseUrl: string;
	/** Every message received, in order. */
	readonly messages: EmailMessage[];
	close(): Promise<void>;
}

/** A bridge that REFUSES every message the way a failing provider does (a
 *  daily quota, issue #677): status 500, and a reason that quotes the
 *  recipient, as a provider's error may. Nothing is recorded. */
export const FAILING_PROVIDER_REASON = "daily sending quota exceeded for";

export async function emailBridge(options: { failing?: boolean } = {}): Promise<EmailBridge> {
	const messages: EmailMessage[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmailMessage;
				if (options.failing === true) {
					res
						.writeHead(500, { "content-type": "text/plain" })
						.end(`${FAILING_PROVIDER_REASON} ${message.to}`);
					return;
				}
				messages.push(message);
				res.writeHead(204).end();
			} catch (err) {
				res.writeHead(400, { "content-type": "text/plain" }).end(String(err));
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${String(port)}`,
		messages,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** The `sandbox-email.ts` the harness writes over the scratch copy: every
 *  message goes to the bridge; a refusal is a rejected send, with the bridge's
 *  own text as its message when it gave one. */
export function sandboxEmailSource(bridgeBaseUrl: string): string {
	return [
		`const BRIDGE = ${JSON.stringify(bridgeBaseUrl)};`,
		"",
		"export function sandboxEmail() {",
		"\treturn async (message) => {",
		"\t\tconst res = await globalThis.fetch(BRIDGE, {",
		'\t\t\tmethod: "POST",',
		'\t\t\theaders: { "content-type": "application/json" },',
		"\t\t\tbody: JSON.stringify(message),",
		"\t\t});",
		"\t\tif (!res.ok) throw new Error((await res.text()) || `email bridge refused: ${String(res.status)}`);",
		"\t};",
		"}",
		"",
	].join("\n");
}
