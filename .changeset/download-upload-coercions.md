---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

The upload side of a download file (issue #376, increment 4). `validateDownloadAsset`
still accepts or refuses and never rewrites; these are the coercions that produce what it
accepts, kept in the same module so the two cannot drift.

- `mintDownloadAssetKey(productId, nowMs, random)` mints `dl/{productId}/{ULID}` from a
  clock and 10 random bytes the caller draws (`DOWNLOAD_KEY_RANDOM_BYTES`). It stays pure,
  and throws `RangeError` rather than mint a key the validator would refuse.
- `downloadContentTypeFor(declared)` keeps a safe declared type (essence only,
  lower-cased) and turns anything else — `text/html`, SVG, any script type, a malformed or
  missing value — into `application/octet-stream` (`DOWNLOAD_FALLBACK_CONTENT_TYPE`).
- `sanitizeDownloadFilename(raw)` keeps the last path segment, removes every character
  the validator forbids, trims, and shortens to 255 characters keeping a short extension.
  If nothing is left, the name is `download` (`DOWNLOAD_FALLBACK_FILENAME`).

The plugin re-exports the three functions and the two constants, so a site's upload
endpoint uses the same rules as the admin save.

`validateDownloadAsset` now also refuses invisible characters in a filename — the
zero-width space (U+200B), word joiner and invisible operators (U+2060–U+2064), the BOM
(U+FEFF), the soft hyphen (U+00AD) and tag characters (U+E0000–U+E007F) — and
`sanitizeDownloadFilename` removes them. The zero-width non-joiner and joiner (U+200C,
U+200D) stay allowed: Persian, Urdu and Indic spelling and emoji sequences need them.
