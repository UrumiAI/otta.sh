---
"@otta-sh/plugin": minor
---

New subpath `@otta-sh/plugin/testing` with `recordingEmailProvider()`: a fake email transport
for tests. Use it as `ctx.email` or as an EmDash `email:deliver` handler. It records every
message (`attempts`, `sent`) and can be told to `fail()` or `hang()`. See
`docs/email-providers.md` for how to bring your own email provider.
