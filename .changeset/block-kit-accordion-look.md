---
"@otta-sh/admin-react": patch
---

The collapsible sections on the store's Reports, Settings, Tax, Shipping and Coupons pages get a clean,
grouped look. They used to render as a bare blue link with a chevron, with the open body hung
off a grey left rule. Each one is now a full-width row on the admin's card surface — label in
the default ink, chevron on the trailing edge that turns as the row opens, a soft hover tint, a
visible keyboard focus ring, a hairline under an open row — and sections that sit next to each
other join into one grouped list. Opening and closing ease the height (instant under reduced
motion). Colours, radius and type are the admin's own tokens, so the classic light theme and
dark mode both follow.

The plugin stays Block Kit; the sheet ships from the `otta-console` admin module, which EmDash
already loads on every admin page, and applies only while one of the `otta` plugin's own pages
is open — other plugins and EmDash's own screens keep their look.
