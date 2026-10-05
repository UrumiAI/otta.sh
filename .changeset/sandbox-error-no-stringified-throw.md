---
"@otta-sh/plugin": patch
---

The sandbox worker no longer sends a stringified non-Error throw back to its caller. A failed invocation still returns an `Error`'s own message, never its stack; anything else becomes "internal error", and the full value is logged in the isolate.
