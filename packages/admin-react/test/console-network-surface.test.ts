/**
 * The console's network surface, pinned (ADR-0014 Decision 3, amended by
 * ADR-0029).
 *
 * Every read and write of commerce data goes through `console-api.ts`, which
 * calls EmDash's `apiFetch` against the `otta` admin route. The ONE other request
 * the console may make is the Download file card's upload of a file to the site,
 * in `download-upload-api.ts`. This suite reads the package's source so that a
 * second request — a bare `fetch`, another `XMLHttpRequest`, a beacon, a socket —
 * fails here instead of quietly widening what ADR-0029 allowed.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function sources(): Array<{ file: string; code: string }> {
	const out: Array<{ file: string; code: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(entry.name)) {
				// Code only: comments may name what they forbid.
				const code = readFileSync(full, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/^\s*\/\/.*$/gm, "");
				out.push({ file: path.relative(SRC, full), code });
			}
		}
	};
	walk(SRC);
	return out;
}

describe("the console makes exactly the requests ADR-0014 and ADR-0029 allow", () => {
	test("XMLHttpRequest appears only in the upload module", () => {
		const users = sources()
			.filter(({ code }) => /\bXMLHttpRequest\b/.test(code))
			.map(({ file }) => file);
		expect(users).toEqual(["download-upload-api.ts"]);
	});

	test("no module calls fetch, sendBeacon, EventSource or WebSocket directly", () => {
		const offenders = sources()
			.filter(({ code }) =>
				/(?<![.\w])fetch\s*\(|globalThis\.fetch|window\.fetch|sendBeacon|\bEventSource\b|\bWebSocket\b/.test(
					code,
				),
			)
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	test("apiFetch — the admin route's transport — is called only from console-api.ts", () => {
		const users = sources()
			.filter(({ code }) => /\bapiFetch\s*\(/.test(code))
			.map(({ file }) => file);
		expect(users).toEqual(["console-api.ts"]);
	});
});
