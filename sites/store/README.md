# @urumi.ai/otta-store

The Otta storefront and admin as **one Astro integration** (ADR-0045): an
[EmDash](https://github.com/emdash-cms/emdash) site on Cloudflare Workers with the Otta
commerce plugin registered trusted in-process. A site's whole config is:

```js
// astro.config.mjs
import cloudflare from "@astrojs/cloudflare";
import otta from "@urumi.ai/otta-store";
import { defineConfig } from "astro/config";

export default defineConfig({
	adapter: cloudflare(),
	integrations: [otta({ template: 1 })],
});
```

`otta()` registers React and EmDash with the Otta plugin and console, injects the storefront
routes (one per file under `src/pages`) and the site middleware, sets the fonts, image and
Vite settings, ships `public/` at the same URLs, and runs the build guards (the private
downloads bucket, the `EMAIL` binding for a sender, the seed and live-collections checks,
secrets and build paths kept out of the bundle).

The easiest way to use it is the one-click store template: see the repository's
[`DEPLOYMENT.md`](../../DEPLOYMENT.md) §2.6 for what a site needs besides this file
(`wrangler.jsonc`, `src/worker.ts`, `src/live.config.ts`, the pinned dependencies), and
[`UPGRADING.md`](../../UPGRADING.md) for the template contract.

## Options

| Option | Build variable it replaces | |
|---|---|---|
| `template` | — | Required. The template contract the site's own files follow. |
| `emailFrom`, `emailFromName` | `OTTA_EMAIL_FROM`, `OTTA_EMAIL_FROM_NAME` | The default Cloudflare email sender (ADR-0043). Needs the `EMAIL` binding. |
| `extraAllowedHosts` | `OTTA_EXTRA_ALLOWED_HOSTS` | Extra egress hosts for the plugin. |
| `wranglerConfig` | — | The wrangler file the build uses, if not `wrangler.jsonc`. |
| `envDir` | — | Where the `.env` fallback for the variables above is read. Default: the working directory. |

## What ships

Only `src/integration.ts` is compiled (`dist/integration.mjs`), because Node loads
`astro.config.*`. Everything else (pages, middleware, worker, theme, fonts) ships as source
and is compiled by the site's own Vite build. That is also what applies the plugin's
build-time defines.

MIT licensed.
