---
"@otta-sh/plugin": minor
---

The package entry point now exports `ENTITLEMENT_DOWNLOAD_ROUTE` and the
`EntitlementDownloadInput`, `EntitlementDownloadResult` and `DownloadAssetWire` types
(issue #376, increment 3). A site's download endpoint can name the route and read its
answer without copying the route string. Nothing about the route itself changes.
