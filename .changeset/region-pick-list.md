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
  differs, the old region is dropped. A region picked from another
  country's list is never dropped silently: the field is marked "pick again" beside any
  other error, with `REGION_LIST_UPDATED` when nothing else is wrong; for a country without
  subdivisions it is just dropped.
- **Region required iff the store uses regions for the country** — the plugin's zone match,
  unchanged: a physical cart whose country some zone lists at region level (zones carry
  shipping methods and tax rates) is refused `SHIPPING_REGION_CODE_REQUIRED` without one,
  and the review comes back with the list shown and the field marked. Elsewhere the region
  is optional and the site never asks for it.
- **The store's country comes first.** The checkout summary gains `storeCountry` (the tax
  options' base country, else the first zone's), and the review preselects it for a buyer
  who has chosen no country, so its state/province list renders on first load with no
  JS. A refusal for an unserved state of a country served by state carries
  `selectionErrors.destination.blames: "region"` ("We don't ship to this state/province").
- **Zoned stores keep the chosen country.** When the plugin refuses a destination (a
  store with a `US-CA` zone refuses plain `US`), the delivery block keeps the country
  and shows its state list, marked invalid, instead of resetting.
- The list is every ISO 3166-2 subdivision at all levels (GB: 221), so merchants must set
  region zones at the level buyers pick from (ADR-0021 amendment).
- Names include CLDR's provisional ones (CN-HK, CN-MO, CN-NM, CN-TW), drop CLDR's
  footnote markers (`Île-de-France²`), and label same-named subdivisions with their code.
- A theme that still prints a typed region input posts no `regionCountry` and behaves as
  before.
