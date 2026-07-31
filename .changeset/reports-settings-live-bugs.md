---
"@otta-sh/plugin": patch
---

Fix two live bugs on the admin Reports/Settings pages.

- Settings: saving the store display name no longer destroys the page. The
  success path used to return only two blocks, dropping the other three
  forms with no way to recover without navigating away; the invalid-name
  path had the same shape, with no field left to correct the name. Both now
  re-render the full three-group screen plus a notice.
- Reports: every table now sets the required `page_action_id`, and the admin
  route dispatcher registers and dispatches the Reports page action id.

Also migrates both pages to the shared `{variant, title, description}`
banner shape, and gives every Settings form a change-token `block_id` so a
saved value redisplays correctly.
