---
"@otta-sh/plugin": patch
---

Add the `./plugin` export (the standard-format descriptor entrypoint —
default-exports the `{hooks, routes}` object for em-dash's `plugins: []` /
`adaptSandboxEntry`) and a compile-time `__URUMI_COMMERCE_SERVICE_URL__`
override in the manifest: a deploying site can bake the real commerce-service
URL into the bundle via a Vite define; without the define the placeholder is
unchanged (sandbox-clean — no runtime env/IO read).
