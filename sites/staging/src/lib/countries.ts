/**
 * The country `<select>` on the checkout review page (issue #305). The value is
 * the ISO 3166-1 alpha-2 code — the plugin matches it against each shipping
 * zone's region list, so a free-text country name (which matches nothing)
 * cannot be submitted from this page. Every assigned code is offered, not just
 * the ones the store ships to: a buyer outside every zone must be TOLD so
 * ("we don't ship there"), not left hunting for their country.
 */
const CODES =
	"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
		" ",
	);

export interface CountryOption {
	code: string;
	name: string;
}

/** English display name for a code; the code itself if `Intl` has none. */
export function countryName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Every country, sorted by display name. */
export function countryOptions(): CountryOption[] {
	const names = new Intl.DisplayNames(["en"], { type: "region" });
	return CODES.map((code) => ({ code, name: names.of(code) ?? code })).toSorted((a, b) =>
		a.name.localeCompare(b.name, "en"),
	);
}

export function isCountryCode(value: string): boolean {
	return CODES.includes(value);
}
