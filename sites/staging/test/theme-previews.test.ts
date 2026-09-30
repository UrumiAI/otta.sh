/**
 * Every theme the manifest offers has its Themes-card screenshot, at the size
 * `scripts/capture-theme-previews.ts` writes (1200×900 WebP), under the budget.
 *
 * A missing file is a broken image on the admin's first screen of choices; a
 * wrong size is a stretched or letterboxed one. The dimensions are read from
 * the WebP header itself (VP8 / VP8L / VP8X), so the check needs no image
 * library.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { STORE_THEMES } from "../src/themes/manifest.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const BUDGET_BYTES = 150 * 1024;

/** Width and height from a WebP file's header. */
function webpSize(bytes: Buffer): { width: number; height: number } {
	if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
		throw new Error("not a WebP file");
	}
	const chunk = bytes.toString("ascii", 12, 16);
	if (chunk === "VP8X") {
		return {
			width: 1 + bytes.readUIntLE(24, 3),
			height: 1 + bytes.readUIntLE(27, 3),
		};
	}
	if (chunk === "VP8L") {
		const bits = bytes.readUInt32LE(21);
		return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
	}
	if (chunk === "VP8 ") {
		return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
	}
	throw new Error(`unknown WebP chunk ${chunk}`);
}

describe("the Themes screen's preview images", () => {
	test.each(STORE_THEMES.map((theme) => [theme.id, theme.preview] as const))(
		"%s has %s, 1200×900 and under 150 KiB",
		(id, preview) => {
			expect(preview).toBe(`/theme-previews/${id}.webp`);
			const bytes = readFileSync(path.join(PUBLIC, preview));
			expect(webpSize(bytes)).toEqual({ width: 1200, height: 900 });
			expect(bytes.byteLength).toBeLessThanOrEqual(BUDGET_BYTES);
		},
	);

	test("no orphan: every file in public/theme-previews belongs to a shipped theme", () => {
		const files = readdirSync(path.join(PUBLIC, "theme-previews")).toSorted();
		expect(files).toEqual(STORE_THEMES.map((theme) => `${theme.id}.webp`).toSorted());
	});

	test("every description fits the plugin's one-line limit", () => {
		for (const theme of STORE_THEMES) {
			expect(theme.description.length).toBeGreaterThan(0);
			expect(theme.description.length).toBeLessThanOrEqual(160);
		}
	});
});
