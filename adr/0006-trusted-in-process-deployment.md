# 0006. First-party deployments may register the plugin trusted (in-process), sandbox contract still binding

- Status: accepted
- Date: 2026-07-11
- Refines: ADR-0001 (the plugin's runtime placement), ADR-0003 (the storefront/cart shim contract)

## Context

The staging storefront (`sites/staging`) deploys EmDash + the Urumi plugin to Cloudflare
Workers. EmDash's plugin sandbox on Workers runs each sandboxed plugin in an isolate via a
Worker Loader binding — and Worker Loaders are the cost pivot that flips the account onto
Workers Paid. For a single-tenant, first-party store there is no third-party code to
contain: the only plugin in the host is our own, already built and tested against the
sandbox contract.

DEVELOPMENT.md §5 says "dev and test against the workerd sandbox, not trusted in-process
mode — if it only works trusted, it's broken." That rule is about the plugin's *contract*,
not about every deployment's runtime: the plugin's behavioral suites
(`packages/plugin/test/*.sandbox.test.ts`) boot the real `workerd` binary and prove every
hook and route inside the sandbox on every CI run.

EmDash supports this precisely: a standard-format `PluginDescriptor` in `plugins: []` is
wrapped by `adaptSandboxEntry` and runs in-process, but `capabilities` and `allowedHosts`
are still enforced by the plugin-context factory — `ctx.http.fetch` remains hostname-gated
exactly as in the sandbox.

## Decision

1. **Trusted (in-process) registration is allowed for first-party deployments** (sites we
   own, running only our own plugin), **iff the plugin keeps passing the full workerd
   sandbox suite.** The sandbox tests are the contract gate; a change that only works
   trusted is still broken and must not merge.
2. **Trusted-only APIs remain forbidden** in `@otta-sh/plugin`: no React admin components, no
   `page:fragments`, no `options`-configured native format, no direct DB/storage access —
   nothing that could not also run sandboxed. ADR-0003's route-based storefront shape
   stays.
3. The site registers the plugin via a hand-written descriptor
   (`sites/staging/src/urumi-plugin-descriptor.ts`): `format: "standard"`, entrypoint
   `@otta-sh/plugin/plugin`, capabilities exactly the manifest's
   (`content:read`, `network:request`), `allowedHosts` = the commerce service's hostname
   (baked at build time). No `sandboxed:`, no `sandboxRunner:`, no `worker_loaders`
   binding.

### The trust widening this accepts, named

In sandboxed mode, `sanitizeHeadersForSandbox` strips `cookie`/`set-cookie` from every
header set handed to a plugin — sandboxed routes are cookie-blind in both directions. In
trusted mode, `adaptSandboxEntry`'s route wrapper flattens the **raw** inbound `Request`
headers — **including the browser's `Cookie` header (EmDash session cookies among them) —
into the plugin route handler's `request.headers`**. So the cart-routes doc-comment claim
that a plugin route "cannot even READ the browser's Cookie header" is true sandboxed and
**false trusted**.

Why this is acceptable first-party: the code reading those headers is our own, reviewed in
this repo, whose sandbox suite proves it never *uses* any of it (handlers read only their
validated JSON input); there is no third-party plugin in the host to protect the cookies
*from*. It remains a real widening — worth re-narrowing upstream if EmDash ever sanitizes
headers uniformly — and it is why *third-party* plugins must never be granted `plugins: []`
on our deployments. Set-Cookie stays impossible in both modes (the route envelope is JSON
serialization, no header channel), so ADR-0003's cookie-descriptor shim design is
unchanged.

### CSRF story for the cart endpoints

Astro's `security.checkOrigin` (default true) was assumed to protect the site's `/cart/*`
POST endpoints. **It does not, verified empirically and in source:** the emdash astro
integration force-injects `security: { checkOrigin: false }` (so its own runtime CSRF
layer can support Docker-style late-bound public origins), and that replacement —
`checkPublicCsrf` — validates only `/_emdash/api/*` routes. Theme-owned endpoints are
left with no origin check at all; a cross-origin form POST to `/cart/add` went straight
through in dev.

So the site's `/cart/*` POST endpoints enforce CSRF themselves:

- **`rejectCrossOrigin`** (`sites/staging/src/lib/origin-guard.ts`, unit-pinned by
  `test/origin-guard.test.ts`) runs first in every cart endpoint: a present-but-mismatched
  `Origin` header (including the opaque `"null"`) is a 403; an absent Origin (curl /
  server-to-server, no ambient cookie) is allowed — the same semantics as em-dash's
  `checkPublicCsrf` and Astro's own middleware;
- the cart cookie's **`SameSite=Lax`** (+ `httpOnly`, `Secure`, applied verbatim from the
  plugin's descriptor — pinned by the cookie-shim test) keeps the victim's cart cookie off
  cross-site POSTs anyway;
- **server-side-only commerce calls**: the browser never talks to the commerce service;
  every service call goes through the plugin's `ctx.http`, gated by `allowedHosts`;
- our own `astro.config` still never sets `checkOrigin: false` (pinned by the site-config
  test), so nothing regresses further if emdash ever stops overriding it.

## Consequences

- Easier: Workers **free** plan suffices (no Worker Loader / Durable Object sandbox
  plumbing); one fewer moving part in the request path; plugin cron and hooks run
  in-process.
- Binding: the plugin's sandbox suite is now doubly load-bearing — it is the only thing
  keeping "runs trusted" honest. Removing or weakening those tests reopens this ADR.
- Accepted tradeoff: raw request headers (incl. cookies) reach our own route handlers
  (above). Mitigated by scope (first-party only), review, and the handlers' validated-input
  discipline.
- The commerce-service URL is baked at build time (Vite define + descriptor
  `allowedHosts`); changing it is a rebuild + redeploy, not a config flip.
- A future multi-tenant / marketplace deployment must NOT inherit this: third-party
  plugins go back in `sandboxed: []` with a sandbox runner (and Workers Paid).
