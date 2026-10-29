/**
 * Read a request body with a hard byte cap, BEFORE anything buffers it (#605).
 *
 * `arrayBuffer()` and `formData()` take whatever the caller sends. On the
 * public endpoints that call them — the Stripe webhook (anyone with any
 * non-empty `stripe-signature`) and the storefront form posts — that made a
 * single large POST an isolate-memory lever: a Worker isolate is shared by
 * concurrent requests, and holding ~90 MB as bytes + string + base64 + JSON
 * runs it past its 128 MB limit and kills every other shopper's request in it.
 * EmDash's own 1 MiB plugin-route cap applies only after the site has already
 * buffered, so it does not help here.
 *
 * Two checks, because either alone has a hole: a declared `Content-Length`
 * over the cap is refused without touching the body at all, and the stream
 * read stops — and cancels the upload — the moment the running total passes
 * the cap, which covers a chunked body that declares no length (or lies).
 */

/** `null` when the body is over `maxBytes`; otherwise its exact bytes (empty
 *  when there is no body). */
export async function readCappedBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxBytes) return null;
	}
	if (request.body === null) return new Uint8Array(0);

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}

	if (chunks.length === 1) return chunks[0]!;
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
