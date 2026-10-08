/**
 * `@otta-sh/plugin/subdivisions` — a country's ISO 3166-2 subdivisions with
 * their English names (CLDR), for a storefront's state/province PICK LIST.
 * Display only: the value an address stores is still the bare code, and the
 * plugin's routes validate it as before.
 *
 * A subpath of its own, not the main entry, so the names (~70 KB) are bundled
 * only where they are imported — never into the code the sandbox entry loads.
 */
export {
	subdivisionName,
	subdivisionOptions,
	type SubdivisionOption,
} from "@otta-sh/domain/subdivision-names";
