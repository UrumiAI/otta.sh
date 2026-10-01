---
"@otta-sh/plugin": minor
---

Settings gains a **Store theme** picker (a radio group, so each theme shows by its label) in
the Store group, beside the display name.

- **The site owns the list.** The plugin hard-codes no list (`tempered` is only the
  preferred fallback): it reads the themes a site offers from the build-time define
  `__OTTA_STORE_THEMES__` (a JSON array of `{ id, label }`), the same pattern as
  `__OTTA_EMAIL_API_URL__`. A list that fails the shape check (non-empty; ids
  `^[a-z][a-z0-9-]{0,31}$`; labels 1–40 characters) is treated as absent.
- **Absent means no picker.** A host that bakes no list (the sandbox bundle, other
  sites) renders the Store group exactly as before, and `save-theme` is refused.
- **Saving** stores the id in `settings:storeTheme` and toasts "Theme saved — live on the
  next page load". An id the site does not offer is refused with an error notice and
  nothing is written. The picker selects the stored id; when none is saved, the stored one
  is no longer offered, or the kv read fails, it selects `tempered` if the site offers it,
  else the site's first theme — so it always shows one of the site's own options.
- The Store group's collapsed label carries the theme: `Store — Acme · Tempered`.

No other setting changes.
