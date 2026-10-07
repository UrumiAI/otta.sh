---
"@otta-sh/plugin": minor
---

New exports for a site that checks a download file's save against its private bucket
(issue #405): `ATTACH_DOWNLOAD_ACTION_ID` (the `products:attach-download` console write),
`DOWNLOAD_NOT_ATTACHED_TITLE` (the title every refusal of that save carries, the plugin's own
included) and `isDownloadAssetKeyFor` (the save's `dl/{productId}/{ULID}` key rule, re-exported
from `@otta-sh/domain`). The reference site's middleware uses them to `head()` the key before
the write reaches the plugin, which cannot reach R2 itself. No behaviour change in the plugin.
