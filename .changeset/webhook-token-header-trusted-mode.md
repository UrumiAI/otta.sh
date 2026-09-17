---
"@otta-sh/plugin": patch
---

Read the `X-Otta-Wh-Token` edge-token header off a real `Headers` instance, not
just off a plain record, in the public `webhooks/stripe/settle` route.

The lookup enumerated `Object.entries(request.headers)`, which is correct only
for the SANDBOXED shape the `SandboxedRequest` type describes. A plugin
registered TRUSTED — how a site running Otta in-process registers it — is handed
EmDash's `guardConsumedRequestBody` proxy over the genuine `Request`, whose
`.headers` is a `Headers` whose entries live behind an iterator rather than on
the object. `Object.entries()` on one returns `[]`, so the gate read no headers
at all and, wherever `settings:otta-wh-token` was provisioned, saw "token set,
header absent" and rejected every genuine Stripe delivery with a 401. The
feature only functioned in the degraded both-sides-unset state.

The lookup now sniffs the container at runtime (`Headers` is identified by its
`.get`, which is already case-insensitive) and falls back to the previous
case-insensitive enumeration for the sandboxed record. No public export changed,
and the gate's semantics are untouched: unset token still passes through, a
present-but-wrong token is still refused in constant time, and the Stripe HMAC is
still unconditional.
