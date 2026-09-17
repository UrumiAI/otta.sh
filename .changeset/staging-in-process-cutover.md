---
"@otta-sh/plugin": minor
---

The barrel exports the two things a DEPLOYING SITE needs to run commerce in-process, so
neither has to be transcribed by hand at the one place transcription is fatal (work order
02, INC-D1 — staging is the first deployment flipped off the HTTP transport).

- **`COMMERCE_STORAGE_COLLECTIONS`** (with `COMMERCE_STORAGE_COLLECTION_NAMES` and the
  `CommerceCollectionDeclaration` / `CommerceStorageLayout` types). The site's plugin
  descriptor declares this map as its `storage` block verbatim. `commerce-storage.ts` was
  written for this moment; until now its only consumers were this package's own test tiers,
  which reach the module directly, so it never needed to be on the barrel. It is exported
  whole and meant to be spread, never copied: a declared index is a READ CONTRACT — the host
  refuses a `where`/`orderBy` on an undeclared field at runtime — so a site that declared a
  subset would not run slower, it would throw on the first commerce request.
- **`CONSOLE_READ_INTERACTION`, `CONSOLE_ACT_INTERACTION`, `CONSOLE_INTERACTIONS`, the
  `ConsoleFailure` type, and `PRODUCTS_CONSOLE_RESOURCE_PREFIX`.** An out-of-browser caller
  can now drive the plugin's admin route without restating its wire strings. The staging
  quickstart seeder is the first such caller: with commerce in-process there is no service
  REST API left to seed through, so it posts the same envelopes the React console posts. A
  literal `"otta_console_act"` in a script is a string that fails by being silently
  unrouted — `admin-route.ts` dispatches on exactly these values, and a stale copy produces
  a refusal rather than an error.

No behaviour changed in the plugin itself: these modules already existed and are unmodified.
