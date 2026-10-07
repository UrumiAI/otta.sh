/**
 * The console's ONE request outside the `otta` admin route: uploading a digital
 * product's file to the site (issue #376, increment 4).
 *
 * ADR-0029 amends ADR-0014 Decision 3 for exactly this. A paid file must reach
 * the private `DOWNLOADS` R2 bucket, and only the SITE holds that binding — the
 * plugin can neither read R2 nor receive a byte stream, and EmDash's media
 * bucket is public — so the product editor's Download file card POSTs the raw
 * bytes to the site's `/otta-admin/downloads/<productId>`, which stores them
 * under a key it mints and answers a descriptor. This module carries bytes and
 * nothing else: it reads no commerce data and writes none. The descriptor is
 * saved through the admin route (`products:attach-download`, in
 * `console-api.ts`'s `performAction`) like every other product edit. A second
 * request of any kind here reopens ADR-0029.
 *
 * XMLHttpRequest, NOT fetch: only XHR reports UPLOAD progress, and a 100 MB file
 * with no progress reads as a hang. Same-origin, with the operator's session
 * cookie, and with the `X-EmDash-Request: 1` header EmDash's own authenticated
 * API requires — the endpoint requires it too, so a cross-site form can never
 * reach it.
 *
 * FAILURES ARE VALUES, as in `console-api.ts`: nothing here throws at a
 * component; every outcome is an `{ok: true, asset}` or a {@link Failure}
 * carrying the sentence the merchant reads.
 */
import type { Failure } from "./console-api.js";

/** The site endpoint's path prefix (`sites/staging/src/lib/download-upload.ts`). */
export const DOWNLOAD_UPLOAD_PATH_PREFIX = "/otta-admin/downloads/";

/** The header the file's name travels in, percent-encoded. */
export const DOWNLOAD_FILENAME_HEADER = "X-Otta-Filename";

/** The largest file the endpoint accepts — under Cloudflare's 100 MB request
 *  limit (Free/Pro) however a megabyte is counted. The card checks a file
 *  against it before sending a byte. */
export const MAX_DOWNLOAD_FILE_BYTES = 100_000_000;

/** The upload URL for one product. */
export function downloadUploadUrl(productId: string): string {
	return `${DOWNLOAD_UPLOAD_PATH_PREFIX}${encodeURIComponent(productId)}`;
}

/** The descriptor the endpoint answers — what the card then saves. */
export interface UploadedAsset {
	readonly key: string;
	readonly filename: string;
	readonly contentType: string;
	readonly size: number;
}

export type UploadResult = { readonly ok: true; readonly asset: UploadedAsset } | Failure;

/** Bytes sent so far, of how many. */
export type UploadProgress = (loaded: number, total: number) => void;

const NOT_UPLOADED = "The file wasn't uploaded";

/** The endpoint's descriptor, checked field by field: it crossed HTTP. */
function readAsset(value: unknown): UploadedAsset | null {
	if (typeof value !== "object" || value === null) return null;
	const { key, filename, contentType, size } = value as Record<string, unknown>;
	if (
		typeof key !== "string" ||
		typeof filename !== "string" ||
		typeof contentType !== "string" ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size)
	) {
		return null;
	}
	return { key, filename, contentType, size };
}

/** The sentence for a refusal: the endpoint's own message when it sent one. */
function refusal(status: number, body: unknown): Failure {
	const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
	const fallback =
		status === 401
			? "Your session is no longer valid. Reload this page to sign in again."
			: status === 413
				? "This file is too large. Download files can be at most 100 MB."
				: status >= 500
					? "The store could not take the file just now. Try again in a moment."
					: "The store would not take this file. Reload the page and try again.";
	return {
		ok: false,
		status,
		title: NOT_UPLOADED,
		description: typeof message === "string" && message.length > 0 ? message : fallback,
	};
}

/**
 * Upload one file for one product. Resolves with the stored descriptor, or a
 * {@link Failure}; never rejects. `onProgress` is called as bytes leave the
 * browser.
 */
export function uploadDownloadFile(
	productId: string,
	file: File,
	onProgress: UploadProgress,
): Promise<UploadResult> {
	return new Promise<UploadResult>((resolve) => {
		let xhr: XMLHttpRequest;
		try {
			xhr = new XMLHttpRequest();
			xhr.open("POST", downloadUploadUrl(productId));
			xhr.setRequestHeader("X-EmDash-Request", "1");
			// The browser's guess at the type; the endpoint coerces it to its
			// allowlist and never trusts it for anything a browser would render.
			xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
			xhr.setRequestHeader(DOWNLOAD_FILENAME_HEADER, encodeURIComponent(file.name));
		} catch (error) {
			resolve(transport(error));
			return;
		}
		xhr.upload.addEventListener("progress", (event) => {
			onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
		});
		xhr.addEventListener("load", () => {
			let body: unknown = null;
			try {
				body = JSON.parse(xhr.responseText) as unknown;
			} catch {
				body = null;
			}
			if (xhr.status === 201) {
				const asset = readAsset((body as { asset?: unknown } | null)?.asset);
				if ((body as { ok?: unknown } | null)?.ok === true && asset !== null) {
					resolve({ ok: true, asset });
					return;
				}
				resolve({
					ok: false,
					status: xhr.status,
					title: NOT_UPLOADED,
					description:
						"The store's answer could not be read. Reload the page and upload the file again.",
				});
				return;
			}
			resolve(refusal(xhr.status, body));
		});
		xhr.addEventListener("error", () => {
			resolve(transport(null));
		});
		xhr.addEventListener("abort", () => {
			resolve({
				ok: false,
				title: NOT_UPLOADED,
				description: "The upload was cancelled. Choose the file again to upload it.",
			});
		});
		try {
			xhr.send(file);
		} catch (error) {
			resolve(transport(error));
		}
	});
}

/** No answer came back: the connection, not the store. */
function transport(error: unknown): Failure {
	return {
		ok: false,
		title: NOT_UPLOADED,
		description: `The upload did not finish${
			error instanceof Error ? ` — ${error.message}` : ""
		}. Check that you are online, then upload the file again.`,
	};
}
