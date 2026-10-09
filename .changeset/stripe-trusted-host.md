---
"@otta-sh/plugin": minor
---

`createOttaPlugin({ trustedHost: true })` tells the plugin it runs in-process (EmDash
`plugins:`), so every Stripe call — the gateway and the account-country read — carries an
`AbortSignal` and a timed-out request releases its socket. The new
`@otta-sh/plugin/trusted` entry is the plugin with that option on, for a trusted
descriptor's `entrypoint`. Never use either under `sandboxed:`: a signal cannot cross the
sandbox runner's RPC. The default export is unchanged (no signal).
