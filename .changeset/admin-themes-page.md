---
"@otta-sh/admin-react": minor
---

New **Themes** page on `otta-console` (`/themes`, ADR-0014 amended 2026-09-30): a screenshot grid
of the storefront themes, active first under an accent bar, **Activate** on the rest, and a
full-screen **Live preview** of the real storefront in any theme (desktop/tablet/phone widths, Esc
to close, focus trapped and returned, "Open in new tab"). Activating toasts and re-orders the grid.
Reads the admin's Kumo CSS custom properties so it matches light and dark mode; no new dependency.
