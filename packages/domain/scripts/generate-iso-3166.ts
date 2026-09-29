/**
 * Generates `src/pricing/iso-3166.generated.ts` from the vendored CLDR
 * validity XML (ADR-0021 Decision 2, D14).
 *
 *     node packages/domain/scripts/generate-iso-3166.ts
 *
 * To refresh the data for a new CLDR release: vendor that release's
 * `common/validity/{region,subdivision}.xml` and `LICENSE` under
 * `scripts/cldr-<version>/`, bump {@link CLDR_VERSION}, re-run this script,
 * update `THIRD_PARTY_NOTICES`, and review the diff of the generated module.
 * `test/pricing/iso-3166-generated.test.ts` fails until the committed module
 * is exactly this script's output.
 *
 * Dev-only: neither this script nor the XML is published (`files: ["dist",
 * "THIRD_PARTY_NOTICES"]`). Only erasable TypeScript syntax is used, so Node
 * runs it directly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The pinned CLDR release. */
export const CLDR_VERSION = "48.2";

/**
 * CLDR's `regular` regions are WIDER than ISO 3166-1's officially assigned
 * alpha-2 codes: they also list codes ISO 3166/MA only EXCEPTIONALLY RESERVES
 * (Ascension, Clipperton, Sark, Diego Garcia, Ceuta & Melilla, the Canary
 * Islands, Tristan da Cunha). A payment provider need not accept those as a
 * shipping country, so an order to one could be minted and then fail at
 * payment. They are excluded here, explicitly (ADR-0021 Decision 2). XK
 * (Kosovo, user-assigned) is KEPT (D11). Officially assigned uninhabited
 * territories (AQ, BV, HM, UM) are kept: they are ISO 3166-1 countries.
 */
export const EXCEPTIONALLY_RESERVED: readonly string[] = ["AC", "CP", "CQ", "DG", "EA", "IC", "TA"];

/**
 * CLDR's compact range form: `AC~G` is AC, AD, AE, AF, AG — the final
 * character runs from the start's last character to the one after the `~`.
 * Only single-character ranges over one character class occur in the validity
 * files; anything else throws rather than being guessed at.
 */
export function expandCldrRange(token: string): string[] {
	const tilde = token.indexOf("~");
	if (tilde === -1) return [token];
	const start = token.slice(0, tilde);
	const end = token.slice(tilde + 1);
	if (end.length !== 1 || start.length < 2) throw new Error(`unsupported CLDR range: ${token}`);
	const from = start.charCodeAt(start.length - 1);
	const to = end.charCodeAt(0);
	const sameClass = (a: number, b: number): boolean =>
		(isDigit(a) && isDigit(b)) || (isLetter(a) && isLetter(b));
	if (to < from || !sameClass(from, to)) throw new Error(`unsupported CLDR range: ${token}`);
	const prefix = start.slice(0, -1);
	const out: string[] = [];
	for (let c = from; c <= to; c += 1) out.push(prefix + String.fromCharCode(c));
	return out;
}

function isDigit(c: number): boolean {
	return c >= 48 && c <= 57;
}

function isLetter(c: number): boolean {
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Every id in the `idStatus='regular'` block of `type`, ranges expanded. */
export function regularIds(xml: string, type: "region" | "subdivision"): string[] {
	const open = new RegExp(`<id type='${type}' idStatus='regular'>([\\s\\S]*?)</id>`);
	const match = open.exec(xml);
	if (match === null) throw new Error(`no regular ${type} block`);
	const body = (match[1] ?? "").replace(/<!--[\s\S]*?-->/g, " ");
	return body
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.flatMap(expandCldrRange);
}

/** The licence's OWN copyright line, so the generated header and
 *  THIRD_PARTY_NOTICES (which carries the licence verbatim) say the same. */
function licenceCopyright(licenseText: string): string {
	const line = /^Copyright © .* Unicode, Inc\.$/m.exec(licenseText)?.[0];
	if (line === undefined) throw new Error("no Unicode copyright line in the licence");
	return line;
}

export function generateIso3166(input: {
	regionXml: string;
	subdivisionXml: string;
	licenseText: string;
}): string {
	const attribution = [
		licenceCopyright(input.licenseText),
		"For terms of use, see https://www.unicode.org/copyright.html",
		"SPDX-License-Identifier: Unicode-3.0",
	];
	// Alpha-2 only (a numeric area code is never a country a parcel can go to),
	// and never an exceptionally reserved code (see EXCEPTIONALLY_RESERVED).
	const excluded = new Set(EXCEPTIONALLY_RESERVED);
	const countries = regularIds(input.regionXml, "region")
		.filter((code) => /^[A-Z]{2}$/.test(code) && !excluded.has(code))
		.toSorted();
	const countrySet = new Set(countries);

	const byCountry = new Map<string, string[]>();
	for (const id of regularIds(input.subdivisionXml, "subdivision")) {
		const country = id.slice(0, 2).toUpperCase();
		const suffix = id.slice(2).toUpperCase();
		if (excluded.has(country)) continue;
		if (!countrySet.has(country)) throw new Error(`subdivision ${id} of unknown country`);
		if (!/^[A-Z0-9]{1,3}$/.test(suffix)) throw new Error(`subdivision ${id} is not code-shaped`);
		const list = byCountry.get(country) ?? [];
		list.push(suffix);
		byCountry.set(country, list);
	}

	const lines: string[] = [];
	lines.push("/**");
	lines.push(
		` * ISO 3166 codes from Unicode CLDR ${CLDR_VERSION} (common/validity, idStatus="regular").`,
	);
	lines.push(" *");
	lines.push(" * GENERATED by packages/domain/scripts/generate-iso-3166.ts — do not edit by hand.");
	lines.push(" * A test re-runs the generator and requires this file byte for byte (ADR-0021).");
	lines.push(" * Excluded from oxfmt (.prettierignore): the generator owns its layout.");
	lines.push(" *");
	lines.push(" * Derived from CLDR data files:");
	for (const line of attribution) lines.push(` *   ${line}`);
	lines.push(" * Distributed under the Unicode License v3; see THIRD_PARTY_NOTICES.");
	lines.push(" */");
	lines.push("");
	lines.push(
		`/** ISO 3166-1 alpha-2 country codes: CLDR regular regions restricted to the officially assigned codes (the exceptionally reserved ${EXCEPTIONALLY_RESERVED.join(", ")} are excluded), plus XK. */`,
	);
	lines.push("export const COUNTRY_CODES: ReadonlySet<string> = new Set(");
	lines.push(`\t${JSON.stringify(countries.join(" "))}.split(" "),`);
	lines.push(");");
	lines.push("");
	lines.push("/** Per country, the bare ISO 3166-2 subdivision suffixes, space-separated. */");
	lines.push("const SUBDIVISION_SUFFIXES: Readonly<Record<string, string>> = {");
	for (const country of [...byCountry.keys()].toSorted()) {
		const suffixes = [...new Set(byCountry.get(country))].toSorted();
		lines.push(`\t${country}: ${JSON.stringify(suffixes.join(" "))},`);
	}
	lines.push("};");
	lines.push("");
	lines.push('/** Country code → its ISO 3166-2 subdivision suffixes (US → {"CA", "TX", …}). */');
	lines.push("export const SUBDIVISIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(");
	lines.push("\tObject.entries(SUBDIVISION_SUFFIXES).map(([country, suffixes]) => [");
	lines.push("\t\tcountry,");
	lines.push('\t\tnew Set(suffixes.split(" ")),');
	lines.push("\t]),");
	lines.push(");");
	lines.push("");
	return lines.join("\n");
}

function main(): void {
	const root = new URL("../", import.meta.url);
	const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
	const out = generateIso3166({
		regionXml: read(`scripts/cldr-${CLDR_VERSION}/validity/region.xml`),
		subdivisionXml: read(`scripts/cldr-${CLDR_VERSION}/validity/subdivision.xml`),
		licenseText: read(`scripts/cldr-${CLDR_VERSION}/LICENSE`),
	});
	writeFileSync(new URL("src/pricing/iso-3166.generated.ts", root), out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
