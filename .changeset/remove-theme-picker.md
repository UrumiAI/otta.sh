---
"@otta-sh/admin-react": minor
"@otta-sh/plugin": minor
---

The admin offers no storefront theme choice: the store ships one theme, Tempered (ADR-0024 and ADR-0014, amendments 2026-10-02).

**`@otta-sh/admin-react`** drops the **Themes** page from the Plugins section (`THEMES_PAGE`, the theme cards and the live-preview overlay) and its `fetchThemes` / `activateTheme` client calls.

**`@otta-sh/plugin`** drops the Settings **"Store theme"** radio and its `save-theme` action, the `themes.list` read and `themes:activate` write on the `otta` admin route, the `__OTTA_STORE_THEMES__` define reader, and the `THEME_PREVIEW_PARAM` / `THEME_PREVIEW_OFF` / `THEME_PREVIEW_SILENT` exports. The Settings Store group now holds the display name alone.

The site's theme system stays (contract, manifest, registry, resolver, the chrome bag read): the resolver still reads the stored `settings:storeTheme` and falls back to Tempered, as the hook for a theme installed from the separate themes repo. The admin-only `?preview_theme` live preview and its "Previewing …" pill are removed from the site.
