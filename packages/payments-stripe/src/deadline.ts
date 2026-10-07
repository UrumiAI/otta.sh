/**
 * One live Stripe call's time bound, WITHOUT an `AbortSignal` in `init` by default.
 *
 * WHY NO SIGNAL. Under EmDash's sandbox runner the plugin's `ctx.http.fetch(url,
 * init)` is a Workers RPC call to the host (`bridge.httpFetch(url, init)`), whose
 * arguments are structured-cloned, and workerd refuses to clone an `AbortSignal`:
 * `DataCloneError: AbortSignal serialization is not enabled.` (the
 * `enable_abortsignal_rpc` flag is experimental and the runner does not set it).
 * The refusal happens before anything is sent, so a signal in `init` made EVERY
 * Stripe call fail in sandboxed mode. Measured in real workerd by
 * `packages/plugin/test/emdash-sandbox-rpc.sandbox.test.ts`.
 *
 * WHAT BOUNDS THE CALL INSTEAD. A race: the request, and every body read that
 * follows it, loses to the call's own timer, which rejects with a
 * {@link StripeRequestTimeoutError}. Each caller's `catch` classifies that
 * rejection exactly as it classified the old abort, so a timeout is still
 * `retryable` on a read or an intent/customer/cancel create and `ambiguous` on a
 * refund create. A body read that loses has its reader cancelled; an answer that
 * arrives after the bound is discarded with its body cancelled unread; and a body
 * the call never read is cancelled when the call ends.
 *
 * THE COST, and the opt-in that removes it. Without a signal the host is never
 * told to stop: a timed-out request runs on in the background until the host's
 * own limits end it, and its answer is discarded. Nothing is retried because of
 * it — Stripe's idempotency key, not the transport, dedupes a caller's retry. A
 * TRUSTED (in-process) host can carry a signal, so `trustedHost: true` puts one
 * in `init` again, aborted by the same timer, and the socket is released. Never
 * set it under the sandbox runner: the RPC refuses the signal and every call fails.
 */

/** What a call's own bound rejects with. Never leaves the transport: every
 *  call site turns it into its result class. */
export class StripeRequestTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Stripe request timed out after ${String(timeoutMs)} ms`);
		this.name = "StripeRequestTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export interface CallDeadline {
	/** The request, raced against the bound. `init` gains a `signal` only on a
	 *  trusted host. */
	request(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response>;
	/** The body as JSON, read under the same bound (`res.json()`'s semantics). */
	readJson(res: Response): Promise<unknown>;
	/** Ends the call: clears the timer and cancels any body left unread. */
	close(): void;
}

function cancelBody(res: Response): void {
	try {
		const { body } = res;
		if (body === null || body === undefined || body.locked) return;
		void body.cancel().catch(() => {});
	} catch {
		// A response object that cannot even say what its body is has nothing to cancel.
	}
}

/** Start one call's bound of `timeoutMs` (already clamped by the caller). */
export function startDeadline(timeoutMs: number, trustedHost: boolean): CallDeadline {
	let expired = false;
	let closed = false;
	const controller = trustedHost ? new AbortController() : undefined;
	const handedOut: Response[] = [];
	let rejectExpiry: ((err: StripeRequestTimeoutError) => void) | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		rejectExpiry = reject;
	});
	// The bound may pass with no one racing it (between two awaits): never an
	// unhandled rejection.
	expiry.catch(() => {});
	const timer = setTimeout(() => {
		expired = true;
		const err = new StripeRequestTimeoutError(timeoutMs);
		controller?.abort(err);
		rejectExpiry?.(err);
	}, timeoutMs);

	const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expiry]);

	return {
		async request(doFetch, url, init) {
			if (expired) throw new StripeRequestTimeoutError(timeoutMs);
			const request = doFetch(
				url,
				controller !== undefined ? { ...init, signal: controller.signal } : init,
			);
			// Registered BEFORE the race, so it runs first: an answer in time is
			// tracked for `close`, a late one is discarded with its body cancelled.
			void Promise.resolve(request).then(
				(res) => {
					if (expired || closed) cancelBody(res);
					else handedOut.push(res);
				},
				() => {},
			);
			return await race(Promise.resolve(request));
		},

		async readJson(res) {
			if (expired) throw new StripeRequestTimeoutError(timeoutMs);
			const body = res.body;
			if (body === null || body === undefined || typeof body.getReader !== "function") {
				// No stream (EmDash's sandbox bridge answers a plain object whose
				// `json()` reads a body the host already buffered): race the read.
				return await race(Promise.resolve(res.json() as Promise<unknown>));
			}
			const reader = body.getReader();
			const read = (async (): Promise<string> => {
				const decoder = new TextDecoder();
				let text = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					text += decoder.decode(value, { stream: true });
				}
				return text + decoder.decode();
			})();
			read.catch(() => {});
			let text: string;
			try {
				text = await race(read);
			} catch (err) {
				void reader.cancel().catch(() => {});
				throw err;
			}
			return JSON.parse(text) as unknown;
		},

		close() {
			closed = true;
			clearTimeout(timer);
			for (const res of handedOut) cancelBody(res);
		},
	};
}
