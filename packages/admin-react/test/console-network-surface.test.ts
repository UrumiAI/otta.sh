/**
 * The console's network surface, pinned (ADR-0014 Decision 3, amended by
 * ADR-0029).
 *
 * Every read and write of commerce data goes through `console-api.ts`, which
 * calls EmDash's `apiFetch` against the `otta` admin route. The ONE other request
 * the console may make is the Download file card's upload of a file to the site,
 * in `download-upload-api.ts`. This suite reads the package's source so that a
 * second request — a bare `fetch`, another `XMLHttpRequest`, a beacon, a socket,
 * a dynamically imported module — fails here instead of quietly widening what
 * ADR-0029 allowed.
 *
 * TWO DELIBERATE CARVE-OUTS, each tested below so they cannot grow:
 *  - an injected callback that happens to be NAMED `fetch` (the list
 *    accumulator's `opts.fetch`, declared `fetch:` and called as a member) is
 *    not the global — the detector skips member access and property keys, and
 *    catches the global through `globalThis.` / `window.` / `self.` explicitly;
 *  - `navigator.clipboard` (the copy button) makes no request.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Code only: comments may name what they forbid. */
function codeOf(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sources(): Array<{ file: string; code: string }> {
	const out: Array<{ file: string; code: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(entry.name)) {
				out.push({ file: path.relative(SRC, full), code: codeOf(readFileSync(full, "utf8")) });
			}
		}
	};
	walk(SRC);
	return out;
}

/** Any way of making a request that is not the two sanctioned ones. */
const FORBIDDEN: readonly RegExp[] = [
	// The global `fetch`, called or taken — but not `x.fetch` or a `fetch:` key.
	/(?<![.\w$])fetch\b(?!\s*\??:)/,
	/\b(globalThis|window|self)\s*\.\s*fetch\b/,
	/\bsendBeacon\b/,
	/\bEventSource\b/,
	/\bWebSocket\b/,
	/\bnavigator\s*\.(?!\s*clipboard\b)/,
	/\bimport\s*\(/,
];

const forbiddenIn = (code: string): boolean => FORBIDDEN.some((pattern) => pattern.test(code));

describe("the detector itself", () => {
	test.each([
		"fetch(url)",
		"await fetch('/x')",
		"const f = fetch;",
		"globalThis.fetch(url)",
		"window . fetch(url)",
		"self.fetch",
		"navigator.sendBeacon('/x')",
		"navigator.serviceWorker",
		"new EventSource('/x')",
		"new WebSocket('wss://x')",
		"await import('./x.js')",
		"import ( url )",
	])("flags %j", (code) => {
		expect(forbiddenIn(code)).toBe(true);
	});

	test.each([
		"apiFetch(OTTA_ADMIN_ROUTE, init)",
		"fetchProductDetail(productId)",
		"fetchOrders(filter)",
		"const answer = await opts.fetch(at, step);",
		"readonly fetch: (cursor: string) => Promise<X>;",
		"fetch: async (at) => {",
		"navigator.clipboard.writeText(text)",
		'import { x } from "./y.js";',
	])("does not flag %j", (code) => {
		expect(forbiddenIn(code)).toBe(false);
	});
});

describe("the console makes exactly the requests ADR-0014 and ADR-0029 allow", () => {
	test("XMLHttpRequest appears only in the upload module", () => {
		const users = sources()
			.filter(({ code }) => /\bXMLHttpRequest\b/.test(code))
			.map(({ file }) => file);
		expect(users).toEqual(["download-upload-api.ts"]);
	});

	test("no module makes any other kind of request", () => {
		const offenders = sources()
			.filter(({ code }) => forbiddenIn(code))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	test("apiFetch — the admin route's transport — is called only from console-api.ts", () => {
		const users = sources()
			.filter(({ code }) => /\bapiFetch\s*\(/.test(code))
			.map(({ file }) => file);
		expect(users).toEqual(["console-api.ts"]);
	});

	test("the upload module opens exactly ONE request: the POST to downloadUploadUrl(productId)", () => {
		const upload = sources().find(({ file }) => file === "download-upload-api.ts")!;
		const opens = upload.code.match(/\.open\s*\([^)]*\)/g) ?? [];
		expect(opens).toHaveLength(1);
		expect(opens[0]!.replace(/\s+/g, "")).toBe('.open("POST",downloadUploadUrl(productId)');
		// …and that URL is the site endpoint's, nothing configurable.
		expect(upload.code).toMatch(
			/export const DOWNLOAD_UPLOAD_PATH_PREFIX = "\/otta-admin\/downloads\/";/,
		);
	});
});
