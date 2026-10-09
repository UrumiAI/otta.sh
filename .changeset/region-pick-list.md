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
- **One region rule, and an optional script (ADR-0034).** A posted region that is not one
  of the posted country's subdivisions is dropped and asked for again (`REGION_LIST_UPDATED`,
  field marked), keeping the buyer's country. With JavaScript, the review's one first-party
  script (`/scripts/region-picker.js`, from `GET /checkout/regions`) swaps the list as the
  country changes and hides the no-JS Update; without it, Update does the same on the server.
  The store's country is preselected only on a fresh visit; a failed place keeps the
  buyer's country. A no-JS buyer on the address-only page who changes country and leaves
  the region blank places without a round trip (nothing there prices by region).
- **Region required iff the store uses regions for the country** — the plugin's zone match,
  unchanged: a physical cart whose country some zone lists at region level (zones carry
  shipping methods and tax rates) is refused `SHIPPING_REGION_CODE_REQUIRED` without one,
  and the review comes back with the list shown and the field marked. Elsewhere the region
  is optional and the site never asks for it.
- **The store's country comes first.** The checkout summary gains `storeCountry` (the tax
  options' base country, else the first zone's), and the review preselects it for a buyer
  who has chosen no country, so its state/province list renders on first load with no
  JS. It is read only on such a fresh visit (`null` when a destination was asked for), so
  a normal review render adds one zone read at most.
- **Required, and said so.** The summary gains `regionRequiredCountries` (countries some
  zone lists at region level); the delivery block's state/province select is `required`
  with `aria-required="true"` for those, and the script keeps it in step. A refusal for an unserved state of a country served by state carries
  `selectionErrors.destination.blames: "region"` ("We don't ship to this state/province").
- **Zoned stores keep the chosen country.** When the plugin refuses a destination (a
  store with a `US-CA` zone refuses plain `US`), the delivery block keeps the country
  and shows its state list, marked invalid, instead of resetting.
- **Zone matching falls back through containing subdivisions.** The list is every ISO 3166-2
  subdivision at all levels (GB: 221), so the zone match now tries the buyer's region, then
  each subdivision containing it, then the country: `ES-TF` → `ES-CN` → `ES`, `GB-BFS` →
  `GB-NIR` → `GB` (ADR-0021 amendment). The generator reads CLDR's vendored containment
  (`common/supplemental/subdivisions.xml`) into `SUBDIVISION_PARENTS`. Most specific still wins.
  A pick that CONTAINS a zoned subdivision (Canary Islands, with only Tenerife zoned) is
  refused `SHIPPING_REGION_CODE_REQUIRED` and asked for the more specific one — never matched
  to the country's zone. **Behaviour change for existing zones:** a buyer inside a zoned
  subdivision (Belfast, with `GB-NIR` and `GB` zones) used to match the country zone and now
  matches the parent's — its rates, tax and methods (none, if that zone only carries tax).
  `@otta-sh/plugin/subdivisions` also exports `subdivisionDataVersion()`, a fingerprint the
  site sends as `/checkout/regions?…&v=` so the cached list follows a data refresh.
  Countries with nested subdivisions (GB, ES, FR, IT, …) show their list grouped by the
  containing subdivision (`<optgroup>`).
- Names include CLDR's provisional ones (CN-HK, CN-MO, CN-NM, CN-TW), drop CLDR's
  footnote markers (`Île-de-France²`), and label same-named subdivisions with their code.
- A theme that still prints a typed region input posts no `regionCountry` and behaves as
  before.
