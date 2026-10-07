/**
 * One email send's time bound, WITHOUT an `AbortSignal` in `init` by default.
 *
 * WHY NO SIGNAL. Under EmDash's sandbox runner `ctx.http.fetch(url, init)` is a
 * Workers RPC call to the host (`bridge.httpFetch(url, init)`), whose arguments
 * are structured-cloned, and workerd refuses to clone an `AbortSignal`
 * (`DataCloneError: AbortSignal serialization is not enabled.`; the
 * `enable_abortsignal_rpc` flag is experimental and the runner does not set it).
 * A signal in `init` made every send fail in sandboxed mode before anything was
 * sent. Measured in real workerd by `test/emdash-sandbox-rpc.sandbox.test.ts`.
 *
 * WHAT BOUNDS THE SEND INSTEAD. A race: the request, and the provider's body
 * read after it, lose to the send's own timer, which rejects with
 * `EmailSendTimeoutError(timeoutMs)` — the same typed timeout the dispatcher
 * already hands back uncounted. A body read that loses has its reader
 * cancelled (and, read through `readProviderJson`, says nothing — so an
 * SMTP2GO 2xx cut off by the deadline is still `ambiguous`, as before); an
 * answer that arrives after the deadline is discarded with its body cancelled;
 * a body nobody read (a Resend 2xx) is cancelled when the send ends. The
 * deadline bounds a read in TIME; a caller may also bound it in BYTES
 * (`bounded(res, maxBytes)`), as the senders do for a non-2xx error body.
 *
 * TWIN of `@otta-sh/payments-stripe`'s `src/deadline.ts` (the package graph
 * keeps them apart: Stripe cannot import the plugin, and the domain stays
 * IO-free; `@otta-sh/payments-x402`'s facilitator race is a third variant).
 * Keep them in step: a fix to one is very likely owed to the other.
 *
 * THE COST, and the opt-in that removes it. With no signal the host is never
 * told to stop: a timed-out request runs on in the background until the host's
 * own limits end it, and its answer is discarded. A TRUSTED (in-process) host
 * can carry a signal, so `trustedHost: true` puts one in `init` again, aborted
 * by the same timer, and the socket is released. Never under the sandbox
 * runner: the RPC refuses it and every send fails.
 */
import { EmailSendTimeoutError } from "@otta-sh/domain";

/** The part of a provider's answer a sender reads: the status, and the body as
 *  text — read under the send's deadline. */
export interface ProviderResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}

export interface SendDeadline {
	/** Whether the bound has passed (a trusted host's transport may reject with
	 *  its own abort error, which is then this send's timeout). */
	readonly expired: boolean;
	request(
		fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
		url: string,
		init: RequestInit,
	): Promise<Response>;
	/** `res` with its body read under the same bound. With `maxBytes`, a streamed
	 *  body is read only that far (whole chunks: the last may overshoot it), then
	 *  cancelled, and what was read is the text; a body with no stream (the
	 *  sandbox bridge's answer) was already buffered by the host and is read whole. */
	bounded(res: Response, maxBytes?: number): ProviderResponse;
	/** Ends the send: clears the timer and cancels any body left unread. */
	close(): void;
}

function cancelBody(res: Response): void {
	try {
		const { body } = res;
		if (body === null || body === undefined || body.locked) return;
		void body.cancel().catch(() => {});
	} catch {
		// Nothing to cancel on a response that cannot say what its body is.
	}
}

export function startSendDeadline(timeoutMs: number, trustedHost: boolean): SendDeadline {
	let expired = false;
	let closed = false;
	const controller = trustedHost ? new AbortController() : undefined;
	const handedOut: Response[] = [];
	let rejectExpiry: ((err: EmailSendTimeoutError) => void) | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		rejectExpiry = reject;
	});
	expiry.catch(() => {});
	const timer = setTimeout(() => {
		expired = true;
		const err = new EmailSendTimeoutError(timeoutMs);
		controller?.abort(err);
		rejectExpiry?.(err);
	}, timeoutMs);

	const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expiry]);

	return {
		get expired() {
			return expired;
		},

		async request(fetchFn, url, init) {
			if (expired) throw new EmailSendTimeoutError(timeoutMs);
			const request = Promise.resolve(
				fetchFn(url, controller !== undefined ? { ...init, signal: controller.signal } : init),
			);
			// Registered BEFORE the race, so it runs first: an answer in time is
			// tracked for `close`, a late one is discarded with its body cancelled.
			void request.then(
				(res) => {
					if (expired || closed) cancelBody(res);
					else handedOut.push(res);
				},
				() => {},
			);
			return await race(request);
		},

		bounded(res, maxBytes) {
			return {
				ok: res.ok,
				status: res.status,
				async text() {
					if (expired) throw new EmailSendTimeoutError(timeoutMs);
					const body = res.body;
					if (body === null || body === undefined || typeof body.getReader !== "function") {
						// No stream (the sandbox bridge's answer, already buffered by the host).
						return await race(Promise.resolve(res.text()));
					}
					const reader = body.getReader();
					const read = (async (): Promise<string> => {
						const decoder = new TextDecoder();
						let text = "";
						let bytes = 0;
						for (;;) {
							if (maxBytes !== undefined && bytes >= maxBytes) {
								// Enough to say why: the rest is not read, and not left open.
								void reader.cancel().catch(() => {});
								return text;
							}
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength;
							text += decoder.decode(value, { stream: true });
						}
						return text + decoder.decode();
					})();
					read.catch(() => {});
					try {
						return await race(read);
					} catch (err) {
						void reader.cancel().catch(() => {});
						throw err;
					}
				},
			};
		},

		close() {
			closed = true;
			clearTimeout(timer);
			for (const res of handedOut) cancelBody(res);
		},
	};
}
