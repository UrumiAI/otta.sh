---
"@otta-sh/plugin": patch
---

Read the `X-Otta-Wh-Token` edge-token header off EITHER a real `Headers`
instance or a plain record, in the public `webhooks/stripe/settle` route.

This is defensive hardening, NOT a fix for an observed failure. On the dispatch
path EmDash actually uses today, the plain-record branch was already correct and
no genuine delivery was ever rejected by this code. Otta registers as a
`format: "standard"` plugin whose default export carries no top-level `id`, so
EmDash's integration wraps the handler in `adaptSandboxEntry`, and that adapter
flattens `ctx.request.headers` into a lowercase `Record<string, string>` before
Otta's handler runs — for the in-process registration as well as the sandboxed
one, and regardless of whether the site declares a sandbox runner. Enumerating
the record was, and remains, the branch that fires in production.

What changed is that the lookup no longer depends on that staying true. It sniffs
the container at runtime (`Headers` is identified by its `.get`, which is already
case-insensitive) and falls back to the case-insensitive enumeration otherwise,
so a future dispatch path that handed over a genuine `Request` would be read
correctly rather than silently seeing no headers at all. No public export
changed, and the gate's semantics are untouched: an unset token still passes
through, a present-but-wrong token is still refused in constant time, and the
Stripe HMAC is still unconditional.
