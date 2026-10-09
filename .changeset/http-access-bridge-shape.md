---
"@otta-sh/plugin": patch
---

`HttpAccess.fetch` now answers `HttpResponse` (`status`, `ok`, `headers`, `text()`,
`json()`) instead of a full `Response`, matching what the sandbox bridge returns. Code
that read `url` or the `body` stream off `ctx.http.fetch` no longer type-checks; it
never worked sandboxed. A refused refund replay in the Orders console now logs a
warning with the status and reason.
