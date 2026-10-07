---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

`REGION_CODE_PATTERN` — the region SHAPE rule (`isCodeShapedRegion`) as an unanchored
pattern source, exported by the domain and re-exported by the plugin beside
`isCodeShapedRegion`, so a storefront's region field uses the rule itself rather than a
copy of it (QA2 N6). `isCodeShapedRegion` is now built from it; behaviour is unchanged.
