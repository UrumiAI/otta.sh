---
"@otta-sh/domain": patch
"@otta-sh/plugin": patch
---

The sign-in email names the store and leads with a button (QA2 U-3).

- **A store name without the setting.** When "Store display name" is unset, the emails
  use the EmDash site name (`ctx.site.name`). The sign-in email said "Your sign-in link"
  and "Sign in" on every store that had not filled in the field. The order emails'
  sign-off follows the same rule.
- **A button, with the URL kept.** The HTML part's link is now an inline-styled button
  (padded, filled, bold — mail clients drop `<style>` blocks); the plain URL stays
  below it as the copy-paste fallback, and the text part is unchanged.
