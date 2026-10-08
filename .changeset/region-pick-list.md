---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

The checkout's state/province is a pick list of the chosen country's ISO 3166-2
subdivisions, shown by name, instead of a free-text code field. It works with no
JavaScript: the list is rendered on the server for the country the page knows, and
changing the country takes a round trip (the delivery block's "Update delivery", or a new
Update button beside the address block's own country) that comes back with that
country's list and everything typed kept. A country without subdivisions shows no region
field.

- **Same stored codes.** The option values are the bare codes the address always stored
  (`CA`), so stored addresses and orders need no migration, and the plugin's routes
  validate every region exactly as before (`MX-CA` or `ON` for a US address is still
  refused). An old stored or typed form (`us-ca`, `US-CA`) renders as the selected option.
- **New: English subdivision names.** The CLDR 48.2 generator now also reads the vendored
  `common/subdivisions/en.xml` and writes `iso-3166-names.generated.ts` (pinned byte for
  byte like the codes module; the codes module itself is unchanged). They are reached
  only through new subpaths — `@otta-sh/domain/subdivision-names` and
  `@otta-sh/plugin/subdivisions` (`subdivisionOptions(country)`,
  `subdivisionName(country, code)`, decoded one country at a time on demand) — so neither
  package's main entry nor the plugin's sandbox entry carries them. `@otta-sh/plugin` also
  re-exports `normalizeSubdivision`.
- **A region is never sent for the wrong country.** Each list echoes the country it was
  rendered for (`deliveryRegionCountry`, `regionCountry`); when the posted country
  differs, the old region is dropped. A place whose country changed since its list was
  rendered (including a first choice of country) comes back once with the new list shown
  and marked (`REGION_LIST_UPDATED`) when that country has subdivisions or a region was
  posted for another country, so no order is placed before the buyer has seen the list.
- **Zoned stores keep the chosen country.** When the plugin refuses a destination (a
  store with a `US-CA` zone refuses plain `US`), the delivery block keeps the country
  and shows its state list, marked invalid, instead of resetting.
- Names include CLDR's provisional ones (CN-HK, CN-MO, CN-NM, CN-TW), drop CLDR's
  footnote markers (`Île-de-France²`), and label same-named subdivisions with their code.
  A theme that still prints a
  typed region input posts no such field and behaves as before.
