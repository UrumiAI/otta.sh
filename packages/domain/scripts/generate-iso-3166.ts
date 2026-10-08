/**
 * Generates `src/pricing/iso-3166.generated.ts` from the vendored CLDR
 * validity XML (ADR-0021 Decision 2, D14), and `iso-3166-names.generated.ts`
 * — the English subdivision names the storefront's state/province pick list
 * shows — from the same release's `common/subdivisions/en.xml`.
 *
 *     node packages/domain/scripts/generate-iso-3166.ts
 *
 * To refresh the data for a new CLDR release: vendor that release's
 * `common/validity/{region,subdivision}.xml`, `common/subdivisions/en.xml` and `LICENSE` under
 * `scripts/cldr-<version>/`, bump {@link CLDR_VERSION}, re-run this script,
 * update `THIRD_PARTY_NOTICES`, and review the diff of the generated module.
 * `test/pricing/iso-3166-generated.test.ts` fails until the committed modules
 * are exactly this script's output.
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

/** The countries and, per country, the sorted unique subdivision suffixes —
 *  the one reading of the validity XML both generated modules share. */
function collectCodes(
	regionXml: string,
	subdivisionXml: string,
): { countries: string[]; byCountry: Map<string, string[]> } {
	// Alpha-2 only (a numeric area code is never a country a parcel can go to),
	// and never an exceptionally reserved code (see EXCEPTIONALLY_RESERVED).
	const excluded = new Set(EXCEPTIONALLY_RESERVED);
	const countries = regularIds(regionXml, "region")
		.filter((code) => /^[A-Z]{2}$/.test(code) && !excluded.has(code))
		.toSorted();
	const countrySet = new Set(countries);

	const byCountry = new Map<string, string[]>();
	for (const id of regularIds(subdivisionXml, "subdivision")) {
		const country = id.slice(0, 2).toUpperCase();
		const suffix = id.slice(2).toUpperCase();
		if (excluded.has(country)) continue;
		if (!countrySet.has(country)) throw new Error(`subdivision ${id} of unknown country`);
		if (!/^[A-Z0-9]{1,3}$/.test(suffix)) throw new Error(`subdivision ${id} is not code-shaped`);
		const list = byCountry.get(country) ?? [];
		list.push(suffix);
		byCountry.set(country, list);
	}
	for (const [country, list] of byCountry) byCountry.set(country, [...new Set(list)].toSorted());
	return { countries, byCountry };
}

/** The header both generated modules open with, after their one-line summary. */
function header(summary: string, licenseText: string): string[] {
	return [
		"/**",
		` * ${summary}`,
		" *",
		" * GENERATED by packages/domain/scripts/generate-iso-3166.ts — do not edit by hand.",
		" * A test re-runs the generator and requires this file byte for byte (ADR-0021).",
		" * Excluded from oxfmt (.prettierignore): the generator owns its layout.",
		" *",
		" * Derived from CLDR data files:",
		` *   ${licenceCopyright(licenseText)}`,
		" *   For terms of use, see https://www.unicode.org/copyright.html",
		" *   SPDX-License-Identifier: Unicode-3.0",
		" * Distributed under the Unicode License v3; see THIRD_PARTY_NOTICES.",
		" */",
		"",
	];
}

export function generateIso3166(input: {
	regionXml: string;
	subdivisionXml: string;
	licenseText: string;
}): string {
	const { countries, byCountry } = collectCodes(input.regionXml, input.subdivisionXml);

	const lines: string[] = header(
		`ISO 3166 codes from Unicode CLDR ${CLDR_VERSION} (common/validity, idStatus="regular").`,
		input.licenseText,
	);
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
		lines.push(`\t${country}: ${JSON.stringify((byCountry.get(country) ?? []).join(" "))},`);
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

const XML_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/** XML character data → its text: the five predefined entities and numeric
 *  character references. Anything else throws rather than being guessed at. */
export function decodeXmlText(text: string): string {
	return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);|&/g, (whole, ref?: string) => {
		if (ref === undefined) throw new Error(`bare & in XML text: ${text}`);
		if (ref.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
		if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
		const named = XML_ENTITIES[ref];
		if (named === undefined) throw new Error(`unknown XML entity ${whole}`);
		return named;
	});
}

/** CLDR's disambiguation markers (`Tartu²`, `Île-de-France²`): superscript
 *  digits at the end of a name, meant for translators, never for shoppers. */
const FOOTNOTE_MARKER = /[\u00b9\u00b2\u00b3\u2070\u2074-\u2079]+$/u;

/** The attributes a subdivision name may carry. A confirmed name has none; a
 *  `draft="provisional"` (or `contributed`) one is CLDR's best English name and is
 *  used. Anything else — an `alt=` variant, an unknown attribute — throws, so a
 *  future CLDR release can never drop or double a name silently. */
const ACCEPTED_ATTRIBUTES = /^(?:\s+draft="(?:provisional|contributed)")?$/;

/** Every `<subdivision type="usca">California</subdivision>` of a CLDR
 *  `common/subdivisions/<locale>.xml`, comments ignored: `usca` → `California`.
 *  A name is one line of trimmed text without the `|` the module joins on, and
 *  without a trailing footnote marker. */
export function subdivisionNames(xml: string): Map<string, string> {
	const body = xml.replace(/<!--[\s\S]*?-->/g, " ");
	const names = new Map<string, string>();
	for (const match of body.matchAll(
		/<subdivision type="([a-z0-9]+)"([^>]*)>([^<]*)<\/subdivision>/g,
	)) {
		const [, id = "", attributes = "", raw = ""] = match;
		if (!ACCEPTED_ATTRIBUTES.test(attributes)) {
			throw new Error(`subdivision ${id} has unsupported attributes:${attributes}`);
		}
		const name = decodeXmlText(raw).replace(FOOTNOTE_MARKER, "");
		if (name.length === 0 || name !== name.trim() || /[|\n\r\t]/.test(name)) {
			throw new Error(`subdivision ${id} has an unusable name: ${JSON.stringify(name)}`);
		}
		if (names.has(id)) throw new Error(`subdivision ${id} is named twice`);
		names.set(id, name);
	}
	return names;
}

/**
 * The English subdivision NAMES module (`iso-3166-names.generated.ts`), for the
 * storefront's state/province pick list. Kept apart from the codes module so
 * nothing that only VALIDATES codes — the plugin's sandbox bundle above all —
 * carries the names. Exactly the subdivisions `SUBDIVISIONS` lists; one that
 * CLDR does not name in English is left out (its code is its label).
 */
export function generateSubdivisionNames(input: {
	regionXml: string;
	subdivisionXml: string;
	namesXml: string;
	licenseText: string;
}): string {
	const { byCountry } = collectCodes(input.regionXml, input.subdivisionXml);
	const names = subdivisionNames(input.namesXml);
	const lines: string[] = header(
		`English ISO 3166-2 subdivision names from Unicode CLDR ${CLDR_VERSION} (common/subdivisions/en.xml).`,
		input.licenseText,
	);
	lines.push(
		'/** Per country, `CODE Name` for each subdivision CLDR names in English, sorted by code and joined by "|" (US → "AK Alaska|AL Alabama|…"). Decoded on demand, one country at a time (subdivision-names.ts). */',
	);
	lines.push("export const SUBDIVISION_NAMES: Readonly<Record<string, string>> = {");
	for (const country of [...byCountry.keys()].toSorted()) {
		const named = (byCountry.get(country) ?? []).flatMap((suffix) => {
			const name = names.get(`${country}${suffix}`.toLowerCase());
			return name === undefined ? [] : [{ suffix, name }];
		});
		// Two of a country's subdivisions sharing a name (CLDR told them apart only
		// by the footnote marker stripped above) are labelled with their codes, so
		// no pick list offers the same words twice.
		const count = new Map<string, number>();
		for (const { name } of named) count.set(name, (count.get(name) ?? 0) + 1);
		const pairs = named.map(({ suffix, name }) =>
			(count.get(name) ?? 0) > 1 ? `${suffix} ${name} (${suffix})` : `${suffix} ${name}`,
		);
		if (pairs.length > 0) lines.push(`\t${country}: ${JSON.stringify(pairs.join("|"))},`);
	}
	lines.push("};");
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
	const names = generateSubdivisionNames({
		regionXml: read(`scripts/cldr-${CLDR_VERSION}/validity/region.xml`),
		subdivisionXml: read(`scripts/cldr-${CLDR_VERSION}/validity/subdivision.xml`),
		namesXml: read(`scripts/cldr-${CLDR_VERSION}/subdivisions/en.xml`),
		licenseText: read(`scripts/cldr-${CLDR_VERSION}/LICENSE`),
	});
	writeFileSync(new URL("src/pricing/iso-3166-names.generated.ts", root), names);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
