# 0020. One deployable: the plugin owns commerce truth; the service is removed

- Status: accepted
- Date: 2026-09-20
- Supersedes **in part**: [ADR-0002](./0002-adapter-based-split.md). The **plugin/service
  split** it established — "a separate service is required today and stays a supported option
  indefinitely" — is **undone**. Its **ports-and-adapters discipline is not superseded; it is
  reaffirmed**, and it is precisely what makes deleting the service safe. This record also
  answers ADR-0002's five "a service may remain preferable" reasons, which
  [ADR-0018](./0018-plugin-owns-commerce-truth-in-process.md) deliberately left standing.
- Builds on: [ADR-0018](./0018-plugin-owns-commerce-truth-in-process.md) (the plugin may own
  commerce truth in-process) and
  [ADR-0019](./0019-commerce-aggregates-are-one-document-each.md) (how truth is shaped there).
  Both stand unchanged.
- Does **not** deprecate [ADR-0001](./0001-plugin-plus-commerce-service.md). ADR-0001 is
  referenced throughout this folder and it is easy to read "the service is removed" as
  retiring it wholesale. It does not. ADR-0001's product shape — an EmDash plugin that turns
  a site into a store, with the CMS owning content and commerce owning commercial fields — is
  what still ships. What ADR-0002 made a deployment choice, and what this record settles, is
  only *where the commerce implementation runs*.
- Amends: **nothing.**

## Context

ADR-0002 designed the plugin↔authority boundary as a **deployment choice over stable ports**,
and said two things would stay true regardless: that a separate service was *required* for as
long as the host's plugin sandbox lacked conditional writes, and that a service might *remain
preferable* even after those primitives landed, for five named reasons.

The first has expired. The host's conditional-write primitives exist, ADR-0018 admitted the
plugin to own commerce truth on `ctx.storage`, and ADR-0019 gave that truth a document model
whose guard semantics are pinned by the same contract suites the SQL stores passed. The
`@otta-sh/service` and `@otta-sh/store-postgres` packages have been deleted.

The second has not expired on its own; it has to be answered. ADR-0018 said so explicitly and
deferred it here. Keeping a second deployable "in case" is not free: it is a second secrets
store, a second database, a second deploy, a second set of migrations, and — the expensive
part — a wire format that every port change has to be mirrored into. The question is whether
any of the five reasons is worth that, **now, for a project that is pre-1.0, unlaunched, and
has no users**. That last clause is doing real work: every one of these reasons is a reason
one might *reintroduce* a service later on evidence, and none is a reason to *carry* one
today on speculation.

## Decision

**Otta is one deployable.** The EmDash site Worker, with the plugin registered trusted, runs
commerce in-process against the site's own database. There is no commerce service, and none
is kept on standby.

### 1. ADR-0002's five reasons, answered

Each is quoted as ADR-0002 wrote it, and each is **rejected — pre-launch, no users**.

1. **"payment-secret / PCI isolation."** Rejected. The isolation was never as clean as the
   phrase suggests — the site already terminated the buyer's session and already held the
   CMS encryption key — and Otta is not in PCI scope: card data never touches our process
   (Stripe Elements runs in the buyer's browser, per
   [ADR-0012](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md)). What the
   split actually bought was a smaller blast radius for the Stripe API secret, and that is a
   real loss, recorded as such in §2 below rather than argued away. With no users and no live
   keys in production, taking that loss now — with the mitigations in §2 — costs less than
   carrying a second deployable to preserve it.
2. **"stable public webhook URLs."** Rejected, and inverted: the webhook URL is now
   **permanently site-owned** (§3). A site the operator already has a domain for is a
   *better* home for a stable public URL than a second Worker on `*.workers.dev`, which was
   itself the source of the subrequest footgun the deployment guide used to be organised
   around.
3. **"independent scaling."** Rejected. There is nothing to scale independently yet, and the
   arbiter of stock and money truth was the single database in both designs — so
   "independent scaling" meant scaling a stateless tier away from a ceiling it did not own.
   The in-process design has the same ceiling and one fewer hop.
4. **"serving non-EmDash storefronts."** Rejected. No such storefront exists, and this is the
   reason most clearly answered by re-derivation rather than by standby (§4): the domain
   ports are unchanged, so a service for a non-EmDash consumer is a new adapter over an
   existing contract, not a resurrection.
5. **"a merged-in plugin on Cloudflare pins commerce truth to D1 (sandboxed plugins are
   D1-only)."** Accepted as a fact, rejected as a reason to keep a service. It is true: truth
   now lives in D1. ADR-0019 measured what that costs — a per-aggregate compare-and-set
   contention budget, stated as numbers and asserted by tests — and the storage seam is still
   a port, so the constraint binds the *adapter*, not the domain. Pinning to D1 is a bound we
   have measured, not one we have guessed at.

### 2. The Stripe-secret trust widening, recorded

This is the one genuine loss, and it is recorded rather than minimised.

Before the fold-in, the payment and email credentials were environment variables on a
separate Worker or Node process — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`EMAIL_API_KEY`, the x402 facilitator secret. With no second deployable to hold them, they
move to the one operator-provisionable store the plugin has: **write-only plugin `kv`**,
under the existing `settings:*` convention (`packages/plugin/src/payment-secrets.ts`,
work-order increment C3). Every key there is an existing service environment variable,
renamed — nothing was invented.

**What widened.** The Stripe API secret is now readable inside the same process that renders
storefront pages and the admin console, rather than living behind an HTTP boundary in a
process the storefront could only talk to over a narrow REST surface. A code-execution bug
anywhere in the plugin now reaches it. That is strictly more trust in one process than the
split design asked for, and no amount of `kv` discipline changes that.

**What bounds it.**

- Credentials are **write-only**: persisted only on a non-empty submit, never rendered back
  into a block, and read through a fail-closed reader that folds `kv` errors, empty strings
  and non-strings to `undefined`.
- Outbound egress is **not ambient**. The plugin's only egress is `ctx.http.fetch`, gated by
  the descriptor's `allowedHosts` allowlist, which is resolved at **build** time — a Settings
  edit cannot widen the perimeter, only a rebuild can.
- The domain stays IO-free (`domain-is-io-free`, enforced on every commit), so the packages
  that hold the rules cannot be the ones that exfiltrate a secret.

**One honest caveat.** `packages/payments-stripe` defaults its transport to `globalThis.fetch`
rather than `ctx.http.fetch`, unlike the email sender and the x402 facilitator client, which
both route through the gated egress explicitly. No current call site constructs the Stripe
gateway with a live transport, so this is latent rather than exploited — but whoever wires the
Stripe gateway into the in-process composition must pass `ctx.http.fetch`, or the allowlist
bound above does not apply to Stripe.

### 3. The settle route is public, and the site-owned webhook endpoint is permanent

**The requirement, as actually built and enforced.** Earlier planning called for a
**non-public** settle route, on the reasoning that a public one is reachable directly at the
host's catch-all and so bypasses the endpoint's own verification. That plan is **wrong on this
stack, and is superseded by what shipped.** A webhook is always unauthenticated, the host
binds its *private* plugin-route dispatcher only on the authenticated path, and an anonymous
request therefore only ever reaches `handlePublicPluginApiRoute`. A non-public settle route
cannot receive a webhook at all.

So the route is registered **`public: true`** (`packages/plugin/src/plugin.ts`), and the trust
anchor moved in with it:

- **The Stripe HMAC is the anchor.** The plugin route performs a real signature verification
  over the exact delivered bytes against `settings:stripeWebhookSecret`, unconditionally, and
  no token or setting can switch it off. The bytes are base64-passed and never parsed, because
  a `JSON.parse`/`stringify` round-trip is a different byte string and would fail verification
  for every genuine delivery.
- **An edge token is the cheap outer gate in front of it.** `OTTA_WH_TOKEN` (a Worker secret
  on the site, mirrored into plugin `kv`) lets the public route refuse an *unattributed*
  request before it reads another key, builds a gateway or opens a store. It **passes through
  when unset** — an unprovisioned deploy degrades to "cryptographic anchor only", never to
  "nothing is checked".

The requirement this record fixes is therefore: **the settle route is public and must stay
public; its defence is the unconditional HMAC, with the edge token as a pre-filter.** A future
change that makes it non-public is a change that stops webhooks working.

**Gap, named rather than implied.** The admin route's `public: false` is pinned by an
assertion; the settle route's `public: true` is currently **not** pinned by any test, lint
rule or CI check — it is a manifest literal plus commentary. Pinning it is owed.

**The endpoint is permanent.** Stripe delivers to `POST /webhooks/stripe` on the **site**
(`sites/staging/src/pages/webhooks/stripe.ts`), a transport shim that holds no secret and
verifies no signature; it exists only because the host's route framework JSON-parses a
route's body before any handler runs and exposes no raw-body read. There is no future in
which this endpoint moves back to a separate service: the URL is the operator's, on the
operator's domain, and a registered webhook URL is the kind of thing that must not move.

### 4. A future service is re-derived, never resurrected

If a service is ever needed — a non-EmDash storefront, a genuinely independent scaling need,
a customer who requires the isolation §2 gave up — it is **built new from `@otta-sh/domain`,
whose ports are unchanged by this record.** It is not restored from deleted code, and no
service is kept on standby, behind a flag, or in a branch.

This is exactly the payoff ADR-0002 designed for, claimed once rather than twice: the seams
are what make deletion cheap *and* what would make re-derivation cheap. Deleted code that has
to be rebased over a year of domain changes is a liability; a port that never moved is an
asset. The contract suites are the acceptance test for either direction — a new transport
adapter is done when the existing suite passes against it, the same rule that admitted the
in-process client.

## Consequences

- **One deployable, one database, one secrets story.** No service URL, no service token, no
  second migration set, no wire format to keep in sync with the ports. The deployment guide
  describes one shape.
- **A wire format stops being a public contract.** The REST API was a 1:1 serialization of the
  ports, and keeping it honest was real work. That work is gone — and so is the drift test
  that guarded it, which is a small loss of evidence, not of correctness: the ports themselves
  are still pinned by the contract suites.
- **The blast radius of the plugin process grew** (§2). This is the cost of the decision and
  it is accepted knowingly, on the grounds that the project is pre-launch with no users and no
  live credentials in production. It is not a cost that gets cheaper with scale.
- **Rollback is "revert the merge", not "switch modes".** There is no second mode. Nothing in
  the tree can be flipped back to HTTP, and the deployment guide carries no asymmetric-rollback
  caveat because there is nothing asymmetric left to roll back.
- **D1 is the storage floor** (reason 5). Its contention behaviour is a measured budget in
  ADR-0019, and a workload that exceeds it reopens the *adapter* choice, not the boundary.

**What would reopen this decision.** A real non-EmDash consumer; a measured contention or
volume figure that no document-model change brings back inside ADR-0019's budget; or a
compliance requirement that genuinely needs the process isolation §2 gave up. In every case
the answer is a new adapter over the unchanged ports — and in every case the evidence comes
first.
