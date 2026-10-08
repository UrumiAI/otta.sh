---
"@otta-sh/plugin": minor
---

New build-time env var `OTTA_EXTRA_ALLOWED_HOSTS` (comma-separated hostnames) adds hosts to
the plugin's `ctx.http` egress allowlist. Entries must be plain DNS hostnames; wildcards, IP
literals, `localhost`, schemes, ports and paths fail the build with an error naming the entry.
