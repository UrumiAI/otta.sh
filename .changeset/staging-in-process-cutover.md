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
- **`CONSOLE_READ_INTERACTION`, `CONSOLE_ACT_INTERACTION` and
  `PRODUCTS_CONSOLE_RESOURCE_PREFIX`** — exactly the three an out-of-browser caller needs to
  drive the plugin's admin route without restating its wire strings, and no more.
  (`CONSOLE_INTERACTIONS` and the `ConsoleFailure` type stay internal: nothing outside this
  package consumes them, and an unused barrel entry is public API bought with nothing.) The
  staging quickstart seeder is the first such caller: with commerce in-process there is no
  service REST API left to seed through, so it posts the same envelopes the React console
  posts. A literal `"otta_console_act"` or `"products.detail"` in a script is a string that
  fails by being silently unrouted — `admin-route.ts` and `products-console-route.ts`
  dispatch on exactly these values, and a stale copy produces a refusal rather than an error.

No behaviour changed in the plugin itself: these modules already existed and are unmodified.
