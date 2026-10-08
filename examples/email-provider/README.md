# Example email provider (template, not published)

A minimal EmDash email-transport plugin that POSTs each message to an HTTPS JSON email API.
Copy it, rename the package and the plugin `id` (`http-email`), set `EMAIL_API_URL`, and change the request body to your API's shape.

- `src/index.ts` is the descriptor you register in your site's EmDash config.
- `src/plugin.ts` holds the `email:deliver` handler and the API URL.
- `test/` runs it against a stubbed `fetch`.

The guide is [`docs/email-providers.md`](../../docs/email-providers.md).

This folder is typechecked and tested by the repo's `pnpm typecheck` and `pnpm test`. A copy's
tests run automatically (`examples/*`), but to include a copy in `pnpm typecheck`, add
`{ "path": "examples/<your-folder>" }` to the root `tsconfig.json` references.
