import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	CLDR_VERSION,
	decodeXmlText,
	EXCEPTIONALLY_RESERVED,
	expandCldrRange,
	generateIso3166,
	generateSubdivisionNames,
	regularIds,
	subdivisionNames,
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
			licenseText: read(`${vendored}/LICENSE`),
		});
		expect(read("src/pricing/iso-3166.generated.ts")).toBe(emitted);
	});

	test("iso-3166-names.generated.ts is exactly what the generator emits from the vendored CLDR XML", () => {
		const emitted = generateSubdivisionNames({
			regionXml: read(`${vendored}/validity/region.xml`),
			subdivisionXml: read(`${vendored}/validity/subdivision.xml`),
			namesXml: read(`${vendored}/subdivisions/en.xml`),
			licenseText: read(`${vendored}/LICENSE`),
		});
		expect(read("src/pricing/iso-3166-names.generated.ts")).toBe(emitted);
	});

	test("the names module's header names the version, the source file and the licence", () => {
		const header = read("src/pricing/iso-3166-names.generated.ts")
			.split("\n")
			.slice(0, 20)
			.join("\n");
		expect(header).toContain(`CLDR ${CLDR_VERSION}`);
		expect(header).toContain("common/subdivisions/en.xml");
		expect(header).toContain("GENERATED");
		expect(header).toContain("do not edit");
		expect(header).toContain("Unicode-3.0");
	});

	test("its header names the pinned CLDR version, the do-not-edit marker and the Unicode licence", () => {
		const header = read("src/pricing/iso-3166.generated.ts").split("\n").slice(0, 20).join("\n");
		expect(CLDR_VERSION).toBe("48.2");
		expect(header).toContain(`CLDR ${CLDR_VERSION}`);
		expect(header).toContain("GENERATED");
		expect(header).toContain("do not edit");
		expect(header).toContain("Unicode-3.0");
	});

	test("the Unicode copyright line is the licence's OWN, identical in the header and both notices", () => {
		const line = /^Copyright © .* Unicode, Inc\.$/m.exec(read(`${vendored}/LICENSE`))?.[0] ?? "";
		expect(line).toBe("Copyright © 2004-2026 Unicode, Inc.");
		expect(read("src/pricing/iso-3166.generated.ts").split("\n").slice(0, 20).join("\n")).toContain(
			line,
		);
		expect(read("THIRD_PARTY_NOTICES")).toContain(line);
		expect(readFileSync(new URL("../plugin/THIRD_PARTY_NOTICES", root), "utf8")).toContain(line);
		expect(
			read("src/pricing/iso-3166-names.generated.ts").split("\n").slice(0, 20).join("\n"),
		).toContain(line);
		for (const file of [
			"src/pricing/iso-3166.generated.ts",
			"src/pricing/iso-3166-names.generated.ts",
			"THIRD_PARTY_NOTICES",
		]) {
			expect(read(file)).not.toMatch(/Copyright © 1991-2024/);
		}
	});

	test("the exclusions are an explicit, documented list in the generator", () => {
		expect(EXCEPTIONALLY_RESERVED).toEqual(["AC", "CP", "CQ", "DG", "EA", "IC", "TA"]);
		expect(read("src/pricing/iso-3166.generated.ts")).toContain("exceptionally reserved");
	});

	test("the Unicode licence text ships beside the vendored data and in the published package", () => {
		expect(read(`${vendored}/LICENSE`)).toContain("UNICODE LICENSE V3");
		const notices = read("THIRD_PARTY_NOTICES");
		expect(notices).toContain("UNICODE LICENSE V3");
		expect(notices).toContain(`CLDR ${CLDR_VERSION}`);
		expect(notices).toContain("common/subdivisions/en.xml");
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

describe("the generator's subdivision names", () => {
	test("decodes the predefined entities and numeric references, and refuses anything else", () => {
		expect(decodeXmlText("Trinity &amp; Tobago &#x41;&#66; &lt;&gt;&quot;&apos;")).toBe(
			"Trinity & Tobago AB <>\"'",
		);
		expect(() => decodeXmlText("a &nbsp; b")).toThrow();
		expect(() => decodeXmlText("a & b")).toThrow();
	});

	test("reads each subdivision element and ignores commented-out ones", () => {
		const xml = `<ldml><subdivisions>
			<!-- <subdivision type="usxx">Gone</subdivision> -->
			<subdivision type="usca">California</subdivision> <!-- note -->
			<subdivision type="ttpos">Port of Spain &amp; Co</subdivision>
		</subdivisions></ldml>`;
		expect([...subdivisionNames(xml)]).toEqual([
			["usca", "California"],
			["ttpos", "Port of Spain & Co"],
		]);
	});

	test("accepts provisional names, strips footnote markers, and refuses any other attribute", () => {
		const names = subdivisionNames(
			`<subdivision type="cnhk" draft="provisional">Hong Kong</subdivision><subdivision type="fridf">Île-de-France²</subdivision>`,
		);
		expect(names.get("cnhk")).toBe("Hong Kong");
		expect(names.get("fridf")).toBe("Île-de-France");
		expect(() =>
			subdivisionNames(`<subdivision type="usca" alt="short">Calif.</subdivision>`),
		).toThrow(/unsupported attributes/);
	});

	test("refuses a name the packed module could not carry, or a subdivision named twice", () => {
		expect(() => subdivisionNames(`<subdivision type="usca">A|B</subdivision>`)).toThrow();
		expect(() => subdivisionNames(`<subdivision type="usca"> A</subdivision>`)).toThrow();
		expect(() =>
			subdivisionNames(
				`<subdivision type="usca">A</subdivision><subdivision type="usca">B</subdivision>`,
			),
		).toThrow();
	});
});
