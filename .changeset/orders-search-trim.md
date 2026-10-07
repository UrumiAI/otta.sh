---
"@otta-sh/plugin": patch
"@otta-sh/admin-react": patch
---

The Orders search is trimmed before it is sent. `  qa@example.com  ` used to be queried
with its spaces — matching nothing, since the store matches a prefix — while the
active-filter summary, rendered as HTML, showed the trimmed term. The console now trims
once where it normalises the filter (a whitespace-only search is no search), and the
plugin's orders route trims too.
