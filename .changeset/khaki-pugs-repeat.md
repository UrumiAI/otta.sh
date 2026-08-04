---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

Product detail: a tab switch no longer discards unsaved edits. Both tab panels
stay mounted (the inactive one `hidden`), so every form keeps its state and each
tab's `aria-controls` resolves in both states. Unsaved work is now legible in
three places — a warn border on the changed input, `· unsaved` on a shut group's
summary, and a dot on the tab button with an accessible name that says so. Each
section re-seeds only on its own successful save, leaving the other two drafts
intact; leaving the product is the one remaining path that discards, and it now
confirms first and names the sections holding work. The sibling-save helper
sentence is rewritten to describe that behaviour.
