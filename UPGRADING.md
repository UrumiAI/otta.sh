# Upgrading an Otta store

A store made from the one-click template ([`DEPLOYMENT.md`](./DEPLOYMENT.md) §2.6) gets Otta
as a dependency, `@urumi.ai/otta-store`. Most releases need nothing from you: merge the
Dependabot pull request and Workers Builds deploys it.

Two kinds of release need you.

**A release that moves EmDash, Astro or React.** `@urumi.ai/otta-store` declares them as peer
dependencies (EmDash and `@emdash-cms/cloudflare` exactly, the others to the minor), and the
template's Dependabot never updates them, because a mismatch would install a second EmDash. So
such a release does **not** arrive as a working Dependabot pull request: Dependabot holds back
the Otta update, or the build stops at `npm install` with an `ERESOLVE` error, before Otta's
own checks run. It is announced in the release notes. Bump the versions its section below
lists in `package.json` by hand, together with the `@urumi.ai/*` packages, and push.

**A release that changes your repository's other files** (a new binding in `wrangler.jsonc`,
a new file) raises the **template contract**, the number your `astro.config.mjs` passes as
`otta({ template: N })`
([ADR-0045](./adr/0045-the-store-ships-as-an-astro-integration-for-one-click-deploy.md)).
Until you make the change, that release's build fails with

```text
@urumi.ai/otta-store <version> needs template contract <N>, but astro.config.mjs passes
otta({ template: <yours> }) …
```

and nothing is deployed: the store keeps running the last version that built. Follow the
section for each contract number between yours and the new one, in order, then set
`template` to the new number and push. This message covers template-file changes only; a
version move announces itself as above.

## Your own middleware runs before Otta's

`otta()` registers the store's middleware after EmDash's (`order: "post"`), and Astro runs a
site's own `src/middleware.ts` between the two. So **a store's own middleware runs before
Otta's**, which holds the cross-site request check and, until the store is claimed, the
setup-link gate (ADR-0042). A site middleware that answers a request itself instead of calling
`next()` skips both for that request. Call `next()` for every path you do not own, and never
answer `/_emdash/*` or the cart, checkout and account routes.

## Template contract 1

The first contract, `@urumi.ai/otta-store` 0.2.0. A store on it has:

- `astro.config.mjs`: the `@astrojs/cloudflare` adapter and `otta({ template: 1 })`;
- `src/worker.ts`: `export { default, PluginBridge } from "@urumi.ai/otta-store/worker";`;
- `src/live.config.ts`, which calls `defineLiveCollection` itself (Astro gives it to this
  file only):

  ```ts
  import { defineLiveCollection } from "astro:content";
  import { ottaLiveCollections } from "@urumi.ai/otta-store/live-config";

  export const collections = ottaLiveCollections(defineLiveCollection);
  ```

- `package.json`: exact pins of `@urumi.ai/otta-store`, `@urumi.ai/otta-plugin`,
  `@urumi.ai/otta-admin-react`, `emdash`, `@emdash-cms/cloudflare`, `astro`,
  `@astrojs/cloudflare`, `@astrojs/react`, `react`, `react-dom` and `wrangler`, and
  `"emdash": { "seed": "node_modules/@urumi.ai/otta-store/seed/seed.json" }`;
- `wrangler.jsonc`: `DB` (D1), `MEDIA` and `DOWNLOADS` (two different R2 buckets), `SESSION`
  (KV), `IMAGES`, `RATE_LIMIT_AUTH` and `RATE_LIMIT_WRITES`, the `* * * * *` cron,
  `nodejs_compat`, and Workers Logs on with invocation logs off.

There is nothing to upgrade from: it is the first.

## EmDash 1.3.1 to 1.5.0

The Otta release after `0.2.0` that moves EmDash (its release notes say so) needs `emdash` and
`@emdash-cms/cloudflare` at exactly `1.5.0`, together. Since 1.5.0, `@emdash-cms/cloudflare`
declares `emdash` as an exact peer, so npm refuses (`ERESOLVE`) a `package.json` where the two
differ. Astro, `@astrojs/cloudflare`, `@astrojs/react`, React and wrangler do not move: 1.5.0
asks for `astro >=6`, `@astrojs/cloudflare >=12`, `wrangler >=4.99.0` and React 18 or 19.
`@emdash-cms/auth-atproto`, a new peer of `emdash`, is optional; a store does not need it. No
repository file changes, so the template contract stays at 1.

### The database migrations

EmDash 1.4.0 added no core migrations. 1.5.0 adds six, `092` to `097`. None of them changes
Otta's commerce documents (the `_plugin_storage` rows of collections other than `__kv`).

| Migration | What it does | On an Otta store |
|---|---|---|
| `092_plugin_kv_options` | Copies sandboxed plugins' `ctx.kv` values (`_plugin_storage` rows in collection `__kv`, keys not starting `settings:`) into `options` as `plugin:<id>:<key>`. Never overwrites a value already there; keeps the old rows. | Otta runs trusted, so its `ctx.kv` already lives in `options`. Nothing to copy, unless the store once ran Otta sandboxed (check 2 below). |
| `093_menu_item_orphans` | Moves menu items whose parent is gone to the top level. | CMS menus only. |
| `094_media_usage_file_url_reindex` | Marks the media "Used in" index for rebuilding. | CMS media only. |
| `095_plugin_storage_unique_scope` | Makes each plugin storage `uniqueIndexes` entry unique only within its own plugin and collection, rebuilding the tracked unique indexes. | Otta declares no `uniqueIndexes` (its once-only rules are create-if-absent documents), so with no other storage plugin there is nothing to rebuild (check 1 below). |
| `096_revision_kind_and_editors` | Adds two nullable columns, `kind` and `edited_by`, to `revisions`. | CMS revisions only. |
| `097_room_storage` | Creates `_emdash_rooms` and `_emdash_room_updates` for co-editing (off unless `coEditing: true`). | New empty tables. |

Like every migration, these are forward-only: rolling the Worker back afterwards restores the old
code, not the old database (see "Going back" below).

EmDash treats `095` as a **maintenance-window** migration for sites that have plugin unique
indexes: an older build still serving can recreate the old table-wide indexes, so it must not run
from a pre-deploy job beside live old code
([EmDash: updating](https://docs.emdashcms.com/deployment/updating/#fixed-plugin-storage-uniqueness)).
A store made from the current template (its `scripts/deploy.mjs` from template commit `6354edd`
on) therefore stops in `npm run deploy` on an existing store whenever `095` is pending, before it
migrates or deploys anything, and points here. Older stores do not stop: one made between
template commits `3807e1d` and `6354edd` applies every pending migration in the build, and one
made before `3807e1d` (whose `deploy` is plain `wrangler deploy`) leaves them to the new Worker's
first request. On those, run the checks below **before** pushing the version bump. EmDash also asks for a coordinated,
not rolling, upgrade for `092` when sandboxed `ctx.kv` values exist
([EmDash: plugin KV storage](https://docs.emdashcms.com/plugins/upgrading-sites/#plugin-kv-storage-when-changing-execution-mode)).

### Upgrading a store

1. **Take a recovery point.** Note a D1 Time Travel bookmark:
   `npx wrangler d1 time-travel info <your-database-name>`.
2. **Check what the two migrations would touch.** In the dashboard, open **Storage & Databases >
   D1**, your store's database, **Console**, and run:

   ```sql
   SELECT plugin_id, collection, index_name FROM _plugin_indexes WHERE index_name LIKE 'uidx_plugin_%';
   SELECT plugin_id, id FROM _plugin_storage WHERE collection = '__kv' AND substr(id, 1, 9) <> 'settings:';
   ```

   Rows from the first mean a plugin declares `uniqueIndexes`; rows from the second mean a
   plugin (Otta or another) once ran sandboxed with `ctx.kv` values. A store made from the
   template, with only Otta's plugins, returns no rows from either.
3. **If both are empty**, `092` and `095` have nothing to do, and no maintenance window is
   needed. Apply the migrations from your machine, then deploy:

   ```bash
   # in your store's repository, after bumping the versions in package.json
   npm install
   npm run build                       # writes .emdash/migrations.json
   export CLOUDFLARE_API_TOKEN=...     # D1 Edit on the account
   export CLOUDFLARE_ACCOUNT_ID=...
   npx emdash migrate --status --d1 <your-database-name>   # lists 092-097 as pending
   npx emdash migrate --d1 <your-database-name>            # asks you to confirm the target
   npx emdash migrate --check --d1 <your-database-name>    # exits 0: nothing pending
   ```

   Then commit and push. The build finds nothing pending and deploys. Until then the running
   1.3.1 Worker keeps serving: it sees at least as many applied migrations as it knows and does
   not migrate, and the new columns and tables are ones it never reads.
4. **If either returns rows**, follow
   EmDash's maintenance-window steps in the two pages linked above (route traffic to a
   maintenance page and pause the cron, deploy in `check` mode, migrate, verify, reopen) and, for
   `__kv` rows, review any value the migration log reports as conflicting before plugins write
   again.
5. **After the deploy**, open the admin, load the shop and a product page, and run one test
   order. Since 1.5.0, on each new Worker isolate, the first state-changing Otta request (a cart
   change, a checkout, a payment webhook, an admin action) first checks that the plugin's storage
   indexes are in place and builds any that are missing. If that fails, the request answers
   `503 STORAGE_INDEXES_NOT_READY` and the next write or cron tick tries again. A shopper sees
   the error and can retry; Stripe retries a webhook that failed (the route answers 500), so no
   payment is lost.

### Going back

- **Migrating failed:** restore the bookmark from step 1,
  `npx wrangler d1 time-travel restore <your-database-name> --bookmark=<id>`. A restore
  discards **everything** written since the bookmark, every order, cart and customer included,
  and that includes orders the running store took while you migrated (the old version keeps
  serving throughout). Check Orders for anything newer than the bookmark before restoring, and
  never restore once the store has taken traffic on the new version.
- **The new version misbehaves after the deploy:** roll the Worker back to the 1.3.1 version in
  the dashboard (**Workers & Pages** → your Worker → **Deployments**) and leave the database
  as it is. That is safe: the 1.3.1 runtime sees at least as many applied migrations as it knows
  and skips migrating, the `096` columns are nullable, the `097` tables are never read, and `092` copied nothing
  on a store whose check 2 came back empty (it never removes the old `__kv` rows either).
- **Not** a `git revert` of the bump and a push: the template's `npm run deploy` (template
  commit `3807e1d` on) refuses a database that has migrations its build does not know, and stops
  without deploying.

### What else changes

- **A new store starts in "staging".** Since 1.5.0, EmDash's setup marks a new site as staging:
  the admin shows a **Staging** badge until an administrator selects **Go live** under
  **Settings > General > Site Status**. Its `noindex` tag is added only to pages that render
  EmDash's `<EmDashHead>`, which Otta's storefront does not, so search engines are not affected;
  select **Go live** to clear the badge. Existing stores are not changed.
- **A failed `plugin:activate` now leaves a plugin off.** Re-enabling a plugin whose activate
  hook fails reports the error and keeps it inactive (1.5.0). Otta has no `plugin:install` hook,
  and its `plugin:activate` only (re)registers its cron task and never fails.
