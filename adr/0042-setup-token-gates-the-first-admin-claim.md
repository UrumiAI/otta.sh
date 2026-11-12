# 0042. A setup token gates the first-admin claim

- Status: accepted
- Date: 2026-11-03

## Context

A freshly deployed Otta store is unclaimed, and EmDash (1.3.1) gives the first admin account
to whoever finishes its setup wizard first. DEPLOYMENT.md used to tell the deployer to claim
the store at once, or to put Cloudflare Access in front of `/_emdash/*` until they had. A
Deploy-to-Cloudflare button makes that unacceptable: the store is reachable on a guessable
`workers.dev` name before its owner opens it, and "claim it fast" is a race the owner can lose.

EmDash has no setup token. Its only protection is a nonce cookie (`emdash_setup_nonce`) that
ties `POST /setup/admin` to `POST /setup/admin/verify` in one browser. That nonce stops a
second visitor swapping the email mid-flow. It does nothing about who starts the flow.
EmDash's own setup and auth middlewares run first (`order: "pre"`). The site middleware
(`src/middleware.ts`) runs after them and before every route handler, so the gate goes there.

Options considered:

- **Cloudflare Access in front of `/_emdash/*`.** Strong, but it is a manual dashboard step on
  a Zero Trust account, and the point of the button is that there are no manual steps. It
  stays possible as extra defence. It is no longer the answer.
- **Patch EmDash.** Not ours to ship, and gone on the next upgrade.
- **Gate only the six `/setup/*` routes.** That misses the other ways in. The OAuth callback
  creates the first user and calls `finalizeSetup`. `auth/dev-bypass` inserts an admin.
  Signup and invite create users. A route a future EmDash adds would be open until someone
  noticed it.
- **Default-deny `/_emdash/*` while unclaimed, with a short exemption list.** Chosen.

## Decision

1. **What is gated.** While setup is not complete, every request whose matched route
   (`context.routePattern`) or path (raw or `decodeURI`-decoded) is under `/_emdash` is
   refused unless it carries the setup token. Every method is covered. There are three
   exemptions, by route pattern, in `SETUP_GATE_EXEMPT_ROUTES`:
   `/_emdash/api/media/file/[...key]` (public media reads),
   `/_emdash/api/plugins/[pluginId]/[...path]` (the storefront's commerce calls; plugins
   cannot create EmDash users, and their admin routes need a signed-in user, which an
   unclaimed store does not have) and `/_emdash/api/health`. The storefront is never
   looked at: the first check is a string test that returns before any state or database
   is read.

2. **Where the token comes from**, in this order:
   - **The Worker secret `OTTA_SETUP_TOKEN`**, if it is set. It must be at least 32
     characters of `[A-Za-z0-9_-]` (it travels in a URL), and its length × log2(distinct
     characters) must reach 128 bits (`openssl rand -hex 32` scores 256). A secret that is
     set but fails this check **fails closed**. Nothing is admitted, a token is not
     generated in its place, and one error per isolate names the problem. The secret alone
     is enough, so a future Deploy button can ask for it and nothing else.
   - **Otherwise, a generated token**: 32 random bytes as base64url, made on the first gated
     request. It is stored in **EmDash's `options` table** under `otta:setup_token`. That
     table, rather than a table of our own, because EmDash's migrations already create it
     and it lives on the site's D1 (`DB`). There is no migration to add, the same handle
     works on local SQLite and D1, and `OptionsRepository.setIfAbsent` is exactly
     `INSERT … ON CONFLICT(name) DO NOTHING`. Concurrent first requests in different
     isolates each try to insert. Exactly one wins and every other reads that row back, so
     there is only ever ONE token, and only the winner logs it. The winner writes the full
     claim link once with `console.log`, tagged `[otta-setup]`. Console logs are on in
     `wrangler.jsonc` (`observability`), so only the Cloudflare account can read them, **unless
     the account exports them**: Logpush jobs and tail Workers forward every console line,
     the claim link included, to their sinks. A deployer who exports Worker logs sets
     `OTTA_SETUP_TOKEN`, and then nothing is logged. The link is always written for
     `https://` unless the host is loopback, so a first request that arrived over plain
     HTTP never yields a cleartext link. The
     row is also the fallback when the log has aged out:
     `wrangler d1 execute … "SELECT value FROM options WHERE name = 'otta:setup_token'"`.
     While the store is unclaimed, none of the routes left open can read the `options` table.

3. **Delivery.** The link is `/_emdash/admin/setup?setup_token=<token>`. That path, because
   EmDash's setup middleware redirects every other `/_emdash/admin` path to it while
   unclaimed and would drop the query string. A correct token in the query string, on
   GET or HEAD only, gets a `200` page that:
   - sets `otta_setup_claim=<token>; Path=/_emdash/; Max-Age=3600; HttpOnly;
     SameSite=Strict`, plus `Secure` unless the host is loopback (`localhost`,
     `127.0.0.1`, `[::1]`, `*.localhost`), where the dev server is plain HTTP;
   - sends `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`;
   - uses `<meta http-equiv="refresh">` to go to the same URL without the parameter.

   The refresh is a **meta refresh, not a 3xx**, on purpose. The link is usually opened
   from another site (the Cloudflare dashboard), and browsers do not send a
   `SameSite=Strict` cookie on a redirect chain that began cross-site. A navigation started
   by a same-origin page does carry it. After that, the wizard page and all of its API
   calls carry the cookie. A write is admitted by the cookie only, never by the query
   string. A query token that does not match is not a refusal on its own: the request
   falls through to the cookie check, so a deployer who reopens an old link while holding
   a valid claim cookie still reaches the wizard (when the link is pasted or bookmarked: a
   link followed from another site does not carry the `SameSite=Strict` cookie, and gets
   the 403 page). Tokens are compared with the plugin's `constantTimeEquals`.

   A link opened over plain HTTP on a non-loopback host gets a `307` to the same URL on
   `https://`, before the token is checked: the browser would drop the `Secure` cookie of
   an HTTP response, and the claim would end on the 403 page with no reason given.

   A request without a valid token gets a 403. Under `/_emdash/api` it is JSON
   (`SETUP_CLAIM_REQUIRED`); anywhere else it is an HTML page that says where the deployer
   finds the link (Workers Logs, or the secret). The page is byte-identical in every mode
   (secret, generated, broken secret), so it never reveals whether a token exists. A
   missing database or a query error gets a `503`. Nothing is ever let through.

4. **Once claimed, inert.** Setup is complete when `emdash:setup_complete` is true **and** a
   user exists. That is EmDash's own test in passkey mode, and the reference site uses
   passkey auth. The gate is written for **passkey mode only**. In EmDash's external-auth
   mode (e.g. Cloudflare Access), EmDash's `handleExternalAuth`, a `pre` middleware that
   runs before this one, already makes the identity provider the gate: in production, no
   private `/_emdash` request gets past it without the provider's verified identity. There the
   setup flag alone marks completion, so this gate would stay closed after setup. A site
   switching to external auth must revisit it. One query reads the completion flag, whether a user exists, and the
   stored token. The first gated request that finds the store complete caches that in
   isolate memory, and from then on the gate makes no query. An "unclaimed" answer is never
   cached, so the request right after the wizard finishes is let through. While unclaimed,
   a `/_emdash` request pays one query, plus one or two on the request that mints the
   token, which is well inside Workers Free's 50.

5. **No development exception.** Local dev and the e2e suite get through the gate the way a
   deployer does. With no secret set, the dev server prints the link. `playwright.config.ts`
   gives a throwaway token (`E2E_SETUP_TOKEN` in `e2e/harness.ts`) to the dev server it boots as
   `OTTA_SETUP_TOKEN`, and to its own processes. The suite then presents that token: as the
   cookie in browser contexts (`grantSetupClaim`) and in scripts' `fetch`
   (`scripts/setup-claim-cookie.ts`). That throwaway token,
   `PUBLIC_E2E_SETUP_TOKEN` in `src/lib/setup-claim-contract.ts`, is public, so the gate
   refuses it as `OTTA_SETUP_TOKEN` on any host but loopback (fail closed, with the same
   warning as a weak secret). `pnpm test:e2e:claim` (`playwright.claim.config.ts`) boots its
   own stack on a fresh, unseeded state directory and follows the link from a page on
   another site, so the cross-site cookie hand-off is tested in a real browser. The one
   build that skips the gate is the
   **playground** build (`__OTTA_PLAYGROUND__`, baked `false` in the storefront build).
   There, EmDash creates every visitor's database already claimed and does not install its
   own setup and auth middlewares.

### Routes audited (emdash@1.3.1)

| Route | Can it create a user or finish setup? | Verdict |
|---|---|---|
| `POST /_emdash/api/setup` | Applies the seed, writes setup state (and finishes setup under external auth) | gated |
| `POST /_emdash/api/setup/admin` | Starts admin creation (setup state + nonce) | gated |
| `POST /_emdash/api/setup/admin/verify` | **Creates the first admin**, sets `setup_complete` | gated |
| `GET /_emdash/api/setup/status` | Read-only (wizard step, seed info) | gated (default-deny) |
| `GET,POST /_emdash/api/setup/dev-bypass` | DEV only in EmDash; inserts an admin, completes setup | gated |
| `POST /_emdash/api/setup/dev-reset` | DEV only in EmDash; deletes users and setup state | gated |
| `GET,POST /_emdash/api/auth/dev-bypass` | DEV only in EmDash; inserts an admin | gated |
| `/_emdash/api/auth/oauth/[provider]` and `…/callback` | Callback **creates the first user and calls `finalizeSetup`** when OAuth env is set | gated |
| `/_emdash/api/auth/signup/{request,verify,complete}` | Creates users (allowed-domain self-signup) | gated |
| `/_emdash/api/auth/invite/*` | Creates users from an admin's invite | gated |
| `/_emdash/api/auth/magic-link/{send,verify}` | Signs in existing users only | gated |
| `/_emdash/api/auth/passkey/*` | Sign-in and registration for existing users | gated |
| `/_emdash/api/auth/{me,mode,logout,handover}` | Session reads and changes | gated |
| `/_emdash/api/oauth/*`, `/_emdash/oauth/authorize`, `/_emdash/.well-known/auth` | Need an existing user (register makes client rows only) | gated |
| `/_emdash/admin/[...path]` (the SPA, wizard included) | Hosts the wizard | gated, 403 page |
| every other `/_emdash/api/*` (`admin`, `content`, `settings`, `mcp`, …) | Need a signed-in user | gated |
| `/_emdash/api/media/file/[...key]` | No (public media GET) | exempt |
| `/_emdash/api/plugins/[pluginId]/[...path]` | No (plugin storage only) | exempt |
| `/_emdash/api/health` | No | exempt |
| `/.well-known/oauth-*`, `/sitemap*.xml`, `/robots.txt` | No (read-only, outside `/_emdash`) | not gated |

## Consequences

- A deployed store can only be claimed by someone who can read the Worker's secrets or logs,
  that is, the Cloudflare account. Cloudflare Access is no longer needed for this.
- **OAuth sign-in cannot be how a store is claimed.** The provider's redirect back is a
  cross-site navigation, which carries no `SameSite=Strict` cookie, so the callback is
  refused while unclaimed. The passkey wizard is the claim path. OAuth works as before once
  the store is claimed. The reference site configures no OAuth provider.
- Before the claim, the admin and every EmDash API are closed to the public. The storefront,
  its media and its plugin calls are not. An unclaimed store has no catalog anyway.
- The gate relies on these EmDash internals, and an upgrade must re-check them: the option
  name `emdash:setup_complete` stored as JSON `true`; the `options(name, value, revision)`
  and `users` tables; `OptionsRepository.setIfAbsent`; the injected route patterns in the
  exemption list (a renamed pattern there fails closed, as gated); and the setup middleware
  leaving `/_emdash/admin/setup` alone. `test/setup-claim.test.ts` runs against EmDash's
  real migrations, so a changed schema shows up there.
- A token stays in `options` after the claim. It is inert, because the gate never consults
  it once setup is complete. If setup were ever undone (EmDash's dev-only reset), the same
  token would claim it again. An isolate that has cached "complete" stays open until it is
  recycled, which only matters in dev. **Audited, no TTL re-check:** in emdash@1.3.1 the only
  code that clears `emdash:setup_complete` or deletes every user is `setup/dev-reset`, which
  answers 403 outside `astro dev`. The transfer/backup import resets only
  `byline_fields_version` and `_redirect_loop_ids`. `UserRepository.delete` has no caller,
  the admin users routes disable and enable but never delete, and demoting the last admin is
  refused. So a cached "complete" cannot go stale in production. An EmDash upgrade that adds
  such a path must add a re-check here.
- Exported logs (Logpush, tail Workers) carry the generated claim link to wherever they are
  sent. Set `OTTA_SETUP_TOKEN` on such accounts.
- A local store or a hand-started e2e server on fresh state is locked until claimed. The
  site README says how.
