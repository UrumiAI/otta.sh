# Example email provider (template, not published)

A minimal EmDash email-transport plugin that POSTs each message to an HTTP JSON
email API. Copy it, rename the package, and change the request body to your API's shape.

- `src/index.ts` is the descriptor you register in your site's EmDash config.
- `src/plugin.ts` holds the `email:deliver` handler.
- `test/` runs it against a stubbed `fetch`.

The guide is [`docs/email-providers.md`](../../docs/email-providers.md). This folder is
typechecked and tested by the repo's `pnpm typecheck` and `pnpm test`, so it tracks EmDash
upgrades.
