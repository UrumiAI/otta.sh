/**
 * A fake x402 facilitator behind the injected `fetch` (ADR-0028 Decision 12).
 *
 * It records every request and counts calls per path, so a test can say "this
 * payload reached `/verify` and `/settle` zero times" — the property the
 * adapter's cheap refusals exist for. Each path answers from a script: a status
 * and body, a thrown transport error, or a hang that only an abort ends.
 *
 * The final `Response.url` is settable, because the adapter treats a response
 * whose `url` differs from the one it asked for as a redirect (Decision 8). By
 * default the fake answers from the URL it was asked, as `fetch` does.
 */

export const FAKE_FACILITATOR_URL = "https://facilitator.test/x402";

export interface FakeAnswer {
	status?: number;
	/** A string is sent verbatim; anything else is JSON-encoded. */
	body?: unknown;
	/** The final URL the response claims; defaults to the requested URL. */
	url?: string;
	headers?: Record<string, string>;
	/** Stream the body and never finish it. */
	bodyNeverEnds?: boolean;
}

export type FakeScript =
	| FakeAnswer
	| { throws: Error }
	/** Never answers; rejects with an AbortError when the signal aborts. */
	| { hang: true }
	/** Never answers and ignores the signal: only the adapter's own race ends it. */
	| { hangIgnoringSignal: true };

export interface RecordedRequest {
	url: string;
	path: string;
	method: string | undefined;
	headers: Record<string, string>;
	body: unknown;
	redirect: RequestInit["redirect"];
	hadSignal: boolean;
}

export interface FakeFacilitator {
	readonly baseUrl: string;
	readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
	readonly calls: { verify: number; settle: number; other: number };
	readonly requests: RecordedRequest[];
	onVerify(script: FakeScript): void;
	onSettle(script: FakeScript): void;
}

export function createFakeFacilitator(baseUrl = FAKE_FACILITATOR_URL): FakeFacilitator {
	const calls = { verify: 0, settle: 0, other: 0 };
	const requests: RecordedRequest[] = [];
	const scripts: { verify: FakeScript; settle: FakeScript } = {
		verify: { status: 200, body: { isValid: true } },
		settle: { status: 500, body: "no settle script" },
	};

	async function fetch(url: string, init?: RequestInit): Promise<Response> {
		const path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		requests.push({
			url,
			path,
			method: init?.method,
			headers,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			redirect: init?.redirect,
			hadSignal: init?.signal != null,
		});
		let script: FakeScript;
		if (path === "/verify") {
			calls.verify += 1;
			script = scripts.verify;
		} else if (path === "/settle") {
			calls.settle += 1;
			script = scripts.settle;
		} else {
			calls.other += 1;
			return answer(url, { status: 404, body: "not found" });
		}
		if ("throws" in script) throw script.throws;
		if ("hangIgnoringSignal" in script) return new Promise<Response>(() => {});
		if ("hang" in script) {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			});
		}
		return answer(url, script);
	}

	return {
		baseUrl,
		fetch,
		calls,
		requests,
		onVerify(script) {
			scripts.verify = script;
		},
		onSettle(script) {
			scripts.settle = script;
		},
	};
}

function answer(requestedUrl: string, script: FakeAnswer): Response {
	const text =
		script.body === undefined
			? ""
			: typeof script.body === "string"
				? script.body
				: JSON.stringify(script.body);
	const body = script.bodyNeverEnds
		? new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(text));
					// never closed
				},
			})
		: text;
	const response = new Response(body, {
		status: script.status ?? 200,
		headers: { "content-type": "application/json", ...script.headers },
	});
	// `Response.url` is a read-only getter, empty for a constructed Response; a
	// real fetch sets it to the URL the answer came from.
	Object.defineProperty(response, "url", { value: script.url ?? requestedUrl });
	return response;
}
