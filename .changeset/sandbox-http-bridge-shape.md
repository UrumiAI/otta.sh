---
"@otta-sh/plugin": patch
---

The workerd test sandbox's `ctx.http.fetch` (`./sandbox-entry`) now answers in the shape
EmDash's Cloudflare Worker Loader bridge gives a sandboxed plugin in production: a plain
`{status, ok, headers, text(), json()}` with the body already buffered, and no `url` or
`body` stream. Code that relied on either now fails in the sandbox suites instead of only in
production. Every existing sandbox suite passes unchanged.
