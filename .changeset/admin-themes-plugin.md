---
"@otta-sh/plugin": minor
---

The admin route serves the React **Themes** screen: a `themes.list` read (the site's themes with
their description, preview image and admin-only preview URL, plus the active id) and a
`themes:activate` write. Activate goes through the same `saveStoreTheme` as the Settings
"Store theme" radio, so both surfaces store only an id the site offers.

- `__OTTA_STORE_THEMES__` entries may carry an optional `description` (≤ 160 characters) and
  `preview` (a same-origin absolute image path such as `/theme-previews/plinth.webp`). A
  malformed one makes the whole list absent, as before; the id `off` is reserved.
- New exports `THEME_PREVIEW_PARAM` (`preview_theme`), `THEME_PREVIEW_OFF` (`off`) and
  `THEME_PREVIEW_SILENT` (`silent`, which the Themes screen's exit adds for an empty answer
  instead of a redirect): the live-preview contract the site's middleware reads.
