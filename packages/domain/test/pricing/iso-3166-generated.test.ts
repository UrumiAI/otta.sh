import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	CLDR_VERSION,
	expandCldrRange,
	generateIso3166,
	regularIds,
} from "../../scripts/generate-iso-3166.js";

/**
 * ADR-0021 Decision 2: the country and subdivision lists are GENERATED from a
 * pinned CLDR release whose validity XML is vendored under `scripts/` (D14 —
 * dev-only, never published). This test re-runs the generator over the
 * vendored files and demands the committed module byte for byte, so the data
 * can only change by re-running the generator (a CLDR refresh is a generator
 * run plus a version bump, reviewed as such) — never by a hand edit.
 *
 * `node:fs` is fine here: the domain purity rule covers `packages/domain/src`
 * only (.dependency-cruiser.cjs).
 */
const root = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

const vendored = `scripts/cldr-${CLDR_VERSION}`;

describe("iso-3166.generated.ts", () => {
	test("is exactly what the generator emits from the vendored CLDR XML", () => {
		const emitted = generateIso3166({
			regionXml: read(`${vendored}/validity/region.xml`),
			subdivisionXml: read(`${vendored}/validity/subdivision.xml`),
		});
		expect(read("src/pricing/iso-3166.generated.ts")).toBe(emitted);
	});

	test("its header names the pinned CLDR version, the do-not-edit marker and the Unicode licence", () => {
		const header = read("src/pricing/iso-3166.generated.ts").split("\n").slice(0, 20).join("\n");
		expect(CLDR_VERSION).toBe("48.2");
		expect(header).toContain(`CLDR ${CLDR_VERSION}`);
		expect(header).toContain("GENERATED");
		expect(header).toContain("do not edit");
		expect(header).toContain("Unicode-3.0");
		expect(header).toContain("Copyright © 1991-2024 Unicode, Inc.");
	});

	test("the Unicode licence text ships beside the vendored data and in the published package", () => {
		expect(read(`${vendored}/LICENSE`)).toContain("UNICODE LICENSE V3");
		const notices = read("THIRD_PARTY_NOTICES");
		expect(notices).toContain("UNICODE LICENSE V3");
		expect(notices).toContain(`CLDR ${CLDR_VERSION}`);
		const pkg = JSON.parse(read("package.json")) as { files: string[] };
		expect(pkg.files).toContain("THIRD_PARTY_NOTICES");
		// The vendored XML and the generator are dev-only (D14).
		expect(pkg.files.some((f) => f.startsWith("scripts"))).toBe(false);
	});
});

describe("the generator's CLDR parsing", () => {
	test("expands a one-character range on the final character", () => {
		expect(expandCldrRange("AC~G")).toEqual(["AC", "AD", "AE", "AF", "AG"]);
		expect(expandCldrRange("bd10~3")).toEqual(["bd10", "bd11", "bd12", "bd13"]);
		expect(expandCldrRange("usca")).toEqual(["usca"]);
	});

	test("refuses a range form it does not understand, rather than guessing", () => {
		expect(() => expandCldrRange("ab~cd")).toThrow();
		expect(() => expandCldrRange("ag~3")).toThrow();
	});

	test("reads ONLY the idStatus='regular' block of the requested type", () => {
		const xml = `<supplementalData><idValidity>
			<id type='region' idStatus='regular'>		<!-- 3 items -->
				AD AE~F
			</id>
			<id type='region' idStatus='macroregion'>
				EU UN
			</id>
		</idValidity></supplementalData>`;
		expect(regularIds(xml, "region")).toEqual(["AD", "AE", "AF"]);
	});
});
