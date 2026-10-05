---
"@otta-sh/admin-react": patch
---

The refund amount and "Refunded by" inputs mark an error with a full `border` rather
than a `borderColor` laid over the base `border`, which React reported as a style
collision ("Removing borderColor border") when the error cleared and which could leave
the error border painted.
