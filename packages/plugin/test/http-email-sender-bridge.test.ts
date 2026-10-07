/**
 * The email senders over EmDash's sandbox bridge: no `AbortSignal` in `init`.
 *
 * Under EmDash's sandbox runner `ctx.http.fetch(url, init)` is a Workers RPC
 * call whose arguments are structured-cloned, and workerd refuses an
 * `AbortSignal` (`DataCloneError: AbortSignal serialization is not enabled.`,
 * measured in `emdash-sandbox-rpc.sandbox.test.ts`). So by default a send puts
 * no signal in `init` and bounds itself with a race against its own deadline,
 * which still rejects with `EmailSendTimeoutError(timeoutMs)`. Only a trusted
 * (in-process) host may opt back in to a signal (`trustedHost`).
 */
import { isEmailSendTimeoutError } from "@otta-sh/domain";
import { describe, expect, test, vi } from "vitest";
import { CtxHttpEmailSender } from "../src/email/ctx-http-email-sender.js";
import { EmailProviderError } from "../src/email/http-email-sender.js";
import { Smtp2goEmailSender } from "../src/email/smtp2go-email-sender.js";

const API_URL = "https://email.example/emails";

const input = {
	to: "buyer@example.test" as never,
	template: "order-confirmation" as const,
	data: { orderId: "ord_1", totalCents: 2599, currency: "USD" },
	idempotencyKey: "outbox_row_1",
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What the RPC does with an init it cannot clone: throws before sending. */
function bridgeFetch(seen: RequestInit[], answer: () => Response): Fetch {
	return async (_url, init) => {
		if (init?.signal != null) {
			throw new DOMException("AbortSignal serialization is not enabled.", "DataCloneError");
		}
		seen.push(init ?? {});
		return answer();
	};
}

/** Never answers and ignores any signal: only the sender's own race ends it. */
function neverAnswers(seen: RequestInit[]): Fetch {
	return (_url, init) => {
		seen.push(init ?? {});
		return new Promise<Response>(() => {});
	};
}

function endlessBody(status: number): { response: Response; cancelled: () => boolean } {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"data":'));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { response: new Response(stream, { status }), cancelled: () => cancelled };
}

function resend(fetch: Fetch, extra: { requestTimeoutMs?: number; trustedHost?: boolean } = {}) {
	return new CtxHttpEmailSender({ fetch, apiUrl: API_URL, from: "orders@shop.test", ...extra });
}

function smtp2go(fetch: Fetch, extra: { requestTimeoutMs?: number; trustedHost?: boolean } = {}) {
	return new Smtp2goEmailSender({ fetch, from: "orders@shop.test", region: "global", ...extra });
}

const SMTP2GO_SENT = { data: { succeeded: 1, failed: 0 } };

describe("email senders over the sandbox bridge (default: no signal in init)", () => {
	test("Resend and SMTP2GO each send through a bridge that refuses a signal", async () => {
		const seen: RequestInit[] = [];
		await resend(bridgeFetch(seen, () => new Response("{}", { status: 200 }))).send(input);
		await smtp2go(
			bridgeFetch(seen, () => new Response(JSON.stringify(SMTP2GO_SENT), { status: 200 })),
		).send(input);
		expect(seen).toHaveLength(2);
		for (const init of seen) expect("signal" in init).toBe(false);
		// The Resend dedupe key still travels.
		const headers = seen[0]?.headers as Record<string, string> | undefined;
		expect(headers?.["Idempotency-Key"]).toBe("outbox_row_1");
	});

	test("a provider that never answers (and ignores signals) is an EmailSendTimeoutError at the bound", async () => {
		for (const make of [resend, smtp2go]) {
			const seen: RequestInit[] = [];
			const started = Date.now();
			const err = await make(neverAnswers(seen), { requestTimeoutMs: 20 })
				.send(input)
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			expect(isEmailSendTimeoutError(err)).toBe(true);
			expect((err as { timeoutMs?: number }).timeoutMs).toBe(20);
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(seen[0]?.signal).toBeUndefined();
		}
	});

	test("an answer after the deadline is discarded and its body cancelled unread", async () => {
		let deliver: ((res: Response) => void) | undefined;
		const body = endlessBody(200);
		const sender = resend(
			() =>
				new Promise<Response>((resolve) => {
					deliver = resolve;
				}),
			{ requestTimeoutMs: 20 },
		);
		await expect(sender.send(input)).rejects.toMatchObject({ name: "EmailSendTimeoutError" });
		deliver?.(body.response);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(body.cancelled()).toBe(true);
	});

	test("SMTP2GO: a 2xx body that never ends is cut off at the deadline — ambiguous, and the stream is cancelled", async () => {
		const body = endlessBody(200);
		const err = await smtp2go(async () => body.response, { requestTimeoutMs: 20 })
			.send(input)
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		// The provider answered and may have sent: the attempt counts (as before).
		expect(err).toBeInstanceOf(EmailProviderError);
		expect((err as EmailProviderError).kind).toBe("ambiguous");
		expect(body.cancelled()).toBe(true);
	});

	test("Resend: a non-2xx body that never ends still fails with its status, and the stream is cancelled", async () => {
		const body = endlessBody(503);
		const err = await resend(async () => body.response, { requestTimeoutMs: 20 })
			.send(input)
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect(err).toBeInstanceOf(EmailProviderError);
		expect((err as EmailProviderError).status).toBe(503);
		expect(body.cancelled()).toBe(true);
	});

	test("Resend: a 2xx body it never reads is cancelled, not left open", async () => {
		const body = endlessBody(200);
		await resend(async () => body.response).send(input);
		expect(body.cancelled()).toBe(true);
	});

	test("a send that answers in time leaves no timer behind", async () => {
		vi.useFakeTimers();
		try {
			await resend(bridgeFetch([], () => new Response("{}", { status: 200 }))).send(input);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("trustedHost: a signal in init, for an in-process host only", () => {
	test("the request carries a signal, aborted at the deadline; the send is still a timeout", async () => {
		for (const make of [resend, smtp2go]) {
			const seen: RequestInit[] = [];
			await expect(
				make(neverAnswers(seen), { requestTimeoutMs: 20, trustedHost: true }).send(input),
			).rejects.toMatchObject({ name: "EmailSendTimeoutError" });
			expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
			expect(seen[0]?.signal?.aborted).toBe(true);
		}
	});
});
