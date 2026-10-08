/**
 * A late email answer, now that a timed-out send is abandoned rather than
 * aborted (no `AbortSignal` in `init` by default): what a retry does.
 *
 * Shape: a trusted Node host — real undici (`globalThis.fetch`) against a REAL
 * local "provider" that delivers on RECEIPT (the mail is queued) and answers
 * late. No real provider is called; there is no key.
 *
 * What this pins: the late 2xx is discarded as `EmailSendTimeoutError` (the row
 * goes back uncounted), and the retry carries the SAME `Idempotency-Key` as the
 * abandoned send, so Resend dedupes the second delivery, as on `main`.
 */
import { isEmailSendTimeoutError } from "@otta-sh/domain";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CtxHttpEmailSender } from "../src/email/ctx-http-email-sender.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Provider {
	base: string;
	delivered: { path: string; key: string | undefined }[];
	answerDelayMs: number;
	close(): Promise<void>;
}

async function startProvider(): Promise<Provider> {
	const sockets = new Set<Socket>();
	const provider = { delivered: [], answerDelayMs: 0 } as unknown as Provider;
	const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		for await (const chunk of req) void chunk;
		provider.delivered.push({
			path: req.url ?? "",
			key: req.headers["idempotency-key"] as string | undefined,
		});
		await sleep(provider.answerDelayMs);
		if (res.destroyed) return;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id: "em_late_1" }));
	});
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("provider has no port");
	provider.base = `http://127.0.0.1:${String(address.port)}`;
	provider.close = async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	return provider;
}

let provider: Provider;
beforeEach(async () => {
	provider = await startProvider();
});
afterEach(async () => {
	await provider.close();
});

async function timesOut(send: Promise<void>): Promise<boolean> {
	try {
		await send;
		return false;
	} catch (err) {
		return isEmailSendTimeoutError(err);
	}
}

const input = (key: string) => ({
	to: "buyer@example.test" as never,
	template: "order-confirmation" as const,
	data: { orderId: "ord_1", totalCents: 2599, currency: "USD" },
	idempotencyKey: key,
});

describe("Resend answered after the send's deadline", () => {
	test("the late 2xx is a timeout, and the retry carries the SAME Idempotency-Key", async () => {
		provider.answerDelayMs = 400;
		const sender = new CtxHttpEmailSender({
			fetch: (url, init) => globalThis.fetch(url.replace(/^https:\/\/[^/]+/, provider.base), init),
			apiUrl: "https://email.example/emails",
			from: "orders@shop.test",
			requestTimeoutMs: 100,
		});
		expect(await timesOut(sender.send(input("outbox_row_7")))).toBe(true);
		await sleep(500);
		expect(await timesOut(sender.send(input("outbox_row_7")))).toBe(true);
		await sleep(500);
		// Both were delivered to the provider; the shared key is what lets Resend
		// drop the second.
		expect(provider.delivered.map((d) => d.key)).toEqual(["outbox_row_7", "outbox_row_7"]);
	});
});
